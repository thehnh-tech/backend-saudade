import { Types } from "mongoose";
import {
  AroundMemberModel,
  AroundModel,
  AroundPhotoModel,
  AroundReportModel,
  AroundRingModel,
  type Around,
  type AroundPhoto
} from "./models.js";
import { destroyAuthenticated } from "./photoDelivery.js";

// Shared purge primitives. The SAME functions are used by the J+7 job, by the
// admin "purge around" action and by account deletion — Cloudinary is always
// destroyed FIRST, then Mongo. destroyPhotoAssets is idempotent: destroy on a
// missing asset returns "not found" (treated as success) and purgeState
// records progress so a partial failure is retried on the next run.

export async function destroyPhotoAssets(photo: AroundPhoto): Promise<void> {
  if (photo.purgeState !== "live") return;
  await destroyAuthenticated(photo.rearPublicId);
  if (photo.frontPublicId) {
    await destroyAuthenticated(photo.frontPublicId);
  }
  await AroundPhotoModel.updateOne(
    { _id: photo._id, purgeState: "live" },
    { $set: { purgeState: "cloudinary_deleted" } }
  );
  photo.purgeState = "cloudinary_deleted";
}

// Destroys the Cloudinary assets of every photo of the around, then deletes
// the Mongo docs. Returns the number of photos that could not be purged (they
// stay in place, purgeState untouched, and are retried on the next tick).
export async function purgeAroundPhotos(aroundId: Types.ObjectId): Promise<number> {
  const photos = await AroundPhotoModel.find({ aroundId }).lean<AroundPhoto[]>();
  let failures = 0;
  for (const photo of photos) {
    try {
      await destroyPhotoAssets(photo);
      await AroundPhotoModel.deleteOne({ _id: photo._id });
    } catch (error) {
      failures += 1;
      console.error(`[around:purge] failed to purge photo ${String(photo._id)}`, error);
    }
  }
  return failures;
}

// Full purge of an around (J+7 job and admin immediate purge): photos
// Cloudinary-first, then memberships and reports; the around doc itself is
// kept with status "purged" for stats.
export async function purgeAround(around: Pick<Around, "_id">): Promise<boolean> {
  await AroundModel.updateOne(
    { _id: around._id, status: { $ne: "purged" } },
    { $set: { status: "purging" } }
  );

  const failures = await purgeAroundPhotos(around._id);
  if (failures > 0) {
    // Leave the around in "purging"; the next tick retries the leftovers.
    return false;
  }

  await AroundMemberModel.deleteMany({ aroundId: around._id });
  await AroundReportModel.deleteMany({ aroundId: around._id });
  await AroundRingModel.deleteMany({ aroundId: around._id });
  // The kept doc is counters and dates only: the centre is the owner's exact
  // position, the name is user text, and kickedUserIds is a member list —
  // none of it may outlive the purge. (Purged arounds 404 every join path, so
  // losing the kick list changes nothing.)
  await AroundModel.updateOne(
    { _id: around._id },
    { $set: { status: "purged", name: null, kickedUserIds: [] }, $unset: { center: "" } }
  );
  return true;
}

// Purge of one user's photos across every around (account deletion). Failures
// are tolerated: leftover assets are caught by the around's own J+7 purge.
export async function purgeUserPhotos(userId: Types.ObjectId): Promise<number> {
  const photos = await AroundPhotoModel.find({ uploaderId: userId }).lean<AroundPhoto[]>();
  let failures = 0;
  for (const photo of photos) {
    try {
      await destroyPhotoAssets(photo);
      await AroundPhotoModel.deleteOne({ _id: photo._id });
      await AroundModel.updateOne({ _id: photo.aroundId }, { $inc: { photoCount: -1 } });
    } catch (error) {
      failures += 1;
      console.error(`[around:purge] failed to purge user photo ${String(photo._id)}`, error);
    }
  }
  return failures;
}
