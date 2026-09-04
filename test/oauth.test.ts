import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";

type FetchCall = { url: string; body: URLSearchParams };

// Same shape as appleRevoke.test.ts's stub, extended with .json(): the code
// exchange reads the response body, the revoke call never does.
function stubAppleTokenFetch(response: { ok: boolean; status?: number; refreshToken?: string } | Error) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    calls.push({ url: String(input), body: new URLSearchParams(init?.body ?? "") });
    if (response instanceof Error) throw response;
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 400),
      json: async () => ({ refresh_token: response.refreshToken ?? "apple-rt-1" })
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

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

// App Store 5.1.1(v): the authorization code from the native sheet is what
// buys the refresh_token needed to revoke the grant at account deletion.
describe("POST /api/users/oauth — Apple authorization code exchange", () => {
  it("exchanges the code on the signup call and stores the refresh token", async () => {
    const calls = stubAppleTokenFetch({ ok: true, refreshToken: "apple-rt-signup" });
    mockIdentity({ sub: "apple-sub-code" });

    const res = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "coded", authorizationCode: "auth-code-123456" });
    expect(res.status).toBe(201);

    const exchange = calls.find((call) => call.url === APPLE_TOKEN_URL);
    expect(exchange).toBeDefined();
    expect(exchange?.body.get("grant_type")).toBe("authorization_code");
    expect(exchange?.body.get("code")).toBe("auth-code-123456");
    expect(exchange?.body.get("client_id")).toBe("tech.thehnh.saudade");
    // The client_secret is a freshly signed ES256 assertion, never a raw key.
    expect(exchange?.body.get("client_secret")?.split(".")).toHaveLength(3);

    const stored = await AroundUserModel.findById(res.body.user.id).select("+appleRefreshToken").lean();
    expect(stored?.appleRefreshToken).toBe("apple-rt-signup");
  });

  it("never burns the single-use code on the PSEUDO_REQUIRED first call", async () => {
    const calls = stubAppleTokenFetch({ ok: true });
    mockIdentity({ sub: "apple-sub-first-call" });

    const first = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", authorizationCode: "auth-code-123456" });
    expect(first.status).toBe(409);
    expect(first.body.error).toBe("PSEUDO_REQUIRED");
    expect(calls.filter((call) => call.url === APPLE_TOKEN_URL)).toHaveLength(0);
  });

  it("never burns the code on a pre-create refusal either (EMAIL_ALREADY_LINKED)", async () => {
    const calls = stubAppleTokenFetch({ ok: true });
    // First account claims the address, WITHOUT a code (no exchange).
    mockIdentity({ sub: "apple-sub-linked", email: "linked-code@example.com", email_verified: "true" });
    const first = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "firstowner" });
    expect(first.status).toBe(201);

    // A second APPLE identity on the same address: refused BEFORE the create,
    // so the exchange — which only runs after a successful create — must not
    // have consumed this retryable single-use code.
    mockIdentity({ sub: "apple-sub-linked-2", email: "linked-code@example.com", email_verified: "true" });
    const clash = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "secondowner", authorizationCode: "auth-code-999999" });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe("EMAIL_ALREADY_LINKED");
    expect(calls.filter((call) => call.url === APPLE_TOKEN_URL)).toHaveLength(0);
  });

  it("still answers 201 when the exchange fails — signup is never blocked", async () => {
    stubAppleTokenFetch({ ok: false, status: 400 });
    mockIdentity({ sub: "apple-sub-fail" });

    const res = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "unlucky", authorizationCode: "auth-code-123456" });
    expect(res.status).toBe(201);

    const stored = await AroundUserModel.findById(res.body.user.id).select("+appleRefreshToken").lean();
    expect(stored).not.toBeNull();
    expect(stored?.appleRefreshToken ?? null).toBeNull();
  });

  it("captures a fresh token at login for an account that has none", async () => {
    stubAppleTokenFetch({ ok: true, refreshToken: "apple-rt-login" });
    await createUser("tokenless", { appleSub: "apple-sub-tokenless" });
    mockIdentity({ sub: "apple-sub-tokenless" });

    const res = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", authorizationCode: "auth-code-654321" });
    expect(res.status).toBe(200);

    const stored = await AroundUserModel.findOne({ appleSub: "apple-sub-tokenless" }).select("+appleRefreshToken").lean();
    expect(stored?.appleRefreshToken).toBe("apple-rt-login");
  });

  it("keeps the stored token when a later exchange fails (no clobber)", async () => {
    stubAppleTokenFetch({ ok: false, status: 400 });
    const account = await createUser("keeper", { appleSub: "apple-sub-keeper" });
    await AroundUserModel.updateOne(
      { _id: account.user._id },
      { $set: { appleRefreshToken: "apple-rt-kept" } }
    );
    mockIdentity({ sub: "apple-sub-keeper" });

    const res = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", authorizationCode: "auth-code-654321" });
    expect(res.status).toBe(200);

    const stored = await AroundUserModel.findById(account.user._id).select("+appleRefreshToken").lean();
    expect(stored?.appleRefreshToken).toBe("apple-rt-kept");
  });
});
