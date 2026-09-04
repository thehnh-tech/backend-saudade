import { Types } from "mongoose";
import { signAuth } from "../../src/auth.js";
import {
  AroundMemberModel,
  AroundModel,
  AroundPhotoModel,
  AroundUserModel,
  geoPoint,
  type Around,
  type AroundPhoto,
  type AroundUser
} from "../../src/around/models.js";

// Place Saint-Francois, Lausanne — real coordinates for the join fixtures.
export const LAUSANNE = { lat: 46.5197, lng: 6.6323 };

const METERS_PER_DEG_LAT = 111_320;

// Offsets a latitude by ~meters (good enough at Lausanne's latitude for the
// test tolerances involved).
export function offsetLatByMeters(lat: number, meters: number) {
  return lat + meters / METERS_PER_DEG_LAT;
}

let userSeq = 0;

export async function createUser(pseudo?: string, overrides: Partial<AroundUser> = {}) {
  userSeq += 1;
  const name = pseudo ?? `user${userSeq}`;
  const now = new Date();
  const created = await AroundUserModel.create({
    appleSub: `apple-sub-${name}`,
    pseudo: name,
    pseudoLower: name.toLowerCase(),
    email: null,
    radarEnabled: false,
    status: "active",
    termsAcceptedAt: now,
    termsVersion: "test",
    createdAt: now,
    lastSeenAt: now,
    ...overrides
  });
  const user = created.toObject() as AroundUser;
  return {
    user,
    id: String(user._id),
    auth: `Bearer ${signAuth({ role: "user", userId: String(user._id) })}`
  };
}

export function adminAuth() {
  return `Bearer ${signAuth({ role: "admin" })}`;
}

export async function createAroundFixture(
  ownerId: Types.ObjectId,
  overrides: Partial<Around> = {}
) {
  const now = new Date();
  const windowMs = overrides.captureWindowMs ?? 4 * 60 * 60 * 1000;
  const captureEndsAt = overrides.captureEndsAt ?? new Date(now.getTime() + windowMs);
  const expiresAt = overrides.expiresAt ?? new Date(captureEndsAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const created = await AroundModel.create({
    ownerId,
    name: "Test around",
    center: geoPoint(LAUSANNE.lat, LAUSANNE.lng),
    radiusM: 300,
    captureWindowMs: windowMs,
    status: "active",
    createdAt: now,
    captureEndsAt,
    expiresAt,
    kickedUserIds: [],
    memberCount: 1,
    photoCount: 0,
    ...overrides
  });
  const around = created.toObject() as Around;
  await AroundMemberModel.create({
    aroundId: around._id,
    userId: ownerId,
    role: "owner",
    status: "active",
    joinFixes: [{ accuracy: 5, capturedAt: now, distanceM: 0 }],
    interFixDistanceM: null,
    suspicious: false,
    createdAt: now
  });
  return around;
}

export async function addMember(aroundId: Types.ObjectId, userId: Types.ObjectId, status: "active" | "left" | "removed" = "active") {
  await AroundMemberModel.create({
    aroundId,
    userId,
    role: "member",
    status,
    joinFixes: [],
    interFixDistanceM: null,
    suspicious: false,
    createdAt: new Date()
  });
  if (status === "active") {
    await AroundModel.updateOne({ _id: aroundId }, { $inc: { memberCount: 1 } });
  }
}

let photoSeq = 0;

export async function createPhotoFixture(
  aroundId: Types.ObjectId,
  uploaderId: Types.ObjectId,
  overrides: Partial<AroundPhoto> = {}
) {
  photoSeq += 1;
  const created = await AroundPhotoModel.create({
    aroundId,
    uploaderId,
    status: "pending",
    captureMode: "double",
    rearPublicId: `around/test/rear-${photoSeq}`,
    rearVersion: 100 + photoSeq,
    rearFormat: "jpg",
    rearBytes: 1000,
    rearMime: "image/jpeg",
    frontPublicId: `around/test/front-${photoSeq}`,
    frontVersion: 200 + photoSeq,
    frontFormat: "jpg",
    frontBytes: 900,
    frontMime: "image/jpeg",
    capturedAt: new Date(),
    approvedAt: null,
    reportCount: 0,
    purgeState: "live",
    ...overrides
  });
  return created.toObject() as AroundPhoto;
}

// Two GPS fixes as sent by the app: fresh, spaced by ~spacingMs.
export function makeFixes(
  lat: number,
  lng: number,
  options: {
    accuracy?: number;
    spacingMs?: number;
    ageMs?: number;
    secondLat?: number;
    secondLng?: number;
    secondAccuracy?: number;
  } = {}
) {
  const accuracy = options.accuracy ?? 10;
  const spacingMs = options.spacingMs ?? 10_000;
  const ageMs = options.ageMs ?? 0;
  const t2 = Date.now() - ageMs;
  const t1 = t2 - spacingMs;
  return [
    { lat, lng, accuracy, capturedAt: new Date(t1).toISOString() },
    {
      lat: options.secondLat ?? lat,
      lng: options.secondLng ?? lng,
      accuracy: options.secondAccuracy ?? accuracy,
      capturedAt: new Date(t2).toISOString()
    }
  ];
}

// Minimal valid JPEG magic bytes (passes isSupportedImage).
export function jpegBuffer() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
}
