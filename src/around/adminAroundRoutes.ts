import type { Express, Response } from "express";
import { Types, isValidObjectId } from "mongoose";
import { requireRole } from "../auth.js";
import { config } from "../config.js";
import type { AuthedRequest } from "../types.js";
import { haversineMeters } from "./geoUtils.js";
import { invalidateUserCache, wrap } from "./middleware.js";
import { bilateralBlockSet, logModerationAction } from "./moderation.js";
import { accuracyCreditM } from "./push.js";
import { arrivalRingsInLastHour } from "./rings.js";
import {
  AroundDeviceModel,
  AroundMemberModel,
  AroundModel,
  AroundPhotoModel,
  AroundReportModel,
  AroundRingModel,
  AroundUserModel,
  DevicePresenceModel,
  type Around,
  type AroundDevice,
  type AroundMember,
  type AroundPhoto,
  type AroundReport,
  type AroundRing,
  type AroundUser,
  type DevicePresence
} from "./models.js";
import { signedClearUrl } from "./photoDelivery.js";
import { destroyPhotoAssets, purgeAround } from "./purge.js";

// Admin moderation surface, consumed by the admin/ proxy. Signed CLEAR URLs
// are served here (and only here) to non-members: the admin is the moderator.

function adminPhotoView(photo: AroundPhoto, uploaderPseudo: string | null) {
  return {
    id: String(photo._id),
    aroundId: String(photo.aroundId),
    uploaderPseudo: uploaderPseudo ?? "unknown",
    status: photo.status,
    rearUrl: photo.purgeState === "live" ? signedClearUrl(photo.rearPublicId, photo.rearVersion) : null,
    frontUrl: photo.purgeState === "live" && photo.frontPublicId && photo.frontVersion !== null && photo.frontVersion !== undefined
      ? signedClearUrl(photo.frontPublicId, photo.frontVersion)
      : null
  };
}

export function registerAdminAroundRoutes(app: Express) {
  // GET /api/admin/around/reports?status=open|all
  app.get("/api/admin/around/reports", requireRole("admin"), wrap(async (req: AuthedRequest, res: Response) => {
    res.set("Cache-Control", "no-store");
    const statusFilter = req.query.status === "all" ? {} : { status: "open" as const };
    const reports = await AroundReportModel.find(statusFilter)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean<AroundReport[]>();

    const reporterIds = [...new Set(reports.map((report) => String(report.reporterId)))];
    const photoIds = reports.filter((report) => report.targetType === "photo").map((report) => report.targetId);
    const userTargetIds = reports.filter((report) => report.targetType === "user").map((report) => report.targetId);
    const aroundTargetIds = reports.filter((report) => report.targetType === "around").map((report) => report.targetId);

    const photos = await AroundPhotoModel.find({ _id: { $in: photoIds } }).lean<AroundPhoto[]>();
    const photosById = new Map(photos.map((photo) => [String(photo._id), photo]));
    // Reported arounds: the moderator needs the NAME (that is the reported
    // content) and the owner's pseudo (that is who to ban).
    const targetArounds = await AroundModel.find({ _id: { $in: aroundTargetIds } }).lean<Around[]>();
    const aroundsById = new Map(targetArounds.map((around) => [String(around._id), around]));
    const uploaderIds = photos.map((photo) => String(photo.uploaderId));
    const aroundOwnerIds = targetArounds.map((around) => String(around.ownerId));
    const users = await AroundUserModel.find({
      _id: { $in: [...new Set([...reporterIds, ...userTargetIds.map(String), ...uploaderIds, ...aroundOwnerIds])] }
    }).lean<AroundUser[]>();
    const usersById = new Map(users.map((user) => [String(user._id), user]));

    return res.json({
      reports: reports.map((report) => {
        const photo = report.targetType === "photo" ? photosById.get(String(report.targetId)) : undefined;
        const targetUser = report.targetType === "user" ? usersById.get(String(report.targetId)) : undefined;
        const targetAround = report.targetType === "around" ? aroundsById.get(String(report.targetId)) : undefined;
        return {
          id: String(report._id),
          targetType: report.targetType,
          reason: report.reason,
          ...(report.comment ? { comment: report.comment } : {}),
          status: report.status,
          createdAt: report.createdAt.toISOString(),
          reporterPseudo: usersById.get(String(report.reporterId))?.pseudo ?? "deleted",
          ...(photo
            ? { photo: adminPhotoView(photo, usersById.get(String(photo.uploaderId))?.pseudo ?? null) }
            : {}),
          ...(targetUser
            ? { user: { id: String(targetUser._id), pseudo: targetUser.pseudo, status: targetUser.status } }
            : {}),
          ...(targetAround
            ? {
              around: {
                id: String(targetAround._id),
                name: targetAround.name ?? null,
                ownerId: String(targetAround.ownerId),
                ownerPseudo: usersById.get(String(targetAround.ownerId))?.pseudo ?? "deleted",
                status: targetAround.status,
                memberCount: targetAround.memberCount,
                photoCount: targetAround.photoCount
              }
            }
            : {})
        };
      })
    });
  }));

  // POST /api/admin/around/reports/:id/dismiss
  app.post("/api/admin/around/reports/:id/dismiss", requireRole("admin"), wrap(async (req: AuthedRequest, res: Response) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
    const report = await AroundReportModel.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "dismissed" } },
      { returnDocument: "after" }
    ).lean<AroundReport>();
    if (!report) return res.status(404).json({ error: "REPORT_NOT_FOUND" });
    await logModerationAction("report-dismissed", "report", report._id);
    return res.json({ ok: true });
  }));

  // DELETE /api/admin/around/photos/:photoId — Cloudinary destroy first, then
  // status removed_by_moderation; linked reports become "actioned".
  app.delete("/api/admin/around/photos/:photoId", requireRole("admin"), wrap(async (req: AuthedRequest, res: Response) => {
    if (!isValidObjectId(req.params.photoId)) return res.status(404).json({ error: "PHOTO_NOT_FOUND" });
    const photo = await AroundPhotoModel.findById(req.params.photoId).lean<AroundPhoto>();
    if (!photo) return res.status(404).json({ error: "PHOTO_NOT_FOUND" });

    await destroyPhotoAssets(photo);
    await AroundPhotoModel.updateOne({ _id: photo._id }, { $set: { status: "removed_by_moderation" } });
    await AroundReportModel.updateMany(
      { targetType: "photo", targetId: photo._id, status: "open" },
      { $set: { status: "actioned" } }
    );
    await logModerationAction("photo-removed", "photo", photo._id, { aroundId: String(photo.aroundId) });
    return res.json({ ok: true });
  }));

  // POST /api/admin/around/users/:userId/ban | /unban — the requireUser
  // middleware re-checks status in database, so a 7-day JWT does not survive
  // a ban.
  app.post("/api/admin/around/users/:userId/ban", requireRole("admin"), wrap(async (req: AuthedRequest, res: Response) => {
    if (!isValidObjectId(req.params.userId)) return res.status(404).json({ error: "USER_NOT_FOUND" });
    const user = await AroundUserModel.findByIdAndUpdate(
      req.params.userId,
      { $set: { status: "banned" } },
      { returnDocument: "after" }
    ).lean<AroundUser>();
    if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
    invalidateUserCache(String(user._id));
    await AroundReportModel.updateMany(
      { targetType: "user", targetId: user._id, status: "open" },
      { $set: { status: "actioned" } }
    );
    await logModerationAction("user-banned", "user", user._id);
    return res.json({ ok: true });
  }));

  app.post("/api/admin/around/users/:userId/unban", requireRole("admin"), wrap(async (req: AuthedRequest, res: Response) => {
    if (!isValidObjectId(req.params.userId)) return res.status(404).json({ error: "USER_NOT_FOUND" });
    const user = await AroundUserModel.findByIdAndUpdate(
      req.params.userId,
      { $set: { status: "active" } },
      { returnDocument: "after" }
    ).lean<AroundUser>();
    if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
    invalidateUserCache(String(user._id));
    await logModerationAction("user-unbanned", "user", user._id);
    return res.json({ ok: true });
  }));

  // GET /api/admin/around/arounds
  app.get("/api/admin/around/arounds", requireRole("admin"), wrap(async (_req: AuthedRequest, res: Response) => {
    res.set("Cache-Control", "no-store");
    const arounds = await AroundModel.find().sort({ createdAt: -1 }).limit(200).lean<Around[]>();
    const owners = await AroundUserModel.find({
      _id: { $in: [...new Set(arounds.map((around) => String(around.ownerId)))] }
    }).lean<AroundUser[]>();
    const ownersById = new Map(owners.map((owner) => [String(owner._id), owner]));

    return res.json({
      arounds: arounds.map((around) => ({
        id: String(around._id),
        name: around.name ?? null,
        ownerId: String(around.ownerId),
        ownerPseudo: ownersById.get(String(around.ownerId))?.pseudo ?? "deleted",
        status: around.status,
        radiusM: around.radiusM,
        memberCount: around.memberCount,
        photoCount: around.photoCount,
        createdAt: around.createdAt.toISOString(),
        captureEndsAt: around.captureEndsAt.toISOString(),
        expiresAt: around.expiresAt.toISOString()
      }))
    });
  }));

  // GET /api/admin/around/users/:userId/radar?aroundId=<id>
  // The runbook question in one request: "would this phone ring, and if not
  // why?". Ages, accuracies and distances only — never a coordinate.
  app.get("/api/admin/around/users/:userId/radar", requireRole("admin"), wrap(async (req: AuthedRequest, res: Response) => {
    res.set("Cache-Control", "no-store");
    if (!isValidObjectId(req.params.userId)) return res.status(404).json({ error: "USER_NOT_FOUND" });
    const userId = new Types.ObjectId(req.params.userId);
    const user = await AroundUserModel.findById(userId).lean<AroundUser>();
    if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
    const now = Date.now();

    const presence = await DevicePresenceModel.findOne({ userId }).lean<DevicePresence>();
    const devices = await AroundDeviceModel.find({ userId }).sort({ lastActiveAt: -1 }).lean<AroundDevice[]>();
    const rings = await AroundRingModel.find({ userId }).sort({ claimedAt: -1 }).limit(20).lean<AroundRing[]>();

    let wouldRing: Record<string, unknown> | null = null;
    const aroundId = typeof req.query.aroundId === "string" ? req.query.aroundId : null;
    if (aroundId) {
      const around = isValidObjectId(aroundId) ? await AroundModel.findById(aroundId).lean<Around>() : null;
      if (!around) {
        wouldRing = { aroundFound: false };
      } else {
        const reasons: string[] = [];
        if (around.status !== "active" || around.captureEndsAt.getTime() <= now) reasons.push("around_not_open");
        if (String(around.ownerId) === String(userId)) reasons.push("is_owner");
        if (around.kickedUserIds.some((id) => String(id) === String(userId))) reasons.push("kicked");
        if (!user.radarEnabled) reasons.push("radar_off");
        if (user.status !== "active") reasons.push("user_not_active");
        const membership = await AroundMemberModel.findOne({ aroundId: around._id, userId }).lean<AroundMember>();
        if (membership) reasons.push(`member_${membership.status}`);
        if ((await arrivalRingsInLastHour(userId)) >= config.arrivalRingMaxPerHour) reasons.push("arrival_cap");
        const blocked = await bilateralBlockSet(userId);
        if (blocked.has(String(around.ownerId))) reasons.push("blocked");
        const withToken = devices.filter((device) => device.expoPushToken && device.pushEnabled && !device.invalidatedAt);
        if (withToken.length === 0) reasons.push("no_push_device");
        let distanceM: number | null = null;
        let allowedM: number | null = null;
        let inside: boolean | null = null;
        if (!presence) {
          reasons.push("no_presence");
        } else if (presence.capturedAt.getTime() < now - config.presenceFreshMs) {
          reasons.push("presence_stale");
        }
        if (presence && around.center) {
          const [centerLng, centerLat] = around.center.coordinates;
          const [lng, lat] = presence.location.coordinates;
          distanceM = Math.round(haversineMeters(lat, lng, centerLat, centerLng));
          allowedM = Math.round(around.radiusM + accuracyCreditM(presence.accuracy) + config.ringToleranceM);
          inside = distanceM <= allowedM;
          if (!inside) reasons.push("outside");
        }
        // Queried directly, not looked up in the 20-row display list: an
        // active account can hold more claims than that, and a missing
        // already_rung sends the operator hunting a ring path that is working.
        const rung = await AroundRingModel.findOne({ aroundId: around._id, userId }).lean<AroundRing>();
        if (rung) reasons.push(`already_rung_${rung.kind}`);
        wouldRing = { aroundFound: true, status: around.status, inside, distanceM, allowedM, reasons };
      }
    }

    return res.json({
      user: {
        id: String(user._id),
        pseudo: user.pseudo,
        status: user.status,
        radarEnabled: user.radarEnabled,
        radarConsentAt: user.radarConsentAt ? user.radarConsentAt.toISOString() : null,
        lastSeenAt: user.lastSeenAt.toISOString()
      },
      presence: presence
        ? {
            ageS: Math.round((now - presence.updatedAt.getTime()) / 1000),
            capturedAgeS: Math.round((now - presence.capturedAt.getTime()) / 1000),
            fresh: presence.capturedAt.getTime() >= now - config.presenceFreshMs,
            accuracy: presence.accuracy,
            source: presence.source,
            installationId: presence.installationId ?? null
          }
        : null,
      devices: devices.map((device) => ({
        installationId: device.installationId,
        hasToken: Boolean(device.expoPushToken),
        pushEnabled: device.pushEnabled,
        invalidatedAt: device.invalidatedAt ? device.invalidatedAt.toISOString() : null,
        lastActiveAt: device.lastActiveAt.toISOString(),
        platform: device.platform ?? null,
        appVersion: device.appVersion ?? null,
        osVersion: device.osVersion ?? null
      })),
      rings: rings.map((ring) => ({
        aroundId: String(ring.aroundId),
        kind: ring.kind,
        source: ring.source ?? null,
        claimedAt: ring.claimedAt.toISOString(),
        sentAt: ring.sentAt ? ring.sentAt.toISOString() : null,
        tickets: ring.ticketIds.length
      })),
      wouldRing
    });
  }));

  // DELETE /api/admin/around/arounds/:id — immediate purge, SAME logic as the
  // J+7 job (Cloudinary first).
  app.delete("/api/admin/around/arounds/:id", requireRole("admin"), wrap(async (req: AuthedRequest, res: Response) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "AROUND_NOT_FOUND" });
    const around = await AroundModel.findById(req.params.id).lean<Around>();
    if (!around) return res.status(404).json({ error: "AROUND_NOT_FOUND" });

    const purged = await purgeAround(around);
    // Terms §6: "a name that breaches these Terms is removed together with the
    // around it names". purgeAround itself nulls the name (and erases the
    // centre); the offending text survives only in the moderation journal,
    // which is the evidence trail.
    await logModerationAction("around-purged", "around", around._id, {
      complete: purged,
      name: around.name ?? null
    });
    if (!purged) {
      return res.status(502).json({ error: "PURGE_INCOMPLETE", message: "Some assets could not be destroyed; the purge job will retry." });
    }
    return res.json({ ok: true });
  }));
}
