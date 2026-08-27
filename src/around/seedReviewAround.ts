import mongoose from "mongoose";
import { config } from "../config.js";
import {
  AroundMemberModel,
  AroundModel,
  AroundUserModel,
  geoPoint,
  syncAroundIndexes
} from "./models.js";

// App Store review kit: seeds (or refreshes) a permanent demo around owned by
// a dedicated demo account. Add the printed owner id to REVIEW_MODE_USER_IDS
// so the review account can see and join it without the geo constraint.
// Usage: npm run seed:review -w backend

const DEMO_PSEUDO = "pma-demo";
const DEMO_APPLE_SUB = "review-demo-apple-sub";
// Place Saint-Francois, Lausanne
const DEMO_LAT = 46.5197;
const DEMO_LNG = 6.6323;

async function main() {
  await mongoose.connect(config.mongoUri);
  await syncAroundIndexes();

  let owner = await AroundUserModel.findOne({ pseudoLower: DEMO_PSEUDO }).lean();
  if (!owner) {
    const now = new Date();
    const created = await AroundUserModel.create({
      appleSub: DEMO_APPLE_SUB,
      pseudo: DEMO_PSEUDO,
      pseudoLower: DEMO_PSEUDO,
      email: null,
      radarEnabled: false,
      status: "active",
      termsAcceptedAt: now,
      termsVersion: "2026-08",
      createdAt: now,
      lastSeenAt: now
    });
    owner = created.toObject();
  }

  const now = new Date();
  // Effectively permanent (+10 years): the demo around is written directly
  // through Mongoose, and the schema imposes no bound on captureEndsAt (the
  // 1h-6h limit only exists in the HTTP route). The minute tick therefore
  // never closes it, and the purge job never reaches it.
  const captureEndsAt = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
  const expiresAt = new Date(captureEndsAt.getTime() + config.aroundRetentionMs);

  let around = await AroundModel.findOne({ ownerId: owner._id, status: "active" }).lean();
  if (around) {
    await AroundModel.updateOne(
      { _id: around._id },
      { $set: { captureEndsAt, expiresAt, captureWindowMs: captureEndsAt.getTime() - now.getTime(), endingNotifiedAt: null } }
    );
    console.log(`[seed:review] refreshed demo around ${String(around._id)} (window extended to ${captureEndsAt.toISOString()})`);
  } else {
    const created = await AroundModel.create({
      ownerId: owner._id,
      name: "Picture me around — demo",
      center: geoPoint(DEMO_LAT, DEMO_LNG),
      radiusM: 300,
      captureWindowMs: captureEndsAt.getTime() - now.getTime(),
      status: "active",
      createdAt: now,
      captureEndsAt,
      expiresAt,
      kickedUserIds: [],
      memberCount: 1,
      photoCount: 0
    });
    around = created.toObject();
    await AroundMemberModel.create({
      aroundId: around._id,
      userId: owner._id,
      role: "owner",
      status: "active",
      joinFixes: [{ lat: DEMO_LAT, lng: DEMO_LNG, accuracy: 5, capturedAt: now, distanceM: 0 }],
      interFixDistanceM: null,
      joinIp: null,
      joinGeo: null,
      suspicious: false,
      createdAt: now
    });
    console.log(`[seed:review] created demo around ${String(around._id)}`);
  }

  console.log(`[seed:review] demo owner id: ${String(owner._id)}`);
  console.log("[seed:review] add the review account user ids (and optionally this owner id) to REVIEW_MODE_USER_IDS.");
  console.log("[seed:review] the demo around is effectively permanent (+10 years); re-running simply refreshes it.");
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("[seed:review] failed", error);
  process.exitCode = 1;
});
