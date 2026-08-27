import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { resetUserCache } from "../src/around/middleware.js";
import { AroundDeviceModel } from "../src/around/models.js";
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

describe("PUT /api/users/me/devices — push token ownership", () => {
  it("refuses to steal a token bound to another user AND another installation", async () => {
    const alice = await createUser("alice");
    const mallory = await createUser("mallory");

    const registered = await request(app)
      .put("/api/users/me/devices")
      .set("Authorization", alice.auth)
      .send({ installationId: "install-alice", expoPushToken: "ExponentPushToken[alice]" });
    expect(registered.status).toBe(200);
    expect(registered.body.device.hasPushToken).toBe(true);

    const theft = await request(app)
      .put("/api/users/me/devices")
      .set("Authorization", mallory.auth)
      .send({ installationId: "install-mallory", expoPushToken: "ExponentPushToken[alice]" });
    expect(theft.status).toBe(409);
    expect(theft.body.error).toBe("PUSH_TOKEN_CONFLICT");

    // Alice keeps her token and her row stays valid: her notifications are
    // still delivered to her own device.
    const aliceDevice = await AroundDeviceModel.findOne({ userId: alice.user._id, installationId: "install-alice" }).lean();
    expect(aliceDevice?.expoPushToken).toBe("ExponentPushToken[alice]");
    expect(aliceDevice?.invalidatedAt ?? null).toBeNull();

    // Mallory has no device row carrying the token.
    const stolen = await AroundDeviceModel.countDocuments({
      userId: mallory.user._id,
      expoPushToken: "ExponentPushToken[alice]"
    });
    expect(stolen).toBe(0);
  });

  it("still allows the same user to re-register the token on a new installation (reinstall)", async () => {
    const alice = await createUser("alice");

    await request(app)
      .put("/api/users/me/devices")
      .set("Authorization", alice.auth)
      .send({ installationId: "install-old", expoPushToken: "ExponentPushToken[alice]" });

    const reinstall = await request(app)
      .put("/api/users/me/devices")
      .set("Authorization", alice.auth)
      .send({ installationId: "install-new", expoPushToken: "ExponentPushToken[alice]" });
    expect(reinstall.status).toBe(200);
    expect(reinstall.body.device.hasPushToken).toBe(true);

    const old = await AroundDeviceModel.findOne({ userId: alice.user._id, installationId: "install-old" }).lean();
    expect(old?.expoPushToken ?? null).toBeNull();
  });

  it("still allows another account to take over the token on the SAME device", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");

    await request(app)
      .put("/api/users/me/devices")
      .set("Authorization", alice.auth)
      .send({ installationId: "install-shared", expoPushToken: "ExponentPushToken[shared]" });

    const handover = await request(app)
      .put("/api/users/me/devices")
      .set("Authorization", bob.auth)
      .send({ installationId: "install-shared", expoPushToken: "ExponentPushToken[shared]" });
    expect(handover.status).toBe(200);
    expect(handover.body.device.hasPushToken).toBe(true);

    const aliceRow = await AroundDeviceModel.findOne({ userId: alice.user._id, installationId: "install-shared" }).lean();
    expect(aliceRow?.expoPushToken ?? null).toBeNull();
  });
});
