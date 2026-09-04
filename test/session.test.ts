import request from "supertest";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { signAuth } from "../src/auth.js";
import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { resetUserCache } from "../src/around/middleware.js";
import { config } from "../src/config.js";
import { makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import { createUser } from "./helpers/fixtures.js";

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

const DAY_S = 24 * 60 * 60;

function tokenIssuedAgo(userId: string, ageS: number, sat?: number) {
  const iat = Math.floor(Date.now() / 1000) - ageS;
  // jsonwebtoken keeps a caller-provided iat; exp is computed from it.
  return `Bearer ${signAuth({ role: "user", userId, iat, ...(sat !== undefined ? { sat } : {}) }, { expiresIn: "7d" })}`;
}

describe("sliding session — X-Session-Token", () => {
  it("renews a token older than SESSION_RENEW_AFTER_MS and keeps the lineage", async () => {
    const { id } = await createUser("renew");
    const sat = Math.floor(Date.now() / 1000) - 3 * DAY_S;
    const res = await request(app)
      .get("/api/arounds/mine")
      .set("Authorization", tokenIssuedAgo(id, 2 * DAY_S, sat));
    expect(res.status).toBe(200);
    const renewed = res.headers["x-session-token"];
    expect(typeof renewed).toBe("string");
    const payload = jwt.verify(renewed, config.jwtSecret, { algorithms: ["HS256"] }) as Record<string, unknown>;
    expect(payload.userId).toBe(id);
    expect(payload.role).toBe("user");
    expect(payload.sat).toBe(sat);
    expect(Number(payload.exp) - Number(payload.iat)).toBe(7 * DAY_S);
  });

  it("starts the lineage at iat for a pre-v1.1 token without sat", async () => {
    const { id } = await createUser("legacy");
    const res = await request(app)
      .get("/api/arounds/mine")
      .set("Authorization", tokenIssuedAgo(id, 2 * DAY_S));
    expect(res.status).toBe(200);
    const payload = jwt.verify(res.headers["x-session-token"], config.jwtSecret) as Record<string, unknown>;
    expect(typeof payload.sat).toBe("number");
    expect(Number(payload.sat)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) - 2 * DAY_S);
  });

  it("does not renew a fresh token", async () => {
    const { id } = await createUser("fresh");
    const res = await request(app)
      .get("/api/arounds/mine")
      .set("Authorization", tokenIssuedAgo(id, 60));
    expect(res.status).toBe(200);
    expect(res.headers["x-session-token"]).toBeUndefined();
  });

  it("does not renew past the lineage cap", async () => {
    const { id } = await createUser("old-lineage");
    const sat = Math.floor(Date.now() / 1000) - 200 * DAY_S;
    const res = await request(app)
      .get("/api/arounds/mine")
      .set("Authorization", tokenIssuedAgo(id, 2 * DAY_S, sat));
    expect(res.status).toBe(200);
    expect(res.headers["x-session-token"]).toBeUndefined();
  });

  it("never renews for a banned account (the request is refused first)", async () => {
    const { id } = await createUser("banned", { status: "banned" });
    const res = await request(app)
      .get("/api/arounds/mine")
      .set("Authorization", tokenIssuedAgo(id, 2 * DAY_S));
    expect(res.status).toBe(403);
    expect(res.headers["x-session-token"]).toBeUndefined();
  });
});
