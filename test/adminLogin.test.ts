import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { config } from "../src/config.js";
import { makeLegacyTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";

// POST /api/admin/login is the single door to the whole moderation surface
// (clear URLs of every reported photo, ban, purge) and it is guarded by one
// static shared password. These tests pin the throttle that keeps a bruteforce
// from being free. The handler itself only compares strings, but the limiter
// and lockout live in the shared Mongo store (sharedRateLimit.ts) so warm
// lambdas cannot each hand out their own budget — hence the database here.
let app: Express;

beforeAll(async () => {
  await setupTestDb();
  app = await makeLegacyTestApp();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  vi.useRealTimers();
  await clearCollections();
  resetAroundRateLimits();
});

/** Pins Date to the current fixed window's start: a request loop can then
 * never straddle a boundary and split its count over two windows. Only Date
 * is faked — timers and Mongo stay real. */
function pinToWindowStart(windowMs: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Math.floor(Date.now() / windowMs) * windowMs);
}

describe("POST /api/admin/login throttling", () => {
  it("caps failed attempts at 5 per 15 min per IP (6th is 429 RATE_LIMITED)", async () => {
    pinToWindowStart(15 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post("/api/admin/login").send({ login: "admin", password: `wrong-${i}` });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("INVALID_CREDENTIALS");
    }

    const sixth = await request(app).post("/api/admin/login").send({ login: "admin", password: "wrong-5" });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe("RATE_LIMITED");
    expect(Number(sixth.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("keeps throttling a locked-out IP even with correct credentials", async () => {
    pinToWindowStart(15 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) {
      await request(app).post("/api/admin/login").send({ login: "admin", password: `wrong-${i}` });
    }

    // The progressive lockout is armed by the 5 consecutive 401s, so the
    // window limiter expiring would not immediately reopen the door.
    const afterLockout = await request(app)
      .post("/api/admin/login")
      .send({ login: config.adminLogin, password: config.adminPassword });
    expect(afterLockout.status).toBe(429);
  });

  it("arms the lockout across window boundaries — the 429 above is not just the window", async () => {
    // Within one window the 5/15min budget always masks the lockout (the 6th
    // request exceeds both). Split the 5 consecutive 401s over TWO windows:
    // the second window's count stays under budget, so the 429 on the
    // right-password attempt can only come from the lockout itself.
    pinToWindowStart(15 * 60 * 1000);
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post("/api/admin/login").send({ login: "admin", password: `wrong-${i}` });
      expect(res.status).toBe(401);
    }

    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    for (let i = 3; i < 5; i += 1) {
      const res = await request(app).post("/api/admin/login").send({ login: "admin", password: `wrong-${i}` });
      expect(res.status).toBe(401);
    }

    const locked = await request(app)
      .post("/api/admin/login")
      .send({ login: config.adminLogin, password: config.adminPassword });
    expect(locked.status).toBe(429);
    // 5 min lock, well under the fresh window's remaining budget: only the
    // lockout can have produced it.
    expect(Number(locked.headers["retry-after"])).toBeLessThanOrEqual(5 * 60);
  });

  it("still accepts valid credentials on an unthrottled IP", async () => {
    const res = await request(app)
      .post("/api/admin/login")
      .send({ login: config.adminLogin, password: config.adminPassword });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("admin");
    expect(typeof res.body.token).toBe("string");
  });

  it("rejects a password of the right length but wrong value (constant-time compare)", async () => {
    const sameLengthWrong = "x".repeat(config.adminPassword.length);
    const res = await request(app)
      .post("/api/admin/login")
      .send({ login: config.adminLogin, password: sameLengthWrong });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("INVALID_CREDENTIALS");
  });

  it("does not let a malformed body (400) arm the lockout", async () => {
    for (let i = 0; i < 4; i += 1) {
      const res = await request(app).post("/api/admin/login").send({});
      expect(res.status).toBe(400);
    }
    // 4 x 400 consumed 4 window slots but no failure counter: the 5th call
    // with valid credentials must still succeed.
    const res = await request(app)
      .post("/api/admin/login")
      .send({ login: config.adminLogin, password: config.adminPassword });
    expect(res.status).toBe(200);
  });
});
