import type { Around, AroundMember, AroundPhoto, AroundUser } from "./models.js";
import { signedBlurUrl, signedClearUrl } from "./photoDelivery.js";

// Central serialisers. aroundPhotoResponse is the ONLY place that decides
// clear vs blurred delivery — routes never build photo URLs themselves.

export function userResponse(user: AroundUser) {
  return {
    id: String(user._id),
    pseudo: user.pseudo,
    radarEnabled: user.radarEnabled,
    status: user.status,
    termsAcceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
    termsVersion: user.termsVersion,
    radarConsentAt: user.radarConsentAt ? user.radarConsentAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    providers: {
      apple: Boolean(user.appleSub),
      google: Boolean(user.googleSub)
    }
  };
}

export function aroundResponse(
  around: Around,
  options: {
    viewerId?: string;
    ownerPseudo?: string | null;
    distanceM?: number | null;
    role?: "owner" | "member" | null;
  } = {}
) {
  const [lng, lat] = around.center.coordinates;
  return {
    id: String(around._id),
    name: around.name ?? null,
    ownerId: String(around.ownerId),
    ownerPseudo: options.ownerPseudo ?? null,
    status: around.status,
    center: { lat, lng },
    radiusM: around.radiusM,
    captureWindowMs: around.captureWindowMs,
    createdAt: around.createdAt.toISOString(),
    captureEndsAt: around.captureEndsAt.toISOString(),
    expiresAt: around.expiresAt.toISOString(),
    memberCount: around.memberCount,
    photoCount: around.photoCount,
    isOwner: options.viewerId ? String(around.ownerId) === options.viewerId : false,
    ...(options.distanceM !== undefined ? { distanceM: options.distanceM } : {}),
    ...(options.role !== undefined ? { role: options.role } : {})
  };
}

export function memberResponse(member: AroundMember, user: AroundUser | undefined) {
  return {
    id: String(member.userId),
    // The mobile client reads `userId` (kick/block/report); `id` is kept for
    // compatibility with any consumer of the original shape.
    userId: String(member.userId),
    pseudo: user?.pseudo ?? "unknown",
    role: member.role,
    joinedAt: member.createdAt.toISOString()
  };
}

// canSeeClear = uploader is the viewer, or viewer is the owner (first-level
// moderator), or the photo is approved. Rejected photos are only visible to
// their author; removed_by_moderation photos are visible to nobody here.
// Returns null when the photo must not be serialised for this viewer at all.
export function aroundPhotoResponse(
  photo: AroundPhoto,
  around: Around,
  viewerId: string,
  uploaderPseudo: string | null
) {
  if (photo.purgeState !== "live") return null;
  if (photo.status === "removed_by_moderation") return null;
  const mine = String(photo.uploaderId) === viewerId;
  if (photo.status === "rejected" && !mine) return null;

  const viewerIsOwner = String(around.ownerId) === viewerId;
  const canSeeClear = mine || viewerIsOwner || photo.status === "approved";

  const rearUrl = canSeeClear
    ? signedClearUrl(photo.rearPublicId, photo.rearVersion)
    : signedBlurUrl(photo.rearPublicId, photo.rearVersion);
  const frontUrl = photo.frontPublicId && photo.frontVersion !== null && photo.frontVersion !== undefined
    ? (canSeeClear
      ? signedClearUrl(photo.frontPublicId, photo.frontVersion)
      : signedBlurUrl(photo.frontPublicId, photo.frontVersion))
    : null;

  return {
    id: String(photo._id),
    aroundId: String(photo.aroundId),
    uploaderId: String(photo.uploaderId),
    uploaderPseudo: uploaderPseudo ?? "unknown",
    status: photo.status,
    captureMode: photo.captureMode,
    capturedAt: photo.capturedAt.toISOString(),
    approvedAt: photo.approvedAt ? photo.approvedAt.toISOString() : null,
    canSeeClear,
    mine,
    rearUrl,
    frontUrl
  };
}
