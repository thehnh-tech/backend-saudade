import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type FetchCall = { url: string; body: URLSearchParams };

function stubAppleFetch(response: { ok: boolean; status?: number } | Error) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { body?: string }) => {
    calls.push({ url: String(input), body: new URLSearchParams(init?.body ?? "") });
    if (response instanceof Error) throw response;
    return { ok: response.ok, status: response.status ?? (response.ok ? 200 : 400) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

// App Store Review 5.1.1(v): an app offering Sign in with Apple AND account
// deletion must revoke the user's Apple token when the account is deleted.
describe("DELETE /api/users/me — Sign in with Apple token revocation", () => {
  it("calls appleid.apple.com/auth/revoke with the stored refresh token, then deletes the account", async () => {
    const calls = stubAppleFetch({ ok: true });
    const account = await createUser("revoker");
    await AroundUserModel.updateOne(
      { _id: account.user._id },
      { $set: { appleRefreshToken: "apple-refresh-token-abc" } }
    );

    const res = await request(app).delete("/api/users/me").set("Authorization", account.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const revoke = calls.find((call) => call.url === "https://appleid.apple.com/auth/revoke");
    expect(revoke).toBeDefined();
    expect(revoke?.body.get("token")).toBe("apple-refresh-token-abc");
    expect(revoke?.body.get("token_type_hint")).toBe("refresh_token");
    expect(revoke?.body.get("client_id")).toBe("tech.thehnh.saudade");
    // The client_secret is a freshly signed ES256 assertion, never a raw key.
    expect(revoke?.body.get("client_secret")?.split(".")).toHaveLength(3);

    expect(await AroundUserModel.countDocuments({ _id: account.user._id })).toBe(0);
  });

  it("still deletes the account when Apple refuses the revocation (4xx)", async () => {
    stubAppleFetch({ ok: false, status: 400 });
    const account = await createUser("apple-4xx");
    await AroundUserModel.updateOne(
      { _id: account.user._id },
      { $set: { appleRefreshToken: "apple-refresh-token-def" } }
    );

    const res = await request(app).delete("/api/users/me").set("Authorization", account.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await AroundUserModel.countDocuments({ _id: account.user._id })).toBe(0);
  });

  it("still deletes the account when the call to Apple throws (network failure)", async () => {
    stubAppleFetch(new Error("fetch failed"));
    const account = await createUser("apple-down");
    await AroundUserModel.updateOne(
      { _id: account.user._id },
      { $set: { appleRefreshToken: "apple-refresh-token-ghi" } }
    );

    const res = await request(app).delete("/api/users/me").set("Authorization", account.auth);
    expect(res.status).toBe(200);
    expect(await AroundUserModel.countDocuments({ _id: account.user._id })).toBe(0);
  });

  it("deletes the account (and calls nothing) when no refresh token was ever captured", async () => {
    const calls = stubAppleFetch({ ok: true });
    const account = await createUser("no-token");

    const res = await request(app).delete("/api/users/me").set("Authorization", account.auth);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect(await AroundUserModel.countDocuments({ _id: account.user._id })).toBe(0);
  });

  it("never exposes the stored refresh token on the user endpoints", async () => {
    stubAppleFetch({ ok: true });
    const account = await createUser("secretive");
    await AroundUserModel.updateOne(
      { _id: account.user._id },
      { $set: { appleRefreshToken: "apple-refresh-token-secret" } }
    );

    const me = await request(app).get("/api/users/me").set("Authorization", account.auth);
    expect(me.status).toBe(200);
    expect(JSON.stringify(me.body)).not.toContain("apple-refresh-token-secret");
  });
});
