import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { resetUserCache } from "../src/around/middleware.js";
import { config } from "../src/config.js";
import { makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import { LAUSANNE, addMember, createAroundFixture, createUser, offsetLatByMeters } from "./helpers/fixtures.js";

const app = makeTestApp();

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  vi.useRealTimers();
  await clearCollections();
  resetAroundRateLimits();
  resetUserCache();
  // REVIEW_MODE_USER_IDS is "" in vitest.config.ts; tests that need it push
  // into the live array and this resets it.
  config.reviewModeUserIds.length = 0;
});

const nearbyQuery = { lat: String(LAUSANNE.lat), lng: String(LAUSANNE.lng), accuracy: "15" };

describe("GET /api/arounds/nearby — center privacy + rate limit", () => {
  it("omits the exact center for non-joined arounds (distanceM kept) and includes it for joined ones", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const stranger = await createUser("stranger");

    const asStranger = await request(app)
      .get("/api/arounds/nearby")
      .query(nearbyQuery)
      .set("Authorization", stranger.auth);
    expect(asStranger.status).toBe(200);
    expect(asStranger.body.arounds).toHaveLength(1);
    const notJoined = asStranger.body.arounds[0];
    expect(notJoined.joined).toBe(false);
    expect(notJoined.center).toBeUndefined();
    // Distance is bucketed to 50 m for non-members (see the trilateration test).
    expect(typeof notJoined.distanceM).toBe("number");
    expect(notJoined.distanceM % 50).toBe(0);

    const member = await createUser("member");
    await addMember(around._id, member.user._id);
    const asMember = await request(app)
      .get("/api/arounds/nearby")
      .query(nearbyQuery)
      .set("Authorization", member.auth);
    expect(asMember.status).toBe(200);
    expect(asMember.body.arounds).toHaveLength(1);
    const joined = asMember.body.arounds[0];
    expect(joined.joined).toBe(true);
    expect(joined.center).toEqual({ lat: LAUSANNE.lat, lng: LAUSANNE.lng });
  });

  it("does not hand a non-member an exact distance: two probes 5 m apart return the SAME bucket (anti-trilateration)", async () => {
    const owner = await createUser("owner");
    await createAroundFixture(owner.user._id);
    const stranger = await createUser("stranger");

    // Three exact distances from three caller-chosen points reconstruct the
    // center to the meter. Bucketing removes the oracle: moving the probe by a
    // few metres must not move the answer.
    const probe = async (meters: number) => {
      const res = await request(app)
        .get("/api/arounds/nearby")
        .query({ lat: String(offsetLatByMeters(LAUSANNE.lat, meters)), lng: String(LAUSANNE.lng), accuracy: "15" })
        .set("Authorization", stranger.auth);
      expect(res.status).toBe(200);
      expect(res.body.arounds).toHaveLength(1);
      return res.body.arounds[0].distanceM as number;
    };

    const a = await probe(120);
    const b = await probe(125);
    const c = await probe(130);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a % 50).toBe(0);
  });

  it("keeps the exact distance for members", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const member = await createUser("member");
    await addMember(around._id, member.user._id);

    const res = await request(app)
      .get("/api/arounds/nearby")
      .query({ lat: String(offsetLatByMeters(LAUSANNE.lat, 123)), lng: String(LAUSANNE.lng), accuracy: "15" })
      .set("Authorization", member.auth);
    expect(res.status).toBe(200);
    const joined = res.body.arounds[0];
    expect(joined.joined).toBe(true);
    expect(Math.abs(joined.distanceM - 123)).toBeLessThan(5);
  });

  it("serves a queried point inconsistent with the caller's IP, degraded and flagged (no more blank radar)", async () => {
    const owner = await createUser("owner");
    await createAroundFixture(owner.user._id);
    const roamer = await createUser("roamer");

    // 8.8.8.8 geolocates to the US: a VPN exit or an overseas carrier IP
    // looks exactly like the city-scan pattern. /nearby serves anyway — the
    // response already withholds the oracle (bucketed distance, no centre) —
    // and marks the session; /join keeps the hard wall (see join.test.ts).
    const res = await request(app)
      .get("/api/arounds/nearby")
      .query(nearbyQuery)
      .set("X-Forwarded-For", "8.8.8.8")
      .set("Authorization", roamer.auth);
    expect(res.status).toBe(200);
    expect(res.body.geoDegraded).toBe(true);
    expect(res.body.arounds).toHaveLength(1);
    const served = res.body.arounds[0];
    expect(served.joined).toBe(false);
    expect(served.center).toBeUndefined();
    expect(served.distanceM % 50).toBe(0);
  });

  it("leaves geoDegraded unset when the IP is consistent with the queried point", async () => {
    const owner = await createUser("owner");
    await createAroundFixture(owner.user._id);
    const local = await createUser("local");

    // No X-Forwarded-For: 127.0.0.1 has no geoip entry, which is the same
    // "nothing to compare" case as a consistent IP.
    const res = await request(app)
      .get("/api/arounds/nearby")
      .query(nearbyQuery)
      .set("Authorization", local.auth);
    expect(res.status).toBe(200);
    expect(res.body.geoDegraded).toBeUndefined();
  });

  it("exempts a review-mode account from the GeoIP check", async () => {
    const owner = await createUser("owner");
    await createAroundFixture(owner.user._id);
    const reviewer = await createUser("reviewer");
    config.reviewModeUserIds.push(reviewer.id);

    const res = await request(app)
      .get("/api/arounds/nearby")
      .query(nearbyQuery)
      .set("X-Forwarded-For", "8.8.8.8")
      .set("Authorization", reviewer.auth);
    expect(res.status).toBe(200);
    // Since the degrade change everybody gets a 200: the exemption now shows
    // in the absence of the flag (no geoDegraded, no throttled warn for the
    // App Review account probing Lausanne from California).
    expect(res.body.geoDegraded).toBeUndefined();
  });

  it("caps GET /api/arounds/nearby at 15/min per user (429 RATE_LIMITED + Retry-After)", async () => {
    const owner = await createUser("owner");
    await createAroundFixture(owner.user._id);
    const walker = await createUser("walker");

    // The shared limiter's fixed windows align on the wall clock: pin Date
    // to the current window's start so the 16-request loop cannot straddle a
    // minute boundary and split its count over two windows (a real ~1% CI
    // flake otherwise). Only Date is faked — timers and Mongo stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000);

    for (let i = 0; i < 15; i += 1) {
      const res = await request(app)
        .get("/api/arounds/nearby")
        .query(nearbyQuery)
        .set("Authorization", walker.auth);
      expect(res.status).toBe(200);
    }
    const sixteenth = await request(app)
      .get("/api/arounds/nearby")
      .query(nearbyQuery)
      .set("Authorization", walker.auth);
    expect(sixteenth.status).toBe(429);
    expect(sixteenth.body.error).toBe("RATE_LIMITED");
    expect(Number(sixteenth.headers["retry-after"])).toBeGreaterThan(0);

    // Another user is not affected (per-user key).
    const other = await createUser("other");
    const otherRes = await request(app)
      .get("/api/arounds/nearby")
      .query(nearbyQuery)
      .set("Authorization", other.auth);
    expect(otherRes.status).toBe(200);

    vi.useRealTimers();
  });
});

// Cupertino — App Review's usual vantage point, ~9000 km from the demo around.
const CUPERTINO = { lat: "37.3349", lng: "-122.0090", accuracy: "15" };

describe("GET /api/arounds/nearby — review mode", () => {
  it("shows the seeded demo around to a review-mode VIEWER, from anywhere", async () => {
    // REVIEW_MODE_USER_IDS lists the review ACCOUNTS. The demo around is owned
    // by `pma-demo`, so filtering on the owner made it invisible to them.
    const demoOwner = await createUser("pma-demo");
    const demoAround = await createAroundFixture(demoOwner.user._id);
    const reviewer = await createUser("reviewer");
    config.reviewModeUserIds.push(reviewer.id);

    const res = await request(app)
      .get("/api/arounds/nearby")
      .query(CUPERTINO)
      .set("Authorization", reviewer.auth);
    expect(res.status).toBe(200);
    expect(res.body.arounds.map((around: { id: string }) => around.id)).toContain(String(demoAround._id));
  });

  it("keeps the demo around invisible to a regular user out of range", async () => {
    const demoOwner = await createUser("pma-demo");
    await createAroundFixture(demoOwner.user._id);
    const walker = await createUser("walker");

    const res = await request(app)
      .get("/api/arounds/nearby")
      .query(CUPERTINO)
      .set("Authorization", walker.auth);
    expect(res.status).toBe(200);
    expect(res.body.arounds).toHaveLength(0);
  });
});
