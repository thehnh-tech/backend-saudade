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
  AroundReservedPseudoModel,
  AroundRingModel,
  AroundUserModel,
  DevicePresenceModel,
  ModerationActionModel
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
    const kicked = await createUser("kicked");
    const around = await createAroundFixture(owner.user._id, {
      status: "closed",
      captureEndsAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 60_000),
      kickedUserIds: [kicked.user._id]
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
    // Privacy erasure: the kept doc is counters and dates only — no centre
    // (the owner's exact position), no name, no member list.
    expect(purged?.center).toBeUndefined();
    expect(purged?.name).toBeNull();
    expect(purged?.kickedUserIds).toEqual([]);
    expect(purged?.memberCount).toBe(1);
  });

  it("legacy sweep: erases coordinates from docs written before the strip-at-write change", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, { status: "purged" });
    // Old-shape docs bypass the current schema via the raw collections.
    await AroundModel.collection.updateOne(
      { _id: around._id },
      { $set: { center: { type: "Point", coordinates: [6.63, 46.52] }, name: "Vieux nom", kickedUserIds: [owner.user._id] } }
    );
    await AroundMemberModel.collection.updateOne(
      { aroundId: around._id, userId: owner.user._id },
      {
        $set: {
          joinIp: "1.2.3.4",
          joinGeo: { city: "Lausanne" },
          joinFixes: [{ lat: 46.52, lng: 6.63, accuracy: 5, capturedAt: new Date(), distanceM: 12 }]
        }
      }
    );

    await runAroundPurgeTick();

    const storedAround = await AroundModel.findById(around._id).lean();
    expect(storedAround?.center).toBeUndefined();
    expect(storedAround?.name).toBeNull();
    expect(storedAround?.kickedUserIds).toEqual([]);

    const member = await AroundMemberModel.collection.findOne({ aroundId: around._id });
    expect(member).not.toBeNull();
    expect(member).not.toHaveProperty("joinIp");
    expect(member).not.toHaveProperty("joinGeo");
    expect(member?.joinFixes[0]).not.toHaveProperty("lat");
    expect(member?.joinFixes[0]).not.toHaveProperty("lng");
    expect(member?.joinFixes[0]).toMatchObject({ accuracy: 5, distanceM: 12 });
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
    // A ring claim carries the user's id and lives 8 days on its own TTL:
    // erasure has to take it, or a deleted account leaves a trace behind.
    await AroundRingModel.create({
      aroundId: around._id,
      userId: alice.user._id,
      kind: "created",
      claimedAt: new Date(),
      sentAt: new Date(),
      ticketIds: ["ticket-alice"]
    });

    const res = await request(app).delete("/api/users/me").set("Authorization", alice.auth);
    expect(res.status).toBe(200);

    const destroyedIds = destroyMock.mock.calls.map((call) => call[0]);
    expect(destroyedIds).toContain(photo.rearPublicId);
    expect(destroyedIds).toContain(photo.frontPublicId);

    expect(await AroundPhotoModel.countDocuments({ uploaderId: alice.user._id })).toBe(0);
    expect(await AroundDeviceModel.countDocuments({ userId: alice.user._id })).toBe(0);
    expect(await DevicePresenceModel.countDocuments({ userId: alice.user._id })).toBe(0);
    expect(await AroundRingModel.countDocuments({ userId: alice.user._id })).toBe(0);
    expect(await AroundUserModel.countDocuments({ _id: alice.user._id })).toBe(0);

    const membership = await AroundMemberModel.findOne({ aroundId: around._id, userId: alice.user._id }).lean();
    expect(membership?.status).toBe("left");
    expect(membership?.joinFixes).toHaveLength(0);

    // The dead token is rejected afterwards.
    const me = await request(app).get("/api/users/me").set("Authorization", alice.auth);
    expect(me.status).toBe(401);
  });

  it("closes the arounds owned by a deleted user and strips their centre and name", async () => {
    const owner = await createUser("owner");
    const active = await createAroundFixture(owner.user._id);
    const closed = await createAroundFixture(owner.user._id, {
      status: "closed",
      captureEndsAt: new Date(Date.now() - 60_000)
    });

    const res = await request(app).delete("/api/users/me").set("Authorization", owner.auth);
    expect(res.status).toBe(200);

    // The centre IS the deleted owner's exact position: closing is not
    // enough, and the already-closed around must be erased too.
    for (const id of [active._id, closed._id]) {
      const stored = await AroundModel.findById(id).lean();
      expect(stored?.status).toBe("closed");
      expect(stored?.center).toBeUndefined();
      expect(stored?.name).toBeNull();
    }
  });

  it("keeps serving a centre-stripped around to its surviving members (center:null, no 500)", async () => {
    const owner = await createUser("owner");
    const alice = await createUser("alice");
    const around = await createAroundFixture(owner.user._id);
    await addMember(around._id, alice.user._id);

    const res = await request(app).delete("/api/users/me").set("Authorization", owner.auth);
    expect(res.status).toBe(200);

    // The owner-erased around stays readable for 7 days: the whole serving
    // path must degrade to center:null, never crash on the missing field.
    const mine = await request(app).get("/api/arounds/mine").set("Authorization", alice.auth);
    expect(mine.status).toBe(200);
    expect(mine.body.arounds).toHaveLength(1);
    expect(mine.body.arounds[0].status).toBe("closed");
    expect(mine.body.arounds[0].center).toBeNull();
    expect(mine.body.arounds[0].name).toBeNull();

    const detail = await request(app).get(`/api/arounds/${around._id}`).set("Authorization", alice.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.around.center).toBeNull();
  });

  // User-targeted reports carry aroundId:null, so the per-around purge never
  // matched them: they used to keep the ObjectIds of deleted accounts and a
  // free-text comment for ever, against what the privacy policy promises.
  it("erases the reports filed by or against a deleted account, and unlinks the admin journal", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const carol = await createUser("carol");

    await AroundReportModel.create({
      targetType: "user",
      targetId: alice.user._id,
      aroundId: null,
      reporterId: bob.user._id,
      reason: "harassment",
      comment: "free text naming the reporter",
      status: "open",
      createdAt: new Date()
    });
    await AroundReportModel.create({
      targetType: "user",
      targetId: carol.user._id,
      aroundId: null,
      reporterId: alice.user._id,
      reason: "spam",
      comment: null,
      status: "open",
      createdAt: new Date()
    });
    await ModerationActionModel.create({
      action: "ban_user",
      targetType: "user",
      targetId: alice.user._id,
      meta: null,
      createdAt: new Date()
    });

    const res = await request(app).delete("/api/users/me").set("Authorization", alice.auth);
    expect(res.status).toBe(200);

    expect(await AroundReportModel.countDocuments({
      $or: [{ reporterId: alice.user._id }, { targetId: alice.user._id }]
    })).toBe(0);

    // The journal entry survives (evidence a decision was taken) but no longer
    // points at the deleted account.
    const journal = await ModerationActionModel.findOne({ action: "ban_user" }).lean();
    expect(journal).not.toBeNull();
    expect(journal?.targetId ?? null).toBeNull();
  });

  // Public names stopped being exclusive on 2026-08-30, so the tombstone no
  // longer guards anything — deletion still writes it (inert, TTL-swept), and
  // the freed name is immediately usable by anyone, like any other name.
  it("still writes the tombstone, but the freed name is usable by anyone", async () => {
    const alice = await createUser("ghost");

    const res = await request(app).delete("/api/users/me").set("Authorization", alice.auth);
    expect(res.status).toBe(200);
    expect(await AroundReservedPseudoModel.countDocuments({ pseudoLower: "ghost" })).toBe(1);

    const mallory = await createUser("mallory");
    const rename = await request(app)
      .patch("/api/users/me")
      .set("Authorization", mallory.auth)
      .send({ pseudo: "ghost" });
    expect(rename.status).toBe(200);
    expect(rename.body.user.pseudo).toBe("ghost");
  });
});
