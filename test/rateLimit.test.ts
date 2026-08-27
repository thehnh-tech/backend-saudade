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
import { AroundUserModel } from "../src/around/models.js";
import { makeTestApp } from "./helpers/app.js";
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
