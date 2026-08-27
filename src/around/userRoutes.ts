import type { Express, Response } from "express";
import { Types, isValidObjectId } from "mongoose";
import { z } from "zod";
import { signAuth } from "../auth.js";
import { config } from "../config.js";
import type { AuthedRequest } from "../types.js";
import { locationRateLimit, oauthRateLimit, reportRateLimit } from "./aroundRateLimit.js";
import { geoPoint } from "./models.js";
import {
  AroundBlockModel,
  AroundDeviceModel,
  AroundMemberModel,
  AroundModel,
  AroundUserModel,
  DevicePresenceModel,
  REPORT_REASONS,
  type AroundUser
} from "./models.js";
import { invalidateUserCache, requireUser, wrap, type AroundRequest } from "./middleware.js";
import { createReport, sendReportAlertEmail } from "./moderation.js";
import { OAuthVerificationError, verifyAppleIdentityToken, verifyGoogleIdToken } from "./oauth.js";
import { purgeUserPhotos } from "./purge.js";
import { userResponse } from "./serializers.js";

const PSEUDO_PATTERN = /^[a-zA-Z0-9._-]{3,24}$/;

const oauthSchema = z.object({
  provider: z.enum(["apple", "google"]),
  identityToken: z.string().min(10),
  pseudo: z.string().trim().optional(),
  termsVersion: z.string().trim().max(40).optional()
});

const patchMeSchema = z.object({
  pseudo: z.string().trim().optional()
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
  source: z.enum(["significant-change", "foreground"]).optional()
});

const reportSchema = z.object({
  reason: z.enum(REPORT_REASONS),
  comment: z.string().trim().max(500).optional()
});

function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

function authTokenFor(user: AroundUser) {
  return signAuth({ role: "user", userId: String(user._id) });
}

async function attachProviderSub(user: AroundUser, provider: "apple" | "google", sub: string, email: string | null) {
  const update: Record<string, unknown> = { lastSeenAt: new Date() };
  if (provider === "apple" && !user.appleSub) update.appleSub = sub;
  if (provider === "google" && !user.googleSub) update.googleSub = sub;
  if (email && !user.email) update.email = email;
  await AroundUserModel.updateOne({ _id: user._id }, { $set: update });
  invalidateUserCache(String(user._id));
}

export function registerAroundUserRoutes(app: Express) {
  // POST /api/users/oauth — unified Apple/Google sign-in.
  // Lookup by (provider, sub); otherwise attach to an existing account via
  // VERIFIED email; otherwise 2-call signup flow (PSEUDO_REQUIRED /
  // PSEUDO_TAKEN, the client resends the same identityToken with a pseudo).
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
    let user = await AroundUserModel.findOne({ [subField]: identity.sub }).lean<AroundUser>();

    if (!user && identity.email) {
      // Attach the new provider to an existing account matched by verified
      // email instead of creating a duplicate.
      user = await AroundUserModel.findOne({ email: identity.email }).lean<AroundUser>();
      if (user) {
        await attachProviderSub(user, parsed.data.provider, identity.sub, identity.email);
        user = await AroundUserModel.findById(user._id).lean<AroundUser>();
      }
    }

    if (user) {
      if (user.status === "banned") return res.status(403).json({ error: "USER_BANNED" });
      await AroundUserModel.updateOne({ _id: user._id }, { $set: { lastSeenAt: new Date() } });
      return res.json({ token: authTokenFor(user), user: userResponse(user), created: false });
    }

    const pseudo = parsed.data.pseudo?.trim() ?? "";
    if (!pseudo) return res.status(409).json({ error: "PSEUDO_REQUIRED" });
    if (!PSEUDO_PATTERN.test(pseudo)) return res.status(400).json({ error: "INVALID_PSEUDO" });

    const pseudoLower = pseudo.toLowerCase();
    const taken = await AroundUserModel.exists({ pseudoLower });
    if (taken) return res.status(409).json({ error: "PSEUDO_TAKEN" });

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
      const createdUser = created.toObject() as AroundUser;
      return res.status(201).json({ token: authTokenFor(createdUser), user: userResponse(createdUser), created: true });
    } catch (error) {
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
      if (!PSEUDO_PATTERN.test(pseudo)) return res.status(400).json({ error: "INVALID_PSEUDO" });
      const pseudoLower = pseudo.toLowerCase();
      const taken = await AroundUserModel.exists({ pseudoLower, _id: { $ne: user._id } });
      if (taken) return res.status(409).json({ error: "PSEUDO_TAKEN" });
      try {
        await AroundUserModel.updateOne({ _id: user._id }, { $set: { pseudo, pseudoLower } });
      } catch (error) {
        if (isDuplicateKeyError(error)) return res.status(409).json({ error: "PSEUDO_TAKEN" });
        throw error;
      }
      invalidateUserCache(String(user._id));
    }

    const updated = await AroundUserModel.findById(user._id).lean<AroundUser>();
    if (!updated) return res.status(401).json({ error: "INVALID_TOKEN" });
    return res.json({ user: userResponse(updated) });
  }));

  // Device registration (upsert by installationId) + push token migration:
  // a token can only belong to one device row at a time.
  app.put("/api/users/me/devices", requireUser, wrap(async (req: AroundRequest, res: Response) => {
    const parsed = deviceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    const user = req.user as AroundUser;
    const data = parsed.data;

    if (data.expoPushToken) {
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

    const device = await AroundDeviceModel.findOneAndUpdate(
      { userId: user._id, installationId: data.installationId },
      {
        $set: update,
        ...(data.expoPushToken ? {} : { $unset: { expoPushToken: "" } }),
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
    if (!user.radarEnabled) return res.status(403).json({ error: "RADAR_DISABLED" });

    const now = new Date();
    await DevicePresenceModel.updateOne(
      { userId: user._id },
      {
        $set: {
          location: geoPoint(parsed.data.lat, parsed.data.lng),
          accuracy: parsed.data.accuracy,
          capturedAt: now,
          updatedAt: now,
          source: parsed.data.source ?? "foreground"
        },
        $setOnInsert: { userId: user._id }
      },
      { upsert: true }
    );
    await AroundUserModel.updateOne({ _id: user._id }, { $set: { lastSeenAt: now } });
    return res.json({ ok: true });
  }));

  // Account deletion (App Store 5.1.1(v)) — full cascade: photos (Cloudinary
  // first), devices, presence, blocks; memberships anonymised (audit
  // stripped); owned arounds closed.
  app.delete("/api/users/me", requireUser, wrap(async (req: AroundRequest, res: Response) => {
    const user = req.user as AroundUser;
    const userId = user._id;
    const now = new Date();

    await purgeUserPhotos(userId);

    const activeMemberships = await AroundMemberModel.find({ userId, status: "active" }).lean();
    for (const membership of activeMemberships) {
      await AroundModel.updateOne({ _id: membership.aroundId }, { $inc: { memberCount: -1 } });
    }
    await AroundMemberModel.updateMany(
      { userId },
      { $set: { status: "left", joinFixes: [], joinIp: null, joinGeo: null, anonymizedAt: now } }
    );

    await AroundModel.updateMany(
      { ownerId: userId, status: "active" },
      { $set: { status: "closed", captureEndsAt: now } }
    );

    await AroundDeviceModel.deleteMany({ userId });
    await DevicePresenceModel.deleteOne({ userId });
    await AroundBlockModel.deleteMany({ $or: [{ blockerId: userId }, { blockedId: userId }] });
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
