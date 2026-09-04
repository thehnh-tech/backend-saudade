import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { jwtVerifyMock } = vi.hoisted(() => ({ jwtVerifyMock: vi.fn() }));

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => vi.fn()),
    jwtVerify: jwtVerifyMock
  };
});
vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { resetUserCache } from "../src/around/middleware.js";
import { AroundUserModel, DevicePresenceModel } from "../src/around/models.js";
import { config } from "../src/config.js";
import { makeLegacyTestApp, makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import { LAUSANNE, createUser } from "./helpers/fixtures.js";

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
  jwtVerifyMock.mockReset();
});

describe("rate limiting (429 RATE_LIMITED + Retry-After)", () => {
  it("caps FAILED POST /api/users/oauth attempts at 30/h per IP", async () => {
    for (let i = 0; i < 30; i += 1) {
      const res = await request(app).post("/api/users/oauth").send({});
      expect(res.status).toBe(400); // invalid input, but it counts
    }
    const thirtyFirst = await request(app).post("/api/users/oauth").send({});
    expect(thirtyFirst.status).toBe(429);
    expect(thirtyFirst.body.error).toBe("RATE_LIMITED");
    expect(Number(thirtyFirst.headers["retry-after"])).toBeGreaterThan(0);
  });

  // The product scenario is a party: everyone shares the venue's NAT. A
  // successful sign-in (and the 409 steps of the two-call signup) must not
  // consume quota, otherwise the tenth guest locks the venue out.
  it("does not let successful sign-ups from one NAT exhaust the OAuth quota", async () => {
    for (let i = 0; i < 20; i += 1) {
      jwtVerifyMock.mockResolvedValue({
        payload: { sub: `apple-sub-nat-${i}`, aud: "tech.thehnh.saudade", iss: "https://appleid.apple.com" },
        protectedHeader: { alg: "RS256" }
      });

      // Step 1 of the signup flow: no pseudo yet -> 409 PSEUDO_REQUIRED.
      const first = await request(app)
        .post("/api/users/oauth")
        .send({ provider: "apple", identityToken: "apple-token" });
      expect(first.status).toBe(409);
      expect(first.body.error).toBe("PSEUDO_REQUIRED");

      // Step 2: same token plus a pseudo -> 201 created.
      const second = await request(app)
        .post("/api/users/oauth")
        .send({ provider: "apple", identityToken: "apple-token", pseudo: `guest${i}` });
      expect(second.status).toBe(201);
    }

    // 40 legitimate calls later the venue is still not throttled.
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: "apple-sub-nat-last", aud: "tech.thehnh.saudade", iss: "https://appleid.apple.com" },
      protectedHeader: { alg: "RS256" }
    });
    const late = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "lastguest" });
    expect(late.status).toBe(201);
  });

  // An IPv6 client is routinely handed a whole /64: keying on the full address
  // let it rotate through the subnet and bypass the limit entirely.
  it("buckets IPv6 sources by /64 so address rotation does not reset the quota", async () => {
    for (let i = 0; i < 30; i += 1) {
      const res = await request(app)
        .post("/api/users/oauth")
        .set("X-Forwarded-For", `2001:db8:1:2::${i + 1}`)
        .send({});
      expect(res.status).toBe(400);
    }

    const rotated = await request(app)
      .post("/api/users/oauth")
      .set("X-Forwarded-For", "2001:db8:1:2::ffff")
      .send({});
    expect(rotated.status).toBe(429);

    // A genuinely different /64 is untouched.
    const otherSubnet = await request(app)
      .post("/api/users/oauth")
      .set("X-Forwarded-For", "2001:db8:1:3::1")
      .send({});
    expect(otherSubnet.status).toBe(400);
  });

  it("caps POST /api/users/me/location at 1 per 30s per user", async () => {
    const alice = await createUser("alice");
    await AroundUserModel.updateOne({ _id: alice.user._id }, { $set: { radarEnabled: true, radarConsentAt: new Date() } });

    const first = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", alice.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 15 });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", alice.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 15 });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("RATE_LIMITED");
    expect(second.headers["retry-after"]).toBeDefined();

    // Another user is not affected (per-user key).
    const bob = await createUser("bob");
    await AroundUserModel.updateOne({ _id: bob.user._id }, { $set: { radarEnabled: true } });
    resetUserCache();
    const bobRes = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", bob.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 15 });
    expect(bobRes.status).toBe(200);
  });

  it("stores a bounded client capturedAt (and its source), falls back to receipt time outside the bounds", async () => {
    const alice = await createUser("alice");
    await AroundUserModel.updateOne({ _id: alice.user._id }, { $set: { radarEnabled: true } });

    // In bounds: a background batch iOS delivered 5 min late keeps its own
    // timestamp instead of being stamped fresher than it is.
    const claimed = new Date(Date.now() - 5 * 60_000);
    const inBounds = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", alice.auth)
      .send({
        lat: LAUSANNE.lat,
        lng: LAUSANNE.lng,
        accuracy: 15,
        capturedAt: claimed.toISOString(),
        source: "background"
      });
    expect(inBounds.status).toBe(200);
    let presence = await DevicePresenceModel.findOne({ userId: alice.user._id }).lean();
    expect(presence?.capturedAt.getTime()).toBe(claimed.getTime());
    expect(presence?.source).toBe("background");
    // updatedAt (the TTL clock) is always server-stamped.
    expect(presence?.updatedAt.getTime()).toBeGreaterThan(claimed.getTime());

    // Out of bounds (a clock an hour ahead): fall back to receipt time,
    // never a rejection — a skewed clock must not make a phone invisible.
    resetAroundRateLimits();
    const before = Date.now();
    const future = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", alice.auth)
      .send({
        lat: LAUSANNE.lat,
        lng: LAUSANNE.lng,
        accuracy: 15,
        capturedAt: new Date(Date.now() + 60 * 60_000).toISOString()
      });
    expect(future.status).toBe(200);
    presence = await DevicePresenceModel.findOne({ userId: alice.user._id }).lean();
    expect(presence!.capturedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(presence!.capturedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("degrades an unparseable capturedAt to receipt time instead of rejecting the post", async () => {
    const alice = await createUser("alice");
    await AroundUserModel.updateOne({ _id: alice.user._id }, { $set: { radarEnabled: true } });
    const before = Date.now();
    const res = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", alice.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 15, capturedAt: "not-a-date" });
    expect(res.status).toBe(200);
    const presence = await DevicePresenceModel.findOne({ userId: alice.user._id }).lean();
    expect(presence!.capturedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("refuses the retired significant-change source (400)", async () => {
    const alice = await createUser("alice");
    await AroundUserModel.updateOne({ _id: alice.user._id }, { $set: { radarEnabled: true } });
    const res = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", alice.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 15, source: "significant-change" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_INPUT");
  });

  it("refuses location updates when Radar is off (403 RADAR_DISABLED)", async () => {
    const alice = await createUser("alice");
    const res = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", alice.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 15 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("RADAR_DISABLED");
  });
});

// Two app instances over the same database ARE two warm lambdas: the shared
// store (sharedRateLimit.ts) must make budgets and lockouts hold across them,
// where the in-memory limiters used to hand each instance its own.
describe("shared limiter store — cross-instance", () => {
  it("shares the admin-login window AND lockout across instances", async () => {
    const appA = await makeLegacyTestApp();
    const appB = await makeLegacyTestApp();

    // Pin Date to the window start so the request run cannot straddle a
    // fixed-window boundary (only Date is faked; timers and Mongo are real).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000));

    for (let i = 0; i < 5; i += 1) {
      const res = await request(appA).post("/api/admin/login").send({ login: "admin", password: `wrong-${i}` });
      expect(res.status).toBe(401);
    }

    // Sixth attempt on the OTHER instance: the window budget is shared.
    const sixth = await request(appB).post("/api/admin/login").send({ login: "admin", password: "wrong-5" });
    expect(sixth.status).toBe(429);

    // The lockout armed by the 5 consecutive 401s holds there too, even with
    // the right credentials.
    const withCreds = await request(appB)
      .post("/api/admin/login")
      .send({ login: config.adminLogin, password: config.adminPassword });
    expect(withCreds.status).toBe(429);

    vi.useRealTimers();
  });

  it("counts concurrent hits atomically across instances (upsert race, no 500s)", async () => {
    const appA = await makeLegacyTestApp();
    const appB = await makeLegacyTestApp();

    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(i % 2 === 0 ? appA : appB)
          .post("/api/admin/login")
          .send({ login: "admin", password: `w-${i}` })
      )
    );
    const statuses = attempts.map((res) => res.status);
    for (const status of statuses) expect([401, 429]).toContain(status);
    // Fixed window of 5: the atomic $inc admits exactly five, whichever
    // instance they landed on — a lost increment or a 500 on the racing
    // first upsert would break the split.
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(3);
  });
});
