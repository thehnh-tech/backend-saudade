import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { v2 as cloudinary } from "cloudinary";
import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { runAroundPurgeTick } from "../src/around/jobs.js";
import { resetUserCache } from "../src/around/middleware.js";
import {
  AroundDeviceModel,
  AroundMemberModel,
  AroundModel,
  AroundPhotoModel,
  AroundReportModel,
  AroundUserModel,
  DevicePresenceModel
} from "../src/around/models.js";
import { makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import { addMember, adminAuth, createAroundFixture, createPhotoFixture, createUser } from "./helpers/fixtures.js";

const app = makeTestApp();
const destroyMock = cloudinary.uploader.destroy as unknown as ReturnType<typeof vi.fn>;

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
  destroyMock.mockClear();
  destroyMock.mockImplementation(async () => ({ result: "ok" }));
});

describe("J+7 purge job (Cloudinary first)", () => {
  it("destroys rear AND front on Cloudinary before deleting the Mongo docs", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, {
      status: "closed",
      captureEndsAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 60_000)
    });
    const photo = await createPhotoFixture(around._id, owner.user._id, { status: "approved" });

    await runAroundPurgeTick();

    const destroyedIds = destroyMock.mock.calls.map((call) => call[0]);
    expect(destroyedIds).toContain(photo.rearPublicId);
    expect(destroyedIds).toContain(photo.frontPublicId);
    for (const call of destroyMock.mock.calls) {
      expect(call[1]).toMatchObject({ type: "authenticated", invalidate: true });
    }

    expect(await AroundPhotoModel.countDocuments({ aroundId: around._id })).toBe(0);
    expect(await AroundMemberModel.countDocuments({ aroundId: around._id })).toBe(0);
    const purged = await AroundModel.findById(around._id).lean();
    expect(purged?.status).toBe("purged");
  });

  it("resumes after a partial Cloudinary failure (purgeState-driven retry)", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, {
      status: "closed",
      expiresAt: new Date(Date.now() - 60_000)
    });
    const photo = await createPhotoFixture(around._id, owner.user._id, { status: "approved" });

    // First run: rear destroy succeeds, front destroy fails -> the photo doc
    // must survive with purgeState still "live" and the around stays purging.
    destroyMock.mockImplementation(async (publicId: string) => {
      if (publicId === photo.frontPublicId) throw new Error("cloudinary down");
      return { result: "ok" };
    });
    await runAroundPurgeTick();

    let stored = await AroundPhotoModel.findById(photo._id).lean();
    expect(stored).not.toBeNull();
    expect(stored?.purgeState).toBe("live");
    let storedAround = await AroundModel.findById(around._id).lean();
    expect(storedAround?.status).toBe("purging");

    // Second run: Cloudinary is back. Both assets destroyed (rear retried,
    // destroy is idempotent) and everything is purged.
    destroyMock.mockImplementation(async () => ({ result: "ok" }));
    await runAroundPurgeTick();

    stored = await AroundPhotoModel.findById(photo._id).lean();
    expect(stored).toBeNull();
    storedAround = await AroundModel.findById(around._id).lean();
    expect(storedAround?.status).toBe("purged");
    expect(await AroundReportModel.countDocuments({ aroundId: around._id })).toBe(0);
  });
});

describe("admin moderation delete (same destroy primitives)", () => {
  it("destroys assets, marks removed_by_moderation and actions the linked reports", async () => {
    const owner = await createUser("owner");
    const alice = await createUser("alice");
    const around = await createAroundFixture(owner.user._id);
    await addMember(around._id, alice.user._id);
    const photo = await createPhotoFixture(around._id, alice.user._id, { status: "pending" });
    await AroundReportModel.create({
      targetType: "photo",
      targetId: photo._id,
      aroundId: around._id,
      reporterId: owner.user._id,
      reason: "nudity",
      status: "open",
      createdAt: new Date()
    });

    const res = await request(app)
      .delete(`/api/admin/around/photos/${photo._id}`)
      .set("Authorization", adminAuth());
    expect(res.status).toBe(200);

    const destroyedIds = destroyMock.mock.calls.map((call) => call[0]);
    expect(destroyedIds).toContain(photo.rearPublicId);
    expect(destroyedIds).toContain(photo.frontPublicId);

    const stored = await AroundPhotoModel.findById(photo._id).lean();
    expect(stored?.status).toBe("removed_by_moderation");
    expect(stored?.purgeState).toBe("cloudinary_deleted");

    const report = await AroundReportModel.findOne({ targetId: photo._id }).lean();
    expect(report?.status).toBe("actioned");

    // Invisible in the member feed, including for the uploader.
    const feed = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", alice.auth);
    expect(feed.body.photos).toHaveLength(0);
  });
});

describe("account deletion cascade (App Store 5.1.1(v))", () => {
  it("destroys the user's photos Cloudinary-first and cascades devices/presence/memberships", async () => {
    const owner = await createUser("owner");
    const alice = await createUser("alice");
    const around = await createAroundFixture(owner.user._id);
    await addMember(around._id, alice.user._id);
    const photo = await createPhotoFixture(around._id, alice.user._id, { status: "approved" });
    await AroundDeviceModel.create({
      userId: alice.user._id,
      installationId: "install-1",
      expoPushToken: "ExponentPushToken[alice]",
      pushEnabled: true,
      lastActiveAt: new Date()
    });
    await DevicePresenceModel.create({
      userId: alice.user._id,
      location: { type: "Point", coordinates: [6.6323, 46.5197] },
      accuracy: 10,
      capturedAt: new Date(),
      updatedAt: new Date(),
      source: "foreground"
    });

    const res = await request(app).delete("/api/users/me").set("Authorization", alice.auth);
    expect(res.status).toBe(200);

    const destroyedIds = destroyMock.mock.calls.map((call) => call[0]);
    expect(destroyedIds).toContain(photo.rearPublicId);
    expect(destroyedIds).toContain(photo.frontPublicId);

    expect(await AroundPhotoModel.countDocuments({ uploaderId: alice.user._id })).toBe(0);
    expect(await AroundDeviceModel.countDocuments({ userId: alice.user._id })).toBe(0);
    expect(await DevicePresenceModel.countDocuments({ userId: alice.user._id })).toBe(0);
    expect(await AroundUserModel.countDocuments({ _id: alice.user._id })).toBe(0);

    const membership = await AroundMemberModel.findOne({ aroundId: around._id, userId: alice.user._id }).lean();
    expect(membership?.status).toBe("left");
    expect(membership?.joinFixes).toHaveLength(0);
    expect(membership?.joinIp).toBeNull();

    // The dead token is rejected afterwards.
    const me = await request(app).get("/api/users/me").set("Authorization", alice.auth);
    expect(me.status).toBe(401);
  });

  it("closes the arounds owned by a deleted user", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id);

    const res = await request(app).delete("/api/users/me").set("Authorization", owner.auth);
    expect(res.status).toBe(200);

    const stored = await AroundModel.findById(around._id).lean();
    expect(stored?.status).toBe("closed");
  });
});
