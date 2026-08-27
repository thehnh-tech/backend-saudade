import type { Express, Response } from "express";
import { isValidObjectId } from "mongoose";
import { requireRole } from "../auth.js";
import type { AuthedRequest } from "../types.js";
import { invalidateUserCache, wrap } from "./middleware.js";
import { logModerationAction } from "./moderation.js";
import {
  AroundModel,
  AroundPhotoModel,
  AroundReportModel,
  AroundUserModel,
  type Around,
  type AroundPhoto,
  type AroundReport,
  type AroundUser
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

    const photos = await AroundPhotoModel.find({ _id: { $in: photoIds } }).lean<AroundPhoto[]>();
    const photosById = new Map(photos.map((photo) => [String(photo._id), photo]));
    const uploaderIds = photos.map((photo) => String(photo.uploaderId));
    const users = await AroundUserModel.find({
      _id: { $in: [...new Set([...reporterIds, ...userTargetIds.map(String), ...uploaderIds])] }
    }).lean<AroundUser[]>();
    const usersById = new Map(users.map((user) => [String(user._id), user]));

    return res.json({
      reports: reports.map((report) => {
        const photo = report.targetType === "photo" ? photosById.get(String(report.targetId)) : undefined;
        const targetUser = report.targetType === "user" ? usersById.get(String(report.targetId)) : undefined;
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

  // DELETE /api/admin/around/arounds/:id — immediate purge, SAME logic as the
  // J+7 job (Cloudinary first).
  app.delete("/api/admin/around/arounds/:id", requireRole("admin"), wrap(async (req: AuthedRequest, res: Response) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ error: "AROUND_NOT_FOUND" });
    const around = await AroundModel.findById(req.params.id).lean<Around>();
    if (!around) return res.status(404).json({ error: "AROUND_NOT_FOUND" });

    const purged = await purgeAround(around);
    await logModerationAction("around-purged", "around", around._id, { complete: purged });
    if (!purged) {
      return res.status(502).json({ error: "PURGE_INCOMPLETE", message: "Some assets could not be destroyed; the purge job will retry." });
    }
    return res.json({ ok: true });
  }));
}
