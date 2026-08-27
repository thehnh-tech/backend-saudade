import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { resetUserCache } from "../src/around/middleware.js";
import { makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import { LAUSANNE, addMember, createAroundFixture, createUser } from "./helpers/fixtures.js";

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
    expect(typeof notJoined.distanceM).toBe("number");

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

  it("caps GET /api/arounds/nearby at 15/min per user (429 RATE_LIMITED + Retry-After)", async () => {
    const owner = await createUser("owner");
    await createAroundFixture(owner.user._id);
    const walker = await createUser("walker");

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
  });
});
