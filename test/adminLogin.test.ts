import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { config } from "../src/config.js";
import { makeLegacyTestApp } from "./helpers/app.js";

// POST /api/admin/login is the single door to the whole moderation surface
// (clear URLs of every reported photo, ban, purge) and it is guarded by one
// static shared password. These tests pin the throttle that keeps a bruteforce
// from being free. No database is involved: the handler only compares strings.
let app: Express;

beforeAll(async () => {
  app = await makeLegacyTestApp();
});

beforeEach(() => {
  resetAroundRateLimits();
});

describe("POST /api/admin/login throttling", () => {
  it("caps failed attempts at 5 per 15 min per IP (6th is 429 RATE_LIMITED)", async () => {
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
