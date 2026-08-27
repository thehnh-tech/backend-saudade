import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
});

describe("rate limiting (429 RATE_LIMITED + Retry-After)", () => {
  it("caps POST /api/users/oauth at 10/h per IP", async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app).post("/api/users/oauth").send({});
      expect(res.status).toBe(400); // invalid input, but it counts
    }
    const eleventh = await request(app).post("/api/users/oauth").send({});
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error).toBe("RATE_LIMITED");
    expect(Number(eleventh.headers["retry-after"])).toBeGreaterThan(0);
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
