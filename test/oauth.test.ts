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
  jwtVerifyMock.mockReset();
});

function mockIdentity(payload: Record<string, unknown>) {
  jwtVerifyMock.mockResolvedValue({ payload, protectedHeader: { alg: "RS256" } });
}

describe("POST /api/users/oauth", () => {
  it("rejects an invalid identity token with 401 INVALID_IDENTITY_TOKEN", async () => {
    jwtVerifyMock.mockRejectedValue(new Error("signature verification failed"));
    const res = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "not-a-valid-token" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("INVALID_IDENTITY_TOKEN");
  });

  it("returns 503 OAUTH_PROVIDER_UNAVAILABLE when the JWKS is unreachable", async () => {
    jwtVerifyMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "google", identityToken: "whatever-token" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("OAUTH_PROVIDER_UNAVAILABLE");
  });

  it("requires a pseudo for a new account (PSEUDO_REQUIRED, 2-call flow)", async () => {
    mockIdentity({ sub: "apple-new-sub" });
    const first = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token" });
    expect(first.status).toBe(409);
    expect(first.body.error).toBe("PSEUDO_REQUIRED");

    const second = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "NightOwl" });
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(true);
    expect(second.body.token).toBeTruthy();
    expect(second.body.user.pseudo).toBe("NightOwl");
    // Email is never exposed.
    expect(second.body.user.email).toBeUndefined();

    // The issued JWT works on a user route.
    const me = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${second.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.pseudo).toBe("NightOwl");
  });

  it("lets a new account carry a public name that already exists", async () => {
    // Names are display-only since 2026-08-30: identity is the userId, so two
    // people can both be NightOwl.
    await createUser("nightowl");
    mockIdentity({ sub: "apple-other-sub" });
    const res = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "NightOwl" });
    expect(res.status).toBe(201);
    expect(res.body.user.pseudo).toBe("NightOwl");
    expect(await AroundUserModel.countDocuments({ pseudoLower: "nightowl" })).toBe(2);
  });

  it("logs an existing user back in by (provider, sub)", async () => {
    mockIdentity({ sub: "apple-sub-1" });
    const created = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "returning" });
    expect(created.status).toBe(201);

    const again = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token" });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.user.id).toBe(created.body.user.id);
  });

  it("REFUSES to link a second provider on a verified-email match (409 EMAIL_ALREADY_LINKED, no token issued)", async () => {
    mockIdentity({ sub: "apple-sub-x", email: "Party@Example.com", email_verified: "true" });
    const appleRes = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "partygoer" });
    expect(appleRes.status).toBe(201);

    // A verified e-mail only proves control of the mailbox now, not identity:
    // it must never authenticate into somebody else's account.
    mockIdentity({ sub: "google-sub-y", email: "party@example.com", email_verified: true });
    const googleRes = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "google", identityToken: "google-token" });
    expect(googleRes.status).toBe(409);
    expect(googleRes.body.error).toBe("EMAIL_ALREADY_LINKED");
    expect(googleRes.body.token).toBeUndefined();

    // The victim account is untouched: no googleSub written, no duplicate.
    const victim = await AroundUserModel.findById(appleRes.body.user.id).lean();
    expect(victim?.googleSub).toBeUndefined();
    expect(await AroundUserModel.countDocuments()).toBe(1);
  });

  it("refuses the takeover even when a pseudo is supplied (the 409 is not a signup prompt)", async () => {
    mockIdentity({ sub: "apple-sub-victim", email: "victim@example.com", email_verified: "true" });
    const victimRes = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "victim" });
    expect(victimRes.status).toBe(201);

    mockIdentity({ sub: "google-sub-attacker", email: "victim@example.com", email_verified: true });
    const attacker = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "google", identityToken: "google-token", pseudo: "attacker" });
    expect(attacker.status).toBe(409);
    expect(attacker.body.error).toBe("EMAIL_ALREADY_LINKED");
    expect(await AroundUserModel.countDocuments()).toBe(1);
  });

  it("ignores an UNVERIFIED email (no account linking)", async () => {
    mockIdentity({ sub: "apple-sub-x", email: "linked@example.com", email_verified: "true" });
    await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "first" });

    mockIdentity({ sub: "google-sub-z", email: "linked@example.com", email_verified: false });
    const res = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "google", identityToken: "google-token" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("PSEUDO_REQUIRED");
  });

  it("refuses a banned account at login", async () => {
    await createUser("banned-guy", { status: "banned", appleSub: "apple-banned-sub" });
    mockIdentity({ sub: "apple-banned-sub" });
    const res = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("USER_BANNED");
  });

  it("rejects an invalid pseudo format", async () => {
    mockIdentity({ sub: "apple-sub-invalid" });
    const res = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_PSEUDO");
  });
});
