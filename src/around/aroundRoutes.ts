import type { Express, NextFunction, Response } from "express";
import { Types, isValidObjectId } from "mongoose";
import { z } from "zod";
import { config } from "../config.js";
import { createAroundRateLimit, joinRateLimit, nearbyRateLimit } from "./aroundRateLimit.js";
import { clientIpOf, haversineMeters, joinToleranceM, verifyJoinFixes, type JoinFixInput } from "./geoUtils.js";
import { requireUser, wrap, type AroundRequest } from "./middleware.js";
import { bilateralBlockSet } from "./moderation.js";
import {
  AroundMemberModel,
  AroundModel,
  AroundUserModel,
  geoPoint,
  type Around,
  type AroundMember,
  type AroundUser
} from "./models.js";
import { fanOutAroundCreated } from "./push.js";
import { aroundResponse, memberResponse } from "./serializers.js";

const MAX_ACTIVE_AROUNDS_PER_OWNER = 2;

const createAroundSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000),
  radiusM: z.number().min(10).max(300),
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

function isReviewModeUser(userId: string) {
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
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        accuracy: parsed.data.accuracy,
        capturedAt: now,
        distanceM: 0
      }],
      interFixDistanceM: null,
      joinIp: clientIpOf(req),
      joinGeo: null,
      suspicious: false,
      createdAt: now
    });

    void fanOutAroundCreated(around).catch((error) => {
      console.error("[around:push] fan-out failed", error);
    });

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
    const viewerId = String(user._id);
    const inRange = candidates.filter((around) => {
      if (blocked.has(String(around.ownerId))) return false;
      if (around.kickedUserIds.some((id) => String(id) === viewerId)) return false;
      const [centerLng, centerLat] = around.center.coordinates;
      const distance = haversineMeters(lat, lng, centerLat, centerLng);
      return distance <= around.radiusM + joinToleranceM(accuracy);
    });

    let extra: Around[] = [];
    if (isReviewModeUser(viewerId) && config.reviewModeUserIds.length > 0) {
      const reviewOwnerIds = config.reviewModeUserIds.filter((id) => isValidObjectId(id));
      const seen = new Set(inRange.map((around) => String(around._id)));
      extra = (await AroundModel.find({
        status: "active",
        captureEndsAt: { $gt: now },
        ownerId: { $in: reviewOwnerIds.map((id) => new Types.ObjectId(id)) }
      }).lean<Around[]>()).filter((around) => !seen.has(String(around._id)));
    }

    const all = [...inRange, ...extra];
    const memberships = await AroundMemberModel.find({
      userId: user._id,
      aroundId: { $in: all.map((around) => around._id) },
      status: "active"
    }).lean<AroundMember[]>();
    const joinedIds = new Set(memberships.map((membership) => String(membership.aroundId)));
    const pseudos = await ownerPseudoMap(all);

    return res.json({
      arounds: all.map((around) => {
        const [centerLng, centerLat] = around.center.coordinates;
        const joined = joinedIds.has(String(around._id));
        // The exact center is only disclosed to members: non-joined callers
        // get distanceM alone, so scripted scans cannot map third-party
        // arounds to precise coordinates.
        const { center, ...rest } = aroundResponse(around, {
          viewerId,
          ownerPseudo: pseudos.get(String(around.ownerId)) ?? null,
          distanceM: Math.round(haversineMeters(lat, lng, centerLat, centerLng))
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
    const bypassGeoChecks = config.devBypassRadius || isReviewModeUser(viewerId);
    const verdict = verifyJoinFixes(around, fixes, { ip: clientIpOf(req), bypassGeoChecks });
    if (!verdict.ok) {
      return res.status(verdict.status).json({ error: verdict.error, ...(verdict.details ?? {}) });
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
            joinIp: verdict.audit.joinIp,
            joinGeo: verdict.audit.joinGeo,
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
          joinIp: verdict.audit.joinIp,
          joinGeo: verdict.audit.joinGeo,
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
