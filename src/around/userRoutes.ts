import type { Express, Response } from "express";
import { Types, isValidObjectId } from "mongoose";
import { z } from "zod";
import { config } from "../config.js";
import type { AuthedRequest } from "../types.js";
import { deviceRateLimit, locationRateLimit, oauthRateLimit, reportRateLimit } from "./aroundRateLimit.js";
import { purgeEmailVerifications, registerEmailAuthRoutes } from "./emailAuth.js";
import { authTokenFor, isDuplicateKeyError, pseudoRefusal } from "./identity.js";
import { geoPoint } from "./models.js";
import {
  AroundBlockModel,
  AroundDeviceModel,
  AroundMemberModel,
  AroundModel,
  AroundReportModel,
  AroundReservedPseudoModel,
  AroundRingModel,
  AroundUserModel,
  DevicePresenceModel,
  LOCALES,
  ModerationActionModel,
  PRESENCE_SOURCES,
  PushReceiptModel,
  REPORT_REASONS,
  type AroundDevice,
  type AroundUser
} from "./models.js";
import { invalidateUserCache, requireUser, wrap, type AroundRequest } from "./middleware.js";
import { createReport, sendReportAlertEmail } from "./moderation.js";
import { ringOnPresence } from "./push.js";
import { wakeRegionsNear, type WakeRegion } from "./rings.js";
import { runDetached } from "./serverless.js";
import {
  OAuthVerificationError,
  exchangeAppleAuthorizationCode,
  revokeAppleToken,
  verifyAppleIdentityToken,
  verifyGoogleIdToken
} from "./oauth.js";
import { purgeUserPhotos } from "./purge.js";
import { userResponse } from "./serializers.js";

const oauthSchema = z.object({
  provider: z.enum(["apple", "google"]),
  identityToken: z.string().min(10),
  // Apple authorization code: exchanged server-side for a refresh_token, the
  // credential needed to revoke the grant at account deletion (5.1.1(v)).
  authorizationCode: z.string().trim().min(10).max(512).optional(),
  pseudo: z.string().trim().optional(),
  termsVersion: z.string().trim().max(40).optional()
});

const patchMeSchema = z.object({
  pseudo: z.string().trim().optional(),
  // The interface language lives on the account, not on the device: it is
  // picked at sign-up and follows the user from one install to the next.
  locale: z.enum(LOCALES).optional()
}).refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field to update." });

const deviceSchema = z.object({
  installationId: z.string().trim().min(6).max(128),
  expoPushToken: z.string().trim().min(10).max(256).optional(),
  pushEnabled: z.boolean().optional(),
  platform: z.string().trim().max(40).optional(),
  appVersion: z.string().trim().max(40).optional(),
  osVersion: z.string().trim().max(40).optional()
});

const radarSchema = z.object({
  enabled: z.boolean()
});

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000),
  // Bounded honesty: iOS delivers background batches late, and stamping them
  // at receipt inflated the fan-out freshness window. Out-of-bounds, absent
  // OR unparseable falls back to receipt time — never a rejection: a skewed
  // or garbled clock must not make a phone invisible.
  capturedAt: z.coerce.date().optional().catch(undefined),
  // "significant-change" was never sent by any shipped client (the schema
  // default stamped every row "foreground"): retired from the wire. The v1.1
  // sources (heartbeat, probe, geofence) are the wake paths, see models.ts.
  source: z.enum(PRESENCE_SOURCES).optional(),
  installationId: z.string().trim().min(6).max(128).optional(),
  // Set by the app when the post answers a silent presence probe.
  probeAroundId: z.string().trim().max(64).optional()
});

const reportSchema = z.object({
  reason: z.enum(REPORT_REASONS),
  comment: z.string().trim().max(500).optional()
});

// Best-effort capture of the Apple refresh token needed at deletion time.
// A failed exchange must never break the login: we simply keep nothing.
async function appleRefreshTokenFrom(provider: "apple" | "google", authorizationCode?: string) {
  if (provider !== "apple" || !authorizationCode) return null;
  try {
    return await exchangeAppleAuthorizationCode(authorizationCode);
  } catch (error) {
    console.error("[around:apple] authorization code exchange failed", error);
    return null;
  }
}

export function registerAroundUserRoutes(app: Express) {
  // POST /api/users/email/{register,verify,resend,login} — e-mail sign-up.
  // Coexists with Sign in with Apple below; see around/emailAuth.ts.
  registerEmailAuthRoutes(app);

  // POST /api/users/oauth — unified Apple/Google sign-in.
  // Lookup by (provider, sub) ONLY; an e-mail collision is refused with 409
  // EMAIL_ALREADY_LINKED (never silently linked); otherwise 2-call signup flow
  // (PSEUDO_REQUIRED / PSEUDO_TAKEN, the client resends the same identityToken
  // with a pseudo).
  app.post("/api/users/oauth", oauthRateLimit, wrap(async (req: AuthedRequest, res: Response) => {
    const parsed = oauthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });

    let identity;
    try {
      identity = parsed.data.provider === "apple"
        ? await verifyAppleIdentityToken(parsed.data.identityToken)
        : await verifyGoogleIdToken(parsed.data.identityToken);
    } catch (error) {
      if (error instanceof OAuthVerificationError) {
        return res.status(error.status).json({ error: error.code });
      }
      throw error;
    }

    const subField = parsed.data.provider === "apple" ? "appleSub" : "googleSub";
    const user = await AroundUserModel.findOne({ [subField]: identity.sub }).lean<AroundUser>();

    if (!user && identity.email) {
      // A "verified" e-mail only attests that the provider account controls
      // that mailbox NOW, not that it is the same person: an expired domain or
      // a Workspace admin would be enough to take the account over. We refuse
      // instead of attaching the new provider sub. Cross-provider linking, if
      // ever needed, must happen under an already authenticated session.
      const clash = await AroundUserModel.exists({ email: identity.email });
      if (clash) return res.status(409).json({ error: "EMAIL_ALREADY_LINKED" });
    }

    if (user) {
      if (user.status === "banned") return res.status(403).json({ error: "USER_BANNED" });
      const refreshToken = await appleRefreshTokenFrom(parsed.data.provider, parsed.data.authorizationCode);
      await AroundUserModel.updateOne(
        { _id: user._id },
        { $set: { lastSeenAt: new Date(), ...(refreshToken ? { appleRefreshToken: refreshToken } : {}) } }
      );
      return res.json({ token: authTokenFor(user), user: userResponse(user), created: false });
    }

    const pseudo = parsed.data.pseudo?.trim() ?? "";
    if (!pseudo) return res.status(409).json({ error: "PSEUDO_REQUIRED" });
    const refusal = pseudoRefusal(pseudo);
    if (refusal) return res.status(400).json(refusal);

    const pseudoLower = pseudo.toLowerCase();

    try {
      const now = new Date();
      const created = await AroundUserModel.create({
        [subField]: identity.sub,
        pseudo,
        pseudoLower,
        email: identity.email,
        radarEnabled: false,
        status: "active",
        termsAcceptedAt: now,
        termsVersion: parsed.data.termsVersion ?? "2026-08",
        createdAt: now,
        lastSeenAt: now
      });
      // Exchange AFTER the create: the Apple authorization code is single-use,
      // and burning it on an attempt that dies on PSEUDO_TAKEN would leave the
      // retry (new pseudo, same code) with nothing to exchange. Best effort —
      // a failure here must never undo a signup that already succeeded; the
      // next successful sign-in captures a fresh token.
      try {
        const refreshToken = await appleRefreshTokenFrom(parsed.data.provider, parsed.data.authorizationCode);
        if (refreshToken) {
          await AroundUserModel.updateOne({ _id: created._id }, { $set: { appleRefreshToken: refreshToken } });
        }
      } catch (error) {
        console.error("[around:oauth] post-create apple token exchange failed", error);
      }
      const createdUser = created.toObject() as AroundUser;
      return res.status(201).json({ token: authTokenFor(createdUser), user: userResponse(createdUser), created: true });
    } catch (error) {
      // Stale unique pseudoLower index (pre-migration) or a sub/email race:
      // either way the caller can retry once the dust settles.
      if (isDuplicateKeyError(error)) return res.status(409).json({ error: "PSEUDO_TAKEN" });
      throw error;
    }
  }));

  app.get("/api/users/me", requireUser, (req: AroundRequest, res: Response) => {
    return res.json({ user: userResponse(req.user as AroundUser) });
  });

  app.patch("/api/users/me", requireUser, wrap(async (req: AroundRequest, res: Response) => {
    const parsed = patchMeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    const user = req.user as AroundUser;

    if (parsed.data.pseudo !== undefined) {
      const pseudo = parsed.data.pseudo.trim();
      const refusal = pseudoRefusal(pseudo);
      if (refusal) return res.status(400).json(refusal);
      const pseudoLower = pseudo.toLowerCase();
      try {
        await AroundUserModel.updateOne({ _id: user._id }, { $set: { pseudo, pseudoLower } });
      } catch (error) {
        if (isDuplicateKeyError(error)) return res.status(409).json({ error: "PSEUDO_TAKEN" });
        throw error;
      }
      invalidateUserCache(String(user._id));
    }

    if (parsed.data.locale !== undefined) {
      await AroundUserModel.updateOne({ _id: user._id }, { $set: { locale: parsed.data.locale } });
      invalidateUserCache(String(user._id));
    }

    const updated = await AroundUserModel.findById(user._id).lean<AroundUser>();
    if (!updated) return res.status(401).json({ error: "INVALID_TOKEN" });
    return res.json({ user: userResponse(updated) });
  }));

  // Device registration (upsert by installationId) + push token migration:
  // a token can only belong to one device row at a time.
  app.put("/api/users/me/devices", requireUser, deviceRateLimit, wrap(async (req: AroundRequest, res: Response) => {
    const parsed = deviceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    const user = req.user as AroundUser;
    const data = parsed.data;

    if (data.expoPushToken) {
      // Proof of possession. The route used to hand the token to whoever asked
      // for it, unbinding it from every other row first: submitting someone
      // else's expoPushToken silently redirected THEIR notifications to the
      // attacker's account (and the notification title is attacker-controlled
      // UGC). An Expo token belongs to an app installation, so exactly two
      // migrations are legitimate — same user reinstalling (new installationId)
      // and same device switching account (same installationId). A token that
      // is neither is refused, and the current holder keeps it.
      const holders = await AroundDeviceModel.find({ expoPushToken: data.expoPushToken }).lean<AroundDevice[]>();
      const stolen = holders.some(
        (holder) => String(holder.userId) !== String(user._id) && holder.installationId !== data.installationId
      );
      if (stolen) {
        console.warn(
          `[security] push token claim refused: user=${String(user._id)} installation=${data.installationId} ` +
          "tried to claim a token bound to another user/installation"
        );
        return res.status(409).json({ error: "PUSH_TOKEN_CONFLICT" });
      }
      await AroundDeviceModel.updateMany(
        { expoPushToken: data.expoPushToken, $or: [{ userId: { $ne: user._id } }, { installationId: { $ne: data.installationId } }] },
        { $unset: { expoPushToken: "" }, $set: { invalidatedAt: new Date() } }
      );
    }

    const update: Record<string, unknown> = {
      pushEnabled: data.pushEnabled ?? true,
      platform: data.platform ?? null,
      appVersion: data.appVersion ?? null,
      osVersion: data.osVersion ?? null,
      lastActiveAt: new Date(),
      invalidatedAt: null
    };
    if (data.expoPushToken) update.expoPushToken = data.expoPushToken;

    // An absent token is "no change", never a revocation: registration runs
    // on every launch, and a transient Expo push-service failure registers
    // without a token — unsetting there wiped a valid binding and silently
    // dropped the user from every fan-out until a later launch happened to
    // succeed. pushEnabled:false already mutes push delivery on its own.
    const device = await AroundDeviceModel.findOneAndUpdate(
      { userId: user._id, installationId: data.installationId },
      {
        $set: update,
        $setOnInsert: { userId: user._id, installationId: data.installationId }
      },
      { upsert: true, returnDocument: "after" }
    ).lean();

    return res.json({
      device: {
        installationId: device?.installationId,
        pushEnabled: device?.pushEnabled ?? true,
        hasPushToken: Boolean(device?.expoPushToken)
      }
    });
  }));

  const deleteDevice = async (req: AroundRequest, res: Response, installationId: string | undefined) => {
    if (!installationId) return res.status(400).json({ error: "INVALID_INPUT" });
    const user = req.user as AroundUser;
    await AroundDeviceModel.deleteOne({ userId: user._id, installationId });
    return res.json({ ok: true });
  };

  app.delete("/api/users/me/devices/:installationId", requireUser, wrap(async (req: AroundRequest, res: Response) => {
    return deleteDevice(req, res, req.params.installationId);
  }));

  app.delete("/api/users/me/devices", requireUser, wrap(async (req: AroundRequest, res: Response) => {
    const installationId = typeof req.body?.installationId === "string" ? req.body.installationId : undefined;
    return deleteDevice(req, res, installationId);
  }));

  // Radar opt-in toggle. Turning it off deletes the stored presence
  // immediately (no position is kept for a non-consenting user).
  app.put("/api/users/me/radar", requireUser, wrap(async (req: AroundRequest, res: Response) => {
    const parsed = radarSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    const user = req.user as AroundUser;

    if (parsed.data.enabled) {
      await AroundUserModel.updateOne(
        { _id: user._id },
        { $set: { radarEnabled: true, ...(user.radarConsentAt ? {} : { radarConsentAt: new Date() }) } }
      );
    } else {
      await AroundUserModel.updateOne({ _id: user._id }, { $set: { radarEnabled: false } });
      await DevicePresenceModel.deleteOne({ userId: user._id });
    }
    invalidateUserCache(String(user._id));

    const updated = await AroundUserModel.findById(user._id).lean<AroundUser>();
    if (!updated) return res.status(401).json({ error: "INVALID_TOKEN" });
    return res.json({ user: userResponse(updated) });
  }));

  // Presence update (Radar). One doc per user, position OVERWRITTEN — never a
  // history. 403 when Radar is off.
  app.post("/api/users/me/location", requireUser, locationRateLimit, wrap(async (req: AroundRequest, res: Response) => {
    const parsed = locationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    const user = req.user as AroundUser;

    // Consent gated on the DB, not on the 60 s per-instance cache: on the
    // serverless deployment another warm lambda can hold the pre-toggle
    // snapshot in either direction — refusing posts for a minute right after
    // enabling, or re-creating a presence the opt-out just deleted.
    const now = new Date();
    const consent = await AroundUserModel.updateOne(
      { _id: user._id, radarEnabled: true },
      { $set: { lastSeenAt: now } }
    );
    if (consent.matchedCount !== 1) {
      // Mop up a presence a concurrent post may have re-created: no position
      // is kept for a non-consenting user.
      await DevicePresenceModel.deleteOne({ userId: user._id });
      return res.status(403).json({ error: "RADAR_DISABLED" });
    }

    const claimed = parsed.data.capturedAt;
    const capturedAt =
      claimed &&
      claimed.getTime() <= now.getTime() + 30_000 &&
      claimed.getTime() >= now.getTime() - config.presenceFreshMs
        ? claimed
        : now;

    const source = parsed.data.source ?? "foreground";
    try {
      await DevicePresenceModel.updateOne(
        { userId: user._id },
        {
          $set: {
            location: geoPoint(parsed.data.lat, parsed.data.lng),
            accuracy: parsed.data.accuracy,
            capturedAt,
            updatedAt: now,
            source,
            installationId: parsed.data.installationId ?? null
          },
          $setOnInsert: { userId: user._id }
        },
        { upsert: true }
      );
    } catch (error) {
      // Two first-ever posts racing on two lambdas (the task and the Home
      // piggyback right after enabling): the loser's upsert collides with the
      // unique userId index. The document exists now — a plain update wins.
      if (!isDuplicateKeyError(error)) throw error;
      await DevicePresenceModel.updateOne(
        { userId: user._id },
        {
          $set: {
            location: geoPoint(parsed.data.lat, parsed.data.lng),
            accuracy: parsed.data.accuracy,
            capturedAt,
            updatedAt: now,
            source,
            installationId: parsed.data.installationId ?? null
          }
        }
      );
    }
    // Write-then-verify: a radar-off that committed between the consent gate
    // above and this upsert deleted a presence we just re-created. Both
    // orders of the interleaving end with no stored position.
    const stillConsenting = await AroundUserModel.exists({ _id: user._id, radarEnabled: true });
    if (!stillConsenting) {
      await DevicePresenceModel.deleteOne({ userId: user._id });
      return res.status(403).json({ error: "RADAR_DISABLED" });
    }

    // The arrival ring rides behind the response (waitUntil on Vercel): the
    // POST answers in one round trip, the push — if any — follows.
    runDetached(
      ringOnPresence({
        userId: user._id,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        accuracy: parsed.data.accuracy,
        source,
        probeAroundId: parsed.data.probeAroundId ?? null
      }).catch((error) => {
        console.error("[around:ring] arrival ring failed", error);
      })
    );
    // Wake regions: the open arounds around the phone, so it can arm iOS
    // region monitoring (a region entry relaunches even a force-quit app).
    let wakeRegions: WakeRegion[] = [];
    try {
      wakeRegions = await wakeRegionsNear(parsed.data.lat, parsed.data.lng, now);
    } catch (error) {
      console.error("[around:ring] wake regions failed", error);
    }
    return res.json({ ok: true, wakeRegions });
  }));

  // Account deletion (App Store 5.1.1(v)) — full cascade: photos (Cloudinary
  // first), devices, presence, blocks; memberships anonymised (audit
  // stripped); owned arounds closed. The Sign in with Apple grant is revoked
  // BEFORE the document is removed (that is where the refresh token lives).
  app.delete("/api/users/me", requireUser, wrap(async (req: AroundRequest, res: Response) => {
    const user = req.user as AroundUser;
    const userId = user._id;
    const now = new Date();

    if (user.appleSub) {
      // Never let an Apple-side failure block the deletion: the GDPR erasure
      // obligation wins, the failure is logged for manual reprocessing.
      try {
        // req.user comes from the cached .lean() read, which excludes the
        // select:false field — reload it explicitly.
        const withSecret = await AroundUserModel
          .findById(userId)
          .select("+appleRefreshToken")
          .lean<AroundUser>();
        if (withSecret?.appleRefreshToken) {
          await revokeAppleToken(withSecret.appleRefreshToken, "refresh_token");
        } else {
          console.warn(
            `[around:account] no Apple refresh token stored for user ${String(userId)}: the Sign in with Apple grant could NOT be revoked (App Store 5.1.1(v)). Deletion continues.`
          );
        }
      } catch (error) {
        console.error("[around:account] apple token revoke failed", error);
      }
    }

    await purgeUserPhotos(userId);

    const activeMemberships = await AroundMemberModel.find({ userId, status: "active" }).lean();
    for (const membership of activeMemberships) {
      await AroundModel.updateOne({ _id: membership.aroundId }, { $inc: { memberCount: -1 } });
    }
    await AroundMemberModel.updateMany(
      { userId },
      { $set: { status: "left", joinFixes: [], anonymizedAt: now } }
    );

    await AroundModel.updateMany(
      { ownerId: userId, status: "active" },
      { $set: { status: "closed", captureEndsAt: now } }
    );
    // Erasure: the centre of every around this account created IS its owner's
    // exact position, and the name is their text. Closing is not enough — the
    // J+7 purge would only reach them at expiry, and closed docs would keep
    // both for ever. (The docs above just went from active to closed, so they
    // are covered by this sweep.)
    await AroundModel.updateMany(
      { ownerId: userId, status: { $in: ["active", "closed", "purging"] } },
      { $unset: { center: "" }, $set: { name: null } }
    );

    await AroundDeviceModel.deleteMany({ userId });
    await DevicePresenceModel.deleteOne({ userId });
    // Ring claims carry this user's id for 8 days (the TTL) or until the
    // around is purged, whichever comes first — neither of which is "now".
    // An erasure that leaves the id behind is not an erasure, and the only
    // thing the row buys after the account is gone is silence on a person who
    // no longer exists.
    await AroundRingModel.deleteMany({ userId });
    // Same reasoning: a receipt row is a push token plus this user's id, kept
    // 7 days by its own TTL. Nothing is left to deliver to a deleted account,
    // so nothing needs to be remembered about it.
    await PushReceiptModel.deleteMany({ userId });
    await AroundBlockModel.deleteMany({ $or: [{ blockerId: userId }, { blockedId: userId }] });
    // A pending verification code outlives nothing: it carries the (lowercased)
    // address of a deleted account and, if the address were re-registered
    // before the TTL swept it, /verify would still match the old document and
    // hand a token for a user that no longer exists.
    await purgeEmailVerifications(userId, user.email);

    // Erasure (GDPR art. 17 / nLPD). Reports filed by or against the account
    // carried its ObjectId and a free-text comment for ever: `aroundId` is null
    // on user reports, so the per-around purge (purge.ts) never matched them.
    // They have no moderation value once the account is gone — a re-signup gets
    // a brand new _id and there is no appleSub left to correlate on.
    await AroundReportModel.deleteMany({
      $or: [
        { reporterId: userId },
        { targetType: "user", targetId: userId }
      ]
    });
    // The admin journal is kept (it is the evidence that a moderation decision
    // was taken and when) but is unlinked from the deleted account.
    await ModerationActionModel.updateMany(
      { targetType: "user", targetId: userId },
      { $set: { targetId: null } }
    );

    // Identity squatting: the pseudo is the ONLY name other members see, and
    // deleting the user document freed the unique index instantly. Tombstone
    // the pseudo for a cooling period (TTL-expired by MongoDB) so nobody can
    // re-register it and be mistaken for the person who just left. Chosen over
    // a soft-deleted user document because it keeps the erasure real: only the
    // lowercased pseudo survives, with no link to the account.
    await AroundReservedPseudoModel.updateOne(
      { pseudoLower: user.pseudoLower },
      { $set: { pseudoLower: user.pseudoLower, releasedAt: new Date() } },
      { upsert: true }
    );

    await AroundUserModel.deleteOne({ _id: userId });
    invalidateUserCache(String(userId));

    return res.json({ ok: true });
  }));

  // Report a user (UGC compliance).
  app.post("/api/users/:id/report", requireUser, reportRateLimit, wrap(async (req: AroundRequest, res: Response) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "USER_NOT_FOUND" });
    const user = req.user as AroundUser;
    const targetId = new Types.ObjectId(req.params.id);
    if (targetId.equals(user._id)) return res.status(400).json({ error: "CANNOT_REPORT_SELF" });

    const target = await AroundUserModel.findById(targetId).lean<AroundUser>();
    if (!target) return res.status(404).json({ error: "USER_NOT_FOUND" });

    const { report, created } = await createReport({
      targetType: "user",
      targetId,
      reporterId: user._id,
      reason: parsed.data.reason,
      comment: parsed.data.comment ?? null
    });
    if (created) {
      void sendReportAlertEmail(report, user.pseudo).catch((error) => {
        console.error("[around:moderation] report alert email failed", error);
      });
    }
    return res.json({ ok: true });
  }));

  // Block / unblock a user. The bilateral filter is applied server-side in
  // the feed and member serialisation paths.
  app.post("/api/users/:id/block", requireUser, wrap(async (req: AroundRequest, res: Response) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "USER_NOT_FOUND" });
    const user = req.user as AroundUser;
    const blockedId = new Types.ObjectId(req.params.id);
    if (blockedId.equals(user._id)) return res.status(400).json({ error: "CANNOT_BLOCK_SELF" });

    const target = await AroundUserModel.findById(blockedId).lean<AroundUser>();
    if (!target) return res.status(404).json({ error: "USER_NOT_FOUND" });

    try {
      await AroundBlockModel.create({ blockerId: user._id, blockedId, createdAt: new Date() });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
    return res.json({ ok: true });
  }));

  app.delete("/api/users/:id/block", requireUser, wrap(async (req: AroundRequest, res: Response) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "USER_NOT_FOUND" });
    const user = req.user as AroundUser;
    await AroundBlockModel.deleteOne({ blockerId: user._id, blockedId: new Types.ObjectId(req.params.id) });
    return res.json({ ok: true });
  }));
}
