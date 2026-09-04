import { Types } from "mongoose";
import { config } from "../config.js";
import { M_PER_DEG_LAT, displayCenterOffset, offsetPoint } from "./geoUtils.js";
import { isDuplicateKeyError } from "./identity.js";
import { AroundModel, AroundRingModel, geoPoint, type Around, type RingKind } from "./models.js";

// The ring ledger (around_rings). Every push that tells a NON-member "an
// around is open where you are" goes through a claim here first: the unique
// (aroundId, userId) index makes the send idempotent across the creation
// fan-out, the arrival ring, a probe answer and a geofence entry, on any
// number of warm lambdas. See models.ts for the schema.

/**
 * How long an unsent claim blocks the next trigger. A claim is written
 * BEFORE the send; if the lambda is frozen or killed in between, the claim
 * survives with sentAt: null and nothing would ever ring that person again
 * (the TTL is 8 days). Past this delay a claim that never became a send is
 * taken over — long enough that two concurrent triggers never both send,
 * short enough that a lost claim costs one wake-up, not the evening.
 */
export const RING_CLAIM_STALE_MS = 2 * 60 * 1000;

/**
 * Claims the (around, user) ring. False when someone already holds it — held
 * meaning "sent", or "claimed less than RING_CLAIM_STALE_MS ago by a send
 * still in flight". The unique index is what makes this atomic across
 * lambdas; the upsert re-claims a stale unsent row in the same round trip.
 */
export async function claimRing(
  aroundId: Types.ObjectId,
  userId: Types.ObjectId,
  kind: RingKind,
  source: string | null = null
): Promise<boolean> {
  const now = new Date();
  try {
    const claimed = await AroundRingModel.findOneAndUpdate(
      {
        aroundId,
        userId,
        // Only a row that neither sent nor is currently sending may be taken.
        sentAt: null,
        claimedAt: { $lt: new Date(now.getTime() - RING_CLAIM_STALE_MS) }
      },
      { $set: { kind, source, claimedAt: now, ticketIds: [] } },
      { upsert: true, returnDocument: "after" }
    ).lean();
    return Boolean(claimed);
  } catch (error) {
    // The upsert raced a row that does not match the filter (already sent, or
    // freshly claimed): the unique index refuses the insert. That is the
    // "someone else holds it" answer.
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

/** Claims many users for one around; returns the ids that were NEW. */
export async function claimRings(
  aroundId: Types.ObjectId,
  userIds: Types.ObjectId[],
  kind: RingKind
): Promise<Types.ObjectId[]> {
  const claimed: Types.ObjectId[] = [];
  // Small batches: one insert per user keeps the duplicate-key answer exact
  // (a bulk insert only reports "some failed") and the audiences are small.
  const batch = 25;
  for (let i = 0; i < userIds.length; i += batch) {
    const slice = userIds.slice(i, i + batch);
    const results = await Promise.all(slice.map((userId) => claimRing(aroundId, userId, kind)));
    results.forEach((ok, index) => {
      if (ok) claimed.push(slice[index]);
    });
  }
  return claimed;
}

/** A send failed outright: free the claim so the next trigger retries. */
export async function releaseRing(aroundId: Types.ObjectId, userId: Types.ObjectId) {
  await AroundRingModel.deleteOne({ aroundId, userId, sentAt: null });
}

/** Same, for the users of a fan-out whose message never reached Expo. */
export async function releaseRings(aroundId: Types.ObjectId, userIds: Types.ObjectId[]) {
  if (userIds.length === 0) return;
  await AroundRingModel.deleteMany({ aroundId, userId: { $in: userIds }, sentAt: null });
}

export async function markRingsSent(aroundId: Types.ObjectId, userIds: Types.ObjectId[], ticketIdsByUser: Map<string, string[]>) {
  const now = new Date();
  await Promise.all(
    userIds.map((userId) =>
      AroundRingModel.updateOne(
        { aroundId, userId },
        { $set: { sentAt: now, ticketIds: ticketIdsByUser.get(String(userId)) ?? [] } }
      )
    )
  );
}

/** How many arrival rings this user received in the last hour (the cap). */
export async function arrivalRingsInLastHour(userId: Types.ObjectId): Promise<number> {
  return AroundRingModel.countDocuments({
    userId,
    kind: "arrival",
    claimedAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
  });
}

// --- wake regions ----------------------------------------------------------
// Handed back by POST /location so the phone can arm iOS region monitoring
// around the open arounds near it: a region entry relaunches even a
// force-quit app, which nothing else can. The centre disclosed is the
// display decoy (5–15 m off) snapped to a 100 m grid, and the radius is
// padded to keep the true circle inside — a non-member learns "there is an
// open around about here", never the anchor.

export type WakeRegion = { id: string; lat: number; lng: number; radiusM: number };

const WAKE_REGION_MAX = 15;
const WAKE_REGION_GRID_M = 100;
const WAKE_REGION_PAD_M = 150;

export function wakeRegionFor(around: Pick<Around, "_id" | "radiusM"> & { center: { coordinates: [number, number] } }): WakeRegion {
  const [centerLng, centerLat] = around.center.coordinates;
  const { dLatM, dLngM } = displayCenterOffset(String(around._id));
  const display = offsetPoint(centerLat, centerLng, dLatM, dLngM);
  const latStep = WAKE_REGION_GRID_M / M_PER_DEG_LAT;
  const lngStep = WAKE_REGION_GRID_M / (M_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180));
  return {
    id: String(around._id),
    lat: Math.round(display.lat / latStep) * latStep,
    lng: Math.round(display.lng / lngStep) * lngStep,
    radiusM: around.radiusM + WAKE_REGION_PAD_M
  };
}

export async function wakeRegionsNear(lat: number, lng: number, now = new Date()): Promise<WakeRegion[]> {
  const arounds = await AroundModel.find({
    status: "active",
    captureEndsAt: { $gt: now },
    center: { $nearSphere: { $geometry: geoPoint(lat, lng), $maxDistance: config.wakeRegionRangeM } }
  })
    .limit(WAKE_REGION_MAX)
    .lean<Around[]>();
  return arounds
    .filter((around): around is Around & { center: { type: "Point"; coordinates: [number, number] } } => Boolean(around.center))
    .map((around) => wakeRegionFor(around));
}
