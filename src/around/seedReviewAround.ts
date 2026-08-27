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
// a dedicated demo account. Add the REVIEW ACCOUNT user ids to
// REVIEW_MODE_USER_IDS so they can see and join it without the geo constraint;
// the demo owner itself is resolved server-side by pseudo (aroundRoutes.ts).
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
  // The demo around uses the SAME upper bound a real user can pick (6 h by
  // default). Writing a longer window would make the review build display
  // "capture open for 3652 more days", contradicting what the App Store
  // listing, around-terms and around-privacy promise (1-6 h window, deletion
  // at D+7) — a discrepancy a reviewer reads as a false claim. The trade-off
  // is that this script must be re-run on the day of the review session; it
  // is idempotent and simply reopens the window (see docs/APP-REVIEW-NOTES.md).
  const captureEndsAt = new Date(now.getTime() + config.aroundMaxWindowMs);
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
  console.log("[seed:review] add ONLY the review account user ids to REVIEW_MODE_USER_IDS — the demo around owned by pma-demo is resolved server-side.");
  console.log("[seed:review] the demo around is effectively permanent (+10 years); re-running simply refreshes it.");
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("[seed:review] failed", error);
  process.exitCode = 1;
});
