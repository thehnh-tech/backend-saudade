import type { Express, NextFunction, Response } from "express";
import { Types, isValidObjectId } from "mongoose";
import { z } from "zod";
import { config } from "../config.js";
import { createAroundRateLimit, joinRateLimit, nearbyRateLimit, reportRateLimit } from "./aroundRateLimit.js";
import {
  GEO_IP_MAX_DISTANCE_KM,
  clientIpOf,
  displayCenterOffset,
  geoIpConsistency,
  haversineMeters,
  joinToleranceM,
  offsetPoint,
  verifyJoinFixes,
  type JoinFixInput
} from "./geoUtils.js";
import { requireUser, wrap, type AroundRequest } from "./middleware.js";
import { bilateralBlockSet, createReport, sendReportAlertEmail } from "./moderation.js";
import {
  AROUND_MAX_RADIUS_M,
  AROUND_MIN_RADIUS_M,
  AroundMemberModel,
  AroundModel,
  AroundUserModel,
  REPORT_REASONS,
  geoPoint,
  type Around,
  type AroundMember,
  type AroundUser,
  type GeoPoint
} from "./models.js";
import { fanOutAroundCreated } from "./push.js";
import { runDetached } from "./serverless.js";
import { aroundResponse, memberResponse } from "./serializers.js";
import { checkUserText } from "./textFilter.js";

const MAX_ACTIVE_AROUNDS_PER_OWNER = 2;

// Distance granularity served to NON-members in /nearby. An exact distance
// from a point chosen by the caller is a circle constraint: three of them
// reconstruct the center to the meter. 50 m is enough to render a card.
const NEARBY_DISTANCE_BUCKET_M = 50;

// One warn per user per window: the 30 s Home poll would otherwise turn a
// single VPN session into a log torrent. Per warm lambda only — this is
// noise control, not a security control.
const GEO_DEGRADED_LOG_WINDOW_MS = 10 * 60 * 1000;
const geoDegradedLoggedAt = new Map<string, number>();

function warnGeoDegraded(userId: string, ip: string | null, distanceKm: number) {
  const now = Date.now();
  if (now - (geoDegradedLoggedAt.get(userId) ?? 0) < GEO_DEGRADED_LOG_WINDOW_MS) return;
  geoDegradedLoggedAt.set(userId, now);
  console.warn(
    `[around:geo-degraded] nearby served despite GeoIP mismatch user=${userId} ip=${ip ?? "unknown"} distanceKm=${Math.round(distanceKm)}`
  );
}

// Bucketing alone is invertible: ceil flips exactly on true multiples of
// 50 m, so three probed flip points reconstruct the centre to the metre.
// Non-members therefore get their distance measured from a per-around
// DISPLAY centre (displayCenterOffset in geoUtils.ts, 5–15 m, deterministic):
// probing converges on that decoy, never on the owner's position. Members
// keep the exact distance, and every eligibility computation keeps the true
// centre.

// Must stay in sync with DEMO_PSEUDO in seedReviewAround.ts.
const REVIEW_DEMO_OWNER_PSEUDO = "pma-demo";

const createAroundSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000),
  radiusM: z.number().min(AROUND_MIN_RADIUS_M).max(AROUND_MAX_RADIUS_M),
  durationH: z.number().positive().max(48).optional()
});

const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(100000).optional()
});

const fixSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000),
  capturedAt: z.coerce.date()
});

const joinSchema = z.object({
  fixes: z.array(fixSchema).length(2)
});

// Same shape as the photo and user report bodies (aroundPhotoRoutes.ts,
// userRoutes.ts) so the three report surfaces stay one contract for the client.
const reportSchema = z.object({
  reason: z.enum(REPORT_REASONS),
  comment: z.string().trim().max(500).optional()
});

function isReviewModeUser(userId: string) {
  // Fail-closed: an empty list is never a match (an all-empty CSV must not
  // degrade into "everyone", and the check is explicit so it stays that way).
  if (config.reviewModeUserIds.length === 0) return false;
  return config.reviewModeUserIds.includes(userId);
}

// Local copy of the duplicate-key detection used by userRoutes.ts.
function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

async function ownerPseudoMap(arounds: Around[]): Promise<Map<string, string>> {
  const ownerIds = [...new Set(arounds.map((around) => String(around.ownerId)))];
  const owners = await AroundUserModel.find({ _id: { $in: ownerIds } }).lean<AroundUser[]>();
  return new Map(owners.map((owner) => [String(owner._id), owner.pseudo]));
}

// Loads the around from :id and requires an ACTIVE membership of the caller.
// Purged/purging arounds behave as 404.
export function requireMembership(options: { ownerOnly?: boolean } = {}) {
  return (req: AroundRequest, res: Response, next: NextFunction) => {
    void (async () => {
      try {
        if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "AROUND_NOT_FOUND" });
        const around = await AroundModel.findById(req.params.id).lean<Around>();
        if (!around || around.status === "purged" || around.status === "purging") {
          return res.status(404).json({ error: "AROUND_NOT_FOUND" });
        }
        const user = req.user as AroundUser;
        const membership = await AroundMemberModel.findOne({
          aroundId: around._id,
          userId: user._id,
          status: "active"
        }).lean<AroundMember>();
        if (!membership) return res.status(403).json({ error: "NOT_A_MEMBER" });
        if (options.ownerOnly && membership.role !== "owner") {
          return res.status(403).json({ error: "OWNER_ONLY" });
        }
        req.around = around;
        req.membership = membership;
        return next();
      } catch (error) {
        return next(error);
      }
    })();
  };
}

export function registerAroundRoutes(app: Express) {
  // POST /api/arounds — create an around. Duration bounded server-side
  // (1h..6h by default, env-driven for test cycles), max 2 active per owner,
  // async push fan-out (never blocking).
  app.post("/api/arounds", requireUser, createAroundRateLimit, wrap(async (req: AroundRequest, res: Response) => {
    const parsed = createAroundSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    const user = req.user as AroundUser;

    // The name is pushed as a notification to strangers who never joined this
    // around (fanOutAroundCreated), so it is filtered at creation — Terms §6.
    // The filter is a first-line guard only; the recourse for what it misses is
    // POST /api/arounds/:id/report below, open to non-members.
    if (parsed.data.name) {
      const verdict = checkUserText(parsed.data.name, "aroundName");
      if (!verdict.ok) return res.status(400).json({ error: "INVALID_NAME", reason: verdict.reason });
    }

    const durationMs = parsed.data.durationH !== undefined
      ? Math.round(parsed.data.durationH * 60 * 60 * 1000)
      : config.aroundDefaultWindowMs;
    if (durationMs < config.aroundMinWindowMs || durationMs > config.aroundMaxWindowMs) {
      return res.status(400).json({
        error: "INVALID_DURATION",
        details: { minMs: config.aroundMinWindowMs, maxMs: config.aroundMaxWindowMs }
      });
    }

    const activeCount = await AroundModel.countDocuments({
      ownerId: user._id,
      status: "active",
      captureEndsAt: { $gt: new Date() }
    });
    if (activeCount >= MAX_ACTIVE_AROUNDS_PER_OWNER) {
      return res.status(409).json({ error: "MAX_ACTIVE_AROUNDS", details: { max: MAX_ACTIVE_AROUNDS_PER_OWNER } });
    }

    const now = new Date();
    const captureEndsAt = new Date(now.getTime() + durationMs);
    const expiresAt = new Date(captureEndsAt.getTime() + config.aroundRetentionMs);

    // The auth cache can outlive the account by up to 60 s on another warm
    // lambda: gated only on the JWT, a create here could re-persist the exact
    // position of a user whose deletion just erased every around they owned.
    // Same DB-side gate as POST /api/users/me/location.
    const alive = await AroundUserModel.updateOne(
      { _id: user._id, status: "active" },
      { $set: { lastSeenAt: now } }
    );
    if (alive.matchedCount !== 1) return res.status(401).json({ error: "INVALID_TOKEN" });

    const created = await AroundModel.create({
      ownerId: user._id,
      name: parsed.data.name ?? null,
      center: geoPoint(parsed.data.lat, parsed.data.lng),
      radiusM: parsed.data.radiusM,
      captureWindowMs: durationMs,
      status: "active",
      createdAt: now,
      captureEndsAt,
      expiresAt,
      kickedUserIds: [],
      memberCount: 1,
      photoCount: 0
    });
    const around = created.toObject() as Around;

    await AroundMemberModel.create({
      aroundId: around._id,
      userId: user._id,
      role: "owner",
      status: "active",
      joinFixes: [{
        accuracy: parsed.data.accuracy,
        capturedAt: now,
        distanceM: 0
      }],
      interFixDistanceM: null,
      suspicious: false,
      createdAt: now
    });

    runDetached(
      fanOutAroundCreated(around).catch((error) => {
        console.error("[around:push] fan-out failed", error);
      })
    );

    return res.status(201).json({ around: aroundResponse(around, { viewerId: String(user._id), ownerPseudo: user.pseudo, role: "owner" }) });
  }));

  // GET /api/arounds/nearby — every around still OPEN within reach of the
  // caller (joinable during the whole window, the push is only an entry
  // point). Review-mode users additionally see the demo arounds owned by
  // review-mode accounts, without the geo constraint.
  app.get("/api/arounds/nearby", requireUser, nearbyRateLimit, wrap(async (req: AroundRequest, res: Response) => {
    const parsed = nearbyQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    const user = req.user as AroundUser;
    const { lat, lng } = parsed.data;
    const accuracy = parsed.data.accuracy ?? 30;
    const now = new Date();
    const viewerId = String(user._id);
    const bypassGeoChecks = config.devBypassRadius || isReviewModeUser(viewerId);

    // The queried point should be consistent with the caller's IP, like on
    // /join — but here a mismatch only DEGRADES: geoip is centroid-coarse for
    // CGNAT, VPNs and overseas carriers (a Réunion IP geolocates to Paris),
    // and the old hard 403 blanked the radar for those real users on every
    // 30 s poll. What a sweeping script gains is bounded by what this route
    // already withholds — 50 m-bucketed distances, no centre for non-members
    // — plus the 15/min rate limit. /join keeps the wall: physical presence
    // is the claim there.
    let geoDegraded = false;
    if (!bypassGeoChecks) {
      const { distanceKm } = geoIpConsistency(clientIpOf(req), lat, lng);
      if (distanceKm !== null && distanceKm > GEO_IP_MAX_DISTANCE_KM) {
        geoDegraded = true;
        warnGeoDegraded(viewerId, clientIpOf(req), distanceKm);
      }
    }

    const maxDistance = 300 + joinToleranceM(accuracy) + 100;
    const candidates = await AroundModel.find({
      status: "active",
      captureEndsAt: { $gt: now },
      center: {
        $nearSphere: {
          $geometry: geoPoint(lat, lng),
          $maxDistance: maxDistance
        }
      }
    }).limit(50).lean<Around[]>();

    const blocked = await bilateralBlockSet(user._id);
    const inRange = candidates.filter((around) => {
      if (blocked.has(String(around.ownerId))) return false;
      if (around.kickedUserIds.some((id) => String(id) === viewerId)) return false;
      // A centre-less doc is purged/erased and cannot match the geo query;
      // the guard is for the type, not for a reachable state.
      if (!around.center) return false;
      const [centerLng, centerLat] = around.center.coordinates;
      const distance = haversineMeters(lat, lng, centerLat, centerLng);
      return distance <= around.radiusM + joinToleranceM(accuracy);
    });

    let extra: Around[] = [];
    if (isReviewModeUser(viewerId)) {
      const ownerIds = config.reviewModeUserIds
        .filter((id) => isValidObjectId(id))
        .map((id) => new Types.ObjectId(id));
      // REVIEW_MODE_USER_IDS is a list of VIEWERS. The demo around belongs to
      // the seeded `pma-demo` account, not to the reviewer, so it has to be
      // resolved server-side — otherwise the review account sees nothing.
      // Oldest account wins. Public names stopped being unique on 2026-08-30,
      // and "pma-demo" is a name anyone can register: an unordered findOne
      // would then be non-deterministic, and could serve a stranger's arounds
      // to the review account with the geo constraint lifted.
      const demoOwner = await AroundUserModel
        .findOne({ pseudoLower: REVIEW_DEMO_OWNER_PSEUDO })
        .sort({ createdAt: 1 })
        .lean<AroundUser>();
      if (demoOwner && !ownerIds.some((id) => id.equals(demoOwner._id))) {
        ownerIds.push(demoOwner._id);
      }
      if (ownerIds.length > 0) {
        const seen = new Set(inRange.map((around) => String(around._id)));
        extra = (await AroundModel.find({
          status: "active",
          captureEndsAt: { $gt: now },
          ownerId: { $in: ownerIds }
        }).lean<Around[]>()).filter((around) => !seen.has(String(around._id)));
      }
    }

    // The type-predicate filter also covers the review-mode `extra` docs,
    // which never went through the geo query or inRange's centre guard: an
    // erased centre must degrade to an absent card, never to a crash.
    const all = [...inRange, ...extra].filter(
      (around): around is Around & { center: GeoPoint } => Boolean(around.center)
    );
    const memberships = await AroundMemberModel.find({
      userId: user._id,
      aroundId: { $in: all.map((around) => around._id) },
      status: "active"
    }).lean<AroundMember[]>();
    const joinedIds = new Set(memberships.map((membership) => String(membership.aroundId)));
    const pseudos = await ownerPseudoMap(all);

    return res.json({
      // Additive and only ever true: old clients ignore it, a debugging
      // session (or a future banner) can read why distances may be off.
      ...(geoDegraded ? { geoDegraded: true } : {}),
      arounds: all.map((around) => {
        const [centerLng, centerLat] = around.center.coordinates;
        const joined = joinedIds.has(String(around._id));
        // The exact center AND the exact distance are only disclosed to
        // members. Non-joined callers get a 50 m band measured from the
        // jittered display centre (see displayCenterOffset): enough to
        // render the card, useless as a trilateration oracle.
        let measuredM: number;
        if (joined) {
          measuredM = haversineMeters(lat, lng, centerLat, centerLng);
        } else {
          const { dLatM, dLngM } = displayCenterOffset(String(around._id));
          const display = offsetPoint(centerLat, centerLng, dLatM, dLngM);
          measuredM = haversineMeters(lat, lng, display.lat, display.lng);
        }
        const { center, ...rest } = aroundResponse(around, {
          viewerId,
          ownerPseudo: pseudos.get(String(around.ownerId)) ?? null,
          distanceM: joined
            ? Math.round(measuredM)
            : Math.ceil(measuredM / NEARBY_DISTANCE_BUCKET_M) * NEARBY_DISTANCE_BUCKET_M
        });
        return {
          ...rest,
          ...(joined ? { center } : {}),
          joined
        };
      })
    });
  }));

  // GET /api/arounds/mine — active memberships + 7-day history (closed,
  // not yet purged, still readable).
  app.get("/api/arounds/mine", requireUser, wrap(async (req: AroundRequest, res: Response) => {
    const user = req.user as AroundUser;
    const memberships = await AroundMemberModel.find({ userId: user._id, status: "active" }).lean<AroundMember[]>();
    const roleByAround = new Map(memberships.map((membership) => [String(membership.aroundId), membership.role]));
    const arounds = await AroundModel.find({
      _id: { $in: memberships.map((membership) => membership.aroundId) },
      status: { $in: ["active", "closed"] }
    }).sort({ captureEndsAt: -1 }).lean<Around[]>();
    const pseudos = await ownerPseudoMap(arounds);

    return res.json({
      arounds: arounds.map((around) => aroundResponse(around, {
        viewerId: String(user._id),
        ownerPseudo: pseudos.get(String(around.ownerId)) ?? null,
        role: roleByAround.get(String(around._id)) ?? "member"
      }))
    });
  }));

  // POST /api/arounds/:id/join — double position fix verification.
  // Ordered guards: 404, 410 while closed, idempotent when already a member,
  // kicked/banned refusals, then the fix pipeline (see geoUtils).
  app.post("/api/arounds/:id/join", requireUser, joinRateLimit, wrap(async (req: AroundRequest, res: Response) => {
    const user = req.user as AroundUser;
    const viewerId = String(user._id);
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "AROUND_NOT_FOUND" });

    const around = await AroundModel.findById(req.params.id).lean<Around>();
    if (!around || around.status === "purged" || around.status === "purging") {
      return res.status(404).json({ error: "AROUND_NOT_FOUND" });
    }
    if (around.status !== "active" || around.captureEndsAt.getTime() <= Date.now()) {
      return res.status(410).json({ error: "CAPTURE_WINDOW_CLOSED" });
    }

    const existing = await AroundMemberModel.findOne({ aroundId: around._id, userId: user._id }).lean<AroundMember>();
    if (existing?.status === "active") {
      return res.json({
        around: aroundResponse(around, { viewerId, role: existing.role }),
        member: { role: existing.role, status: existing.status },
        alreadyMember: true
      });
    }
    if (existing?.status === "removed" || around.kickedUserIds.some((id) => String(id) === viewerId)) {
      return res.status(403).json({ error: "KICKED" });
    }

    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });

    const fixes = parsed.data.fixes as [JoinFixInput, JoinFixInput];
    const reviewBypass = isReviewModeUser(viewerId);
    const bypassGeoChecks = config.devBypassRadius || reviewBypass;
    const center = around.center;
    if (!center) {
      // Only purged/owner-erased docs lack a centre, and those were refused
      // above — but a claim of presence cannot be verified without one.
      return res.status(404).json({ error: "AROUND_NOT_FOUND" });
    }
    const verdict = verifyJoinFixes({ center, radiusM: around.radiusM }, fixes, { ip: clientIpOf(req), bypassGeoChecks });
    if (!verdict.ok) {
      return res.status(verdict.status).json({ error: verdict.error, ...(verdict.details ?? {}) });
    }
    if (bypassGeoChecks) {
      // A join with no proof of physical presence must never be silent, and
      // must stay distinguishable from a legitimate join in the database: a
      // REVIEW_MODE_USER_IDS entry forgotten in production is then visible in
      // the logs and in the membership audit instead of blending in.
      verdict.audit.suspicious = true;
      console.warn(
        `[around:geo-bypass] join without geo verification (${reviewBypass ? "REVIEW_MODE_USER_IDS" : "DEV_BYPASS_RADIUS"}) ` +
        `user=${viewerId} around=${String(around._id)} ip=${clientIpOf(req) ?? "unknown"}`
      );
    }

    if (existing) {
      // Re-join after a voluntary leave: reactivate with a fresh audit.
      await AroundMemberModel.updateOne(
        { _id: existing._id },
        {
          $set: {
            status: "active",
            joinFixes: verdict.audit.joinFixes,
            interFixDistanceM: verdict.audit.interFixDistanceM,
            suspicious: verdict.audit.suspicious
          }
        }
      );
    } else {
      try {
        await AroundMemberModel.create({
          aroundId: around._id,
          userId: user._id,
          role: "member",
          status: "active",
          joinFixes: verdict.audit.joinFixes,
          interFixDistanceM: verdict.audit.interFixDistanceM,
          suspicious: verdict.audit.suspicious,
          createdAt: new Date()
        });
      } catch (error) {
        // Concurrent join: the unique {aroundId, userId} index makes the
        // second create fail with E11000. Answer the idempotent alreadyMember
        // response WITHOUT the $inc below (the winning request counted it).
        if (!isDuplicateKeyError(error)) throw error;
        const member = await AroundMemberModel.findOne({
          aroundId: around._id,
          userId: user._id
        }).lean<AroundMember>();
        if (member?.status === "active") {
          return res.json({
            around: aroundResponse(around, { viewerId, role: member.role }),
            member: { role: member.role, status: member.status },
            alreadyMember: true
          });
        }
        throw error;
      }
    }
    await AroundModel.updateOne({ _id: around._id }, { $inc: { memberCount: 1 } });

    return res.status(201).json({
      around: aroundResponse({ ...around, memberCount: around.memberCount + 1 }, { viewerId, role: "member" }),
      member: { role: "member", status: "active" },
      alreadyMember: false
    });
  }));

  // POST /api/arounds/:id/leave
  app.post("/api/arounds/:id/leave", requireUser, requireMembership(), wrap(async (req: AroundRequest, res: Response) => {
    const membership = req.membership as AroundMember;
    const around = req.around as Around;
    if (membership.role === "owner") return res.status(400).json({ error: "OWNER_CANNOT_LEAVE" });

    await AroundMemberModel.updateOne({ _id: membership._id }, { $set: { status: "left" } });
    await AroundModel.updateOne({ _id: around._id }, { $inc: { memberCount: -1 } });
    return res.json({ ok: true });
  }));

  // DELETE /api/arounds/:id/members/:userId — owner kick, target lands on the
  // around banlist (re-join refused).
  app.delete("/api/arounds/:id/members/:userId", requireUser, requireMembership({ ownerOnly: true }), wrap(async (req: AroundRequest, res: Response) => {
    const around = req.around as Around;
    if (!isValidObjectId(req.params.userId)) return res.status(404).json({ error: "MEMBER_NOT_FOUND" });
    const targetId = new Types.ObjectId(req.params.userId);
    if (targetId.equals(around.ownerId)) return res.status(400).json({ error: "CANNOT_KICK_OWNER" });

    const target = await AroundMemberModel.findOne({
      aroundId: around._id,
      userId: targetId,
      status: "active"
    }).lean<AroundMember>();
    if (!target) return res.status(404).json({ error: "MEMBER_NOT_FOUND" });

    await AroundMemberModel.updateOne({ _id: target._id }, { $set: { status: "removed" } });
    await AroundModel.updateOne(
      { _id: around._id },
      { $inc: { memberCount: -1 }, $addToSet: { kickedUserIds: targetId } }
    );
    return res.json({ ok: true });
  }));

  // POST /api/arounds/:id/report — report an around, i.e. its NAME.
  //
  // This is the ONE report route that must NOT require membership: the name is
  // broadcast as a push notification to every radar-enabled stranger inside the
  // radius, and someone who only saw that notification has no other recourse
  // (Terms §6 promises exactly this). Authentication and a non-banned account
  // are still required (requireUser), and the same 20/day report budget as the
  // photo and user reports applies, so the open door is not a spam channel.
  app.post("/api/arounds/:id/report", requireUser, reportRateLimit, wrap(async (req: AroundRequest, res: Response) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "AROUND_NOT_FOUND" });

    const around = await AroundModel.findById(req.params.id).lean<Around>();
    if (!around || around.status === "purged" || around.status === "purging") {
      return res.status(404).json({ error: "AROUND_NOT_FOUND" });
    }
    const user = req.user as AroundUser;
    if (String(around.ownerId) === String(user._id)) {
      return res.status(400).json({ error: "CANNOT_REPORT_OWN_AROUND" });
    }

    const { report, created } = await createReport({
      targetType: "around",
      targetId: around._id,
      aroundId: around._id,
      reporterId: user._id,
      reason: parsed.data.reason,
      comment: parsed.data.comment ?? null
    });
    if (created) {
      void sendReportAlertEmail(report, user.pseudo, around.name ?? null).catch((error) => {
        console.error("[around:moderation] report alert email failed", error);
      });
    }
    // 201 on the first report, and still 201 on a repeat: the unique index
    // makes the call idempotent per (target, reporter) and the client must not
    // be able to tell whether it already reported this around.
    return res.status(201).json({ ok: true });
  }));

  // GET /api/arounds/:id — detail + member list (bilateral blocks filtered
  // server-side).
  app.get("/api/arounds/:id", requireUser, requireMembership(), wrap(async (req: AroundRequest, res: Response) => {
    const around = req.around as Around;
    const user = req.user as AroundUser;
    const membership = req.membership as AroundMember;

    const members = await AroundMemberModel.find({ aroundId: around._id, status: "active" }).lean<AroundMember[]>();
    const blocked = await bilateralBlockSet(user._id);
    const visibleMembers = members.filter((member) => !blocked.has(String(member.userId)));
    const memberUsers = await AroundUserModel.find({
      _id: { $in: visibleMembers.map((member) => member.userId) }
    }).lean<AroundUser[]>();
    const usersById = new Map(memberUsers.map((memberUser) => [String(memberUser._id), memberUser]));

    const pseudos = await ownerPseudoMap([around]);
    return res.json({
      around: aroundResponse(around, {
        viewerId: String(user._id),
        ownerPseudo: pseudos.get(String(around.ownerId)) ?? null,
        role: membership.role
      }),
      members: visibleMembers
        .filter((member) => usersById.has(String(member.userId)))
        .map((member) => memberResponse(member, usersById.get(String(member.userId))))
    });
  }));
}
