import type { Express, Response } from "express";
import multer from "multer";
import { Types, isValidObjectId } from "mongoose";
import { z } from "zod";
import { uploadImageBuffer } from "../cloudinary.js";
import { config } from "../config.js";
import { isSupportedImage, safeRandomId } from "../utils.js";
import { reportRateLimit, uploadPhotoRateLimit } from "./aroundRateLimit.js";
import { requireMembership } from "./aroundRoutes.js";
import { requireUser, wrap, type AroundRequest } from "./middleware.js";
import { bilateralBlockSet, createReport, sendReportAlertEmail } from "./moderation.js";
import {
  AroundModel,
  AroundPhotoModel,
  AroundUserModel,
  REPORT_REASONS,
  type Around,
  type AroundPhoto,
  type AroundUser
} from "./models.js";
import { downloadUrl } from "./photoDelivery.js";
import { destroyPhotoAssets } from "./purge.js";
import { notifyPhotoApproved } from "./push.js";
import { aroundPhotoResponse } from "./serializers.js";

// Multer config copied from the frozen routes.ts (NOT exported from it).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported image type"));
  }
});

const MAX_PHOTOS_PER_USER_PER_AROUND = 50;

const feedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(60).optional()
});

const reportSchema = z.object({
  reason: z.enum(REPORT_REASONS),
  comment: z.string().trim().max(500).optional()
});

async function uploaderPseudoMap(photos: AroundPhoto[]): Promise<Map<string, string>> {
  const uploaderIds = [...new Set(photos.map((photo) => String(photo.uploaderId)))];
  const users = await AroundUserModel.find({ _id: { $in: uploaderIds } }).lean<AroundUser[]>();
  return new Map(users.map((user) => [String(user._id), user.pseudo]));
}

function canSeeClear(photo: AroundPhoto, around: Around, viewerId: string) {
  return String(photo.uploaderId) === viewerId
    || String(around.ownerId) === viewerId
    || photo.status === "approved";
}

export function registerAroundPhotoRoutes(app: Express) {
  // GET /api/arounds/:id/photos — cursor-paginated feed. Per-photo gating is
  // SERVER-SIDE: aroundPhotoResponse is the only place deciding clear vs
  // blurred signed URLs. Rejected photos are only returned to their author;
  // bilateral blocks are filtered here (not client-side).
  app.get("/api/arounds/:id/photos", requireUser, requireMembership(), wrap(async (req: AroundRequest, res: Response) => {
    const parsed = feedQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    const around = req.around as Around;
    const user = req.user as AroundUser;
    const viewerId = String(user._id);
    const limit = parsed.data.limit ?? 30;

    const blocked = await bilateralBlockSet(user._id);
    const filter: Record<string, unknown> = {
      aroundId: around._id,
      purgeState: "live",
      $and: [
        { $or: [{ status: { $in: ["pending", "approved"] } }, { status: "rejected", uploaderId: user._id }] },
        { uploaderId: { $nin: [...blocked].filter(isValidObjectId).map((id) => new Types.ObjectId(id)) } }
      ]
    };
    if (parsed.data.cursor && isValidObjectId(parsed.data.cursor)) {
      filter._id = { $lt: new Types.ObjectId(parsed.data.cursor) };
    }

    const photos = await AroundPhotoModel.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<AroundPhoto[]>();
    const page = photos.slice(0, limit);
    const nextCursor = photos.length > limit ? String(page[page.length - 1]._id) : null;

    const pseudos = await uploaderPseudoMap(page);
    const serialized = page
      .map((photo) => aroundPhotoResponse(photo, around, viewerId, pseudos.get(String(photo.uploaderId)) ?? null))
      .filter((photo) => photo !== null);

    return res.json({ photos: serialized, nextCursor });
  }));

  // POST /api/arounds/:id/photos — multipart upload, same contract as the
  // existing capture flow (photoRear/photoFront, captureMode). Assets are
  // uploaded as Cloudinary type "authenticated"; only public_id + version are
  // stored. Owner photos are auto-approved (the owner is the first-level
  // moderator); everything else lands as "pending".
  app.post(
    "/api/arounds/:id/photos",
    requireUser,
    requireMembership(),
    uploadPhotoRateLimit,
    upload.fields([{ name: "photoRear", maxCount: 1 }, { name: "photoFront", maxCount: 1 }]),
    wrap(async (req: AroundRequest, res: Response) => {
      const around = req.around as Around;
      const user = req.user as AroundUser;
      const viewerId = String(user._id);

      if (around.status !== "active" || around.captureEndsAt.getTime() <= Date.now()) {
        return res.status(410).json({ error: "CAPTURE_WINDOW_CLOSED" });
      }

      const uploadedCount = await AroundPhotoModel.countDocuments({ aroundId: around._id, uploaderId: user._id });
      if (uploadedCount >= MAX_PHOTOS_PER_USER_PER_AROUND) {
        return res.status(403).json({ error: "PHOTO_QUOTA_REACHED", details: { max: MAX_PHOTOS_PER_USER_PER_AROUND } });
      }

      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const rearFile = files?.photoRear?.[0] ?? null;
      const frontFile = files?.photoFront?.[0] ?? null;
      const captureMode = typeof req.body?.captureMode === "string" ? req.body.captureMode : "double";

      if (!rearFile) return res.status(400).json({ error: "PHOTO_REQUIRED" });
      if (captureMode === "double" && !frontFile) {
        return res.status(400).json({ error: "PHOTO_REQUIRED", message: "Both rear and front photos are required." });
      }
      if (!isSupportedImage(rearFile.buffer)) return res.status(400).json({ error: "INVALID_IMAGE" });
      if (frontFile && !isSupportedImage(frontFile.buffer)) return res.status(400).json({ error: "INVALID_IMAGE" });

      const folder = `${config.cloudinaryUploadFolder}/around/${String(around._id)}`;
      const baseId = safeRandomId("apic", 10);
      const rearUpload = await uploadImageBuffer(rearFile.buffer, {
        type: "authenticated",
        folder,
        public_id: baseId
      });
      const frontUpload = frontFile
        ? await uploadImageBuffer(frontFile.buffer, {
            type: "authenticated",
            folder,
            public_id: `${baseId}-front`
          })
        : null;

      const isOwner = String(around.ownerId) === viewerId;
      const now = new Date();
      const created = await AroundPhotoModel.create({
        aroundId: around._id,
        uploaderId: user._id,
        status: isOwner ? "approved" : "pending",
        captureMode,
        rearPublicId: rearUpload.public_id,
        rearVersion: rearUpload.version,
        rearFormat: rearUpload.format ?? "jpg",
        rearBytes: rearFile.size,
        rearMime: rearFile.mimetype,
        frontPublicId: frontUpload?.public_id ?? null,
        frontVersion: frontUpload?.version ?? null,
        frontFormat: frontUpload ? frontUpload.format ?? "jpg" : null,
        frontBytes: frontFile?.size ?? null,
        frontMime: frontFile?.mimetype ?? null,
        capturedAt: now,
        approvedAt: isOwner ? now : null,
        reportCount: 0,
        purgeState: "live"
      });
      await AroundModel.updateOne({ _id: around._id }, { $inc: { photoCount: 1 } });

      const photo = created.toObject() as AroundPhoto;
      return res.status(201).json({ photo: aroundPhotoResponse(photo, around, viewerId, user.pseudo) });
    })
  );

  const loadPhoto = async (req: AroundRequest, res: Response): Promise<AroundPhoto | null> => {
    if (!isValidObjectId(req.params.photoId)) {
      res.status(404).json({ error: "PHOTO_NOT_FOUND" });
      return null;
    }
    const around = req.around as Around;
    const photo = await AroundPhotoModel.findOne({
      _id: new Types.ObjectId(req.params.photoId),
      aroundId: around._id
    }).lean<AroundPhoto>();
    if (!photo || photo.purgeState === "purged") {
      res.status(404).json({ error: "PHOTO_NOT_FOUND" });
      return null;
    }
    return photo;
  };

  // POST .../approve | .../reject — owner only, transitions from "pending"
  // only. Approving pushes "photo debloquee" to the uploader.
  app.post("/api/arounds/:id/photos/:photoId/approve", requireUser, requireMembership({ ownerOnly: true }), wrap(async (req: AroundRequest, res: Response) => {
    const photo = await loadPhoto(req, res);
    if (!photo) return;
    const around = req.around as Around;
    const user = req.user as AroundUser;
    if (photo.status !== "pending") return res.status(409).json({ error: "INVALID_STATUS_TRANSITION" });

    const now = new Date();
    const result = await AroundPhotoModel.updateOne(
      { _id: photo._id, status: "pending" },
      { $set: { status: "approved", approvedAt: now } }
    );
    // Approve/reject race: the conditional update matched nothing, so the
    // photo is no longer pending — never fabricate an "approved" response or
    // push a "photo debloquee" notification from the stale copy.
    if (result.matchedCount === 0) return res.status(409).json({ error: "INVALID_STATUS_TRANSITION" });
    const updated = { ...photo, status: "approved" as const, approvedAt: now };

    void notifyPhotoApproved(around, photo.uploaderId).catch((error) => {
      console.error("[around:push] photo-approved failed", error);
    });

    const uploader = await AroundUserModel.findById(photo.uploaderId).lean<AroundUser>();
    return res.json({ photo: aroundPhotoResponse(updated, around, String(user._id), uploader?.pseudo ?? null) });
  }));

  app.post("/api/arounds/:id/photos/:photoId/reject", requireUser, requireMembership({ ownerOnly: true }), wrap(async (req: AroundRequest, res: Response) => {
    const photo = await loadPhoto(req, res);
    if (!photo) return;
    if (photo.status !== "pending") return res.status(409).json({ error: "INVALID_STATUS_TRANSITION" });

    const result = await AroundPhotoModel.updateOne(
      { _id: photo._id, status: "pending" },
      { $set: { status: "rejected" } }
    );
    // Same race guard as approve: no match means the status changed under us.
    if (result.matchedCount === 0) return res.status(409).json({ error: "INVALID_STATUS_TRANSITION" });
    // A rejected photo is only serialisable for its author, so the owner gets
    // a minimal acknowledgment instead of the feed serialisation.
    return res.json({ photo: { id: String(photo._id), status: "rejected" } });
  }));

  // DELETE — uploader or owner. Cloudinary destroyed first, then Mongo.
  app.delete("/api/arounds/:id/photos/:photoId", requireUser, requireMembership(), wrap(async (req: AroundRequest, res: Response) => {
    const photo = await loadPhoto(req, res);
    if (!photo) return;
    const around = req.around as Around;
    const user = req.user as AroundUser;
    const viewerId = String(user._id);
    const isOwner = String(around.ownerId) === viewerId;
    const isUploader = String(photo.uploaderId) === viewerId;
    if (!isOwner && !isUploader) return res.status(403).json({ error: "FORBIDDEN" });

    await destroyPhotoAssets(photo);
    await AroundPhotoModel.deleteOne({ _id: photo._id });
    await AroundModel.updateOne({ _id: around._id }, { $inc: { photoCount: -1 } });
    return res.json({ ok: true });
  }));

  // GET .../download — expiring (10 min) private download URLs for
  // save-to-gallery / share, only for viewers who can already see it clear.
  app.get("/api/arounds/:id/photos/:photoId/download", requireUser, requireMembership(), wrap(async (req: AroundRequest, res: Response) => {
    const photo = await loadPhoto(req, res);
    if (!photo) return;
    const around = req.around as Around;
    const user = req.user as AroundUser;
    const viewerId = String(user._id);

    if (photo.purgeState !== "live" || photo.status === "removed_by_moderation") {
      return res.status(404).json({ error: "PHOTO_NOT_FOUND" });
    }
    if (photo.status === "rejected" && String(photo.uploaderId) !== viewerId) {
      return res.status(404).json({ error: "PHOTO_NOT_FOUND" });
    }
    if (!canSeeClear(photo, around, viewerId)) {
      return res.status(403).json({ error: "FORBIDDEN" });
    }

    return res.json({
      rearUrl: downloadUrl(photo.rearPublicId, photo.rearFormat),
      frontUrl: photo.frontPublicId ? downloadUrl(photo.frontPublicId, photo.frontFormat ?? "jpg") : null,
      expiresInSeconds: 600
    });
  }));

  // POST .../report — UGC compliance (enum reasons), idempotent per reporter,
  // email alert to the moderator (24h SLA).
  app.post("/api/arounds/:id/photos/:photoId/report", requireUser, requireMembership(), reportRateLimit, wrap(async (req: AroundRequest, res: Response) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
    const photo = await loadPhoto(req, res);
    if (!photo) return;
    const around = req.around as Around;
    const user = req.user as AroundUser;
    if (String(photo.uploaderId) === String(user._id)) {
      return res.status(400).json({ error: "CANNOT_REPORT_OWN_PHOTO" });
    }

    const { report, created } = await createReport({
      targetType: "photo",
      targetId: photo._id,
      aroundId: around._id,
      reporterId: user._id,
      reason: parsed.data.reason,
      comment: parsed.data.comment ?? null
    });
    if (created) {
      await AroundPhotoModel.updateOne({ _id: photo._id }, { $inc: { reportCount: 1 } });
      void sendReportAlertEmail(report, user.pseudo).catch((error) => {
        console.error("[around:moderation] report alert email failed", error);
      });
    }
    return res.json({ ok: true });
  }));
}
