import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { resetUserCache } from "../src/around/middleware.js";
import { AroundMemberModel, AroundModel } from "../src/around/models.js";
import { makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  LAUSANNE,
  createAroundFixture,
  createUser,
  makeFixes,
  offsetLatByMeters
} from "./helpers/fixtures.js";

const app = makeTestApp();

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearCollections();
  resetAroundRateLimits();
  resetUserCache();
});

describe("POST /api/arounds/:id/join — double fix verification", () => {
  it("accepts a member ~250m inside a 300m radius (both fixes)", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");

    const lat = offsetLatByMeters(LAUSANNE.lat, 250);
    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({ fixes: makeFixes(lat, LAUSANNE.lng) });

    expect(res.status).toBe(201);
    expect(res.body.member).toEqual({ role: "member", status: "active" });
    expect(res.body.alreadyMember).toBe(false);

    const membership = await AroundMemberModel.findOne({ aroundId: around._id, userId: joiner.user._id }).lean();
    expect(membership?.status).toBe("active");
    expect(membership?.joinFixes).toHaveLength(2);
    expect(membership?.joinFixes[0].distanceM).toBeGreaterThan(200);
    // "Position jamais conservée" : the stored audit is derived numbers only —
    // no raw coordinates, no IP, no geoIP city may ever reach the database.
    const raw = membership as unknown as Record<string, unknown> & { joinFixes: Record<string, unknown>[] };
    expect(raw.joinFixes[0]).not.toHaveProperty("lat");
    expect(raw.joinFixes[0]).not.toHaveProperty("lng");
    expect(raw.joinFixes[0]).toHaveProperty("accuracy");
    expect(raw.joinFixes[0]).toHaveProperty("capturedAt");
    expect(raw).not.toHaveProperty("joinIp");
    expect(raw).not.toHaveProperty("joinGeo");
    expect(typeof membership?.interFixDistanceM).toBe("number");
    const updated = await AroundModel.findById(around._id).lean();
    expect(updated?.memberCount).toBe(2);
  });

  it("rejects a fix ~350m away with 403 OUT_OF_RANGE {distanceM, allowedM}", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");

    const lat = offsetLatByMeters(LAUSANNE.lat, 350);
    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({ fixes: makeFixes(lat, LAUSANNE.lng, { accuracy: 10 }) });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("OUT_OF_RANGE");
    expect(res.body.distanceM).toBeGreaterThan(330);
    expect(res.body.allowedM).toBe(330); // 300 + min(10,65) + 20
    expect(await AroundMemberModel.countDocuments({ aroundId: around._id, userId: joiner.user._id })).toBe(0);
  });

  it("rejects when the SECOND fix is out of range even if the first is inside", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");

    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({
        fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng, {
          spacingMs: 60_000 * 0.9, // wide spacing keeps inter-fix speed < 10 m/s
          secondLat: offsetLatByMeters(LAUSANNE.lat, 400)
        })
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("OUT_OF_RANGE");
  });

  it("rejects a single fix with 400 (two fixes are mandatory)", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");

    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({ fixes: [makeFixes(LAUSANNE.lat, LAUSANNE.lng)[0]] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_INPUT");
  });

  it("rejects fixes captured too close together with 400 STALE_FIX", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");

    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng, { spacingMs: 3_000 }) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STALE_FIX");
  });

  it("rejects an implausible inter-fix speed with 403 IMPLAUSIBLE_MOVEMENT", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");

    // 250m apart in 10s = 25 m/s (> 10 m/s threshold), both fixes in range.
    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({
        fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng, {
          spacingMs: 10_000,
          secondLat: offsetLatByMeters(LAUSANNE.lat, 250)
        })
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("IMPLAUSIBLE_MOVEMENT");
  });

  it("rejects accuracy above the threshold with 400 GPS_TOO_COARSE", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");

    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng, { accuracy: 200 }) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("GPS_TOO_COARSE");
  });

  it("rejects a stale fix (older than 60s) with 400 STALE_FIX", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");

    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng, { ageMs: 120_000 }) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("STALE_FIX");
  });

  it("keeps the hard GeoIP wall: in-range fixes from a mismatched IP get 403 GEO_MISMATCH", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const spoofer = await createUser("spoofer");

    // /nearby degrades on this pattern (see nearby.test.ts); /join must NOT —
    // a join asserts physical presence, and the GeoIP consistency check is
    // part of the proof. 8.8.8.8 geolocates to the US, ~6500 km from the
    // Lausanne fixes.
    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("X-Forwarded-For", "8.8.8.8")
      .set("Authorization", spoofer.auth)
      .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng) });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("GEO_MISMATCH");
    expect(await AroundMemberModel.countDocuments({ aroundId: around._id, userId: spoofer.user._id })).toBe(0);
  });

  it("refuses a kicked user with 403 KICKED", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");
    await AroundMemberModel.create({
      aroundId: around._id,
      userId: joiner.user._id,
      role: "member",
      status: "removed",
      joinFixes: [],
      suspicious: false,
      createdAt: new Date()
    });
    await AroundModel.updateOne({ _id: around._id }, { $addToSet: { kickedUserIds: joiner.user._id } });

    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng) });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("KICKED");
  });

  it("refuses a banned user with 403 USER_BANNED (checked in database)", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const banned = await createUser("badguy", { status: "banned" });

    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", banned.auth)
      .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng) });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("USER_BANNED");
  });

  it("returns 410 when the capture window is closed (join allowed during the whole window only)", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, {
      captureEndsAt: new Date(Date.now() - 60_000)
    });
    const joiner = await createUser("joiner");

    const res = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng) });

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("CAPTURE_WINDOW_CLOSED");
  });

  it("is idempotent for an existing member (no double count)", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");

    const first = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng) });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/arounds/${around._id}/join`)
      .set("Authorization", joiner.auth)
      .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng) });
    expect(second.status).toBe(200);
    expect(second.body.alreadyMember).toBe(true);

    const updated = await AroundModel.findById(around._id).lean();
    expect(updated?.memberCount).toBe(2);
    expect(await AroundMemberModel.countDocuments({ aroundId: around._id, userId: joiner.user._id })).toBe(1);
  });

  it("answers two concurrent joins with one 201 and one idempotent 200 (no duplicate row, no double count, no 500)", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);
    const joiner = await createUser("joiner");

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/arounds/${around._id}/join`)
        .set("Authorization", joiner.auth)
        .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng) }),
      request(app)
        .post(`/api/arounds/${around._id}/join`)
        .set("Authorization", joiner.auth)
        .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng) })
    ]);

    // Whichever interleaving happened (serialized read-then-create, or a real
    // E11000 duplicate-key race), one request wins with 201 and the other
    // gets the idempotent alreadyMember response — never a 500.
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    const already = first.status === 200 ? first : second;
    expect(already.body.alreadyMember).toBe(true);
    expect(already.body.member).toEqual({ role: "member", status: "active" });

    expect(await AroundMemberModel.countDocuments({ aroundId: around._id, userId: joiner.user._id })).toBe(1);
    const updated = await AroundModel.findById(around._id).lean();
    expect(updated?.memberCount).toBe(2);
  });

  it("returns 404 for an unknown around", async () => {
    const joiner = await createUser("joiner");
    const res = await request(app)
      .post("/api/arounds/64b000000000000000000000/join")
      .set("Authorization", joiner.auth)
      .send({ fixes: makeFixes(LAUSANNE.lat, LAUSANNE.lng) });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("AROUND_NOT_FOUND");
  });
});

describe("POST /api/arounds — duration bounds", () => {
  it("rejects a duration outside 1-6h with 400 INVALID_DURATION", async () => {
    const owner = await createUser("owner");

    const tooShort = await request(app)
      .post("/api/arounds")
      .set("Authorization", owner.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 10, radiusM: 100, durationH: 0.5 });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error).toBe("INVALID_DURATION");

    const tooLong = await request(app)
      .post("/api/arounds")
      .set("Authorization", owner.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 10, radiusM: 100, durationH: 7 });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe("INVALID_DURATION");
  });

  it("creates the around with a valid duration and defaults to 4h", async () => {
    const owner = await createUser("owner");

    const explicit = await request(app)
      .post("/api/arounds")
      .set("Authorization", owner.auth)
      .send({ name: "Party", lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 10, radiusM: 150, durationH: 2 });
    expect(explicit.status).toBe(201);
    expect(explicit.body.around.captureWindowMs).toBe(2 * 60 * 60 * 1000);
    expect(explicit.body.around.isOwner).toBe(true);

    const defaulted = await request(app)
      .post("/api/arounds")
      .set("Authorization", owner.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 10, radiusM: 150 });
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.around.captureWindowMs).toBe(4 * 60 * 60 * 1000);
  });

  it("enforces the 2 active arounds per owner cap", async () => {
    const owner = await createUser("owner");
    await createAroundFixture(owner.user._id);
    await createAroundFixture(owner.user._id);

    const res = await request(app)
      .post("/api/arounds")
      .set("Authorization", owner.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 10, radiusM: 100 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("MAX_ACTIVE_AROUNDS");
  });
});
