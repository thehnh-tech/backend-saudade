import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { resetUserCache } from "../src/around/middleware.js";
import { AroundBlockModel } from "../src/around/models.js";
import { makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import { addMember, createAroundFixture, createPhotoFixture, createUser } from "./helpers/fixtures.js";

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

describe("bilateral block filtering (server-side)", () => {
  it("filters the photo feed in BOTH directions after a block", async () => {
    const owner = await createUser("owner");
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const around = await createAroundFixture(owner.user._id);
    await addMember(around._id, alice.user._id);
    await addMember(around._id, bob.user._id);
    await createPhotoFixture(around._id, alice.user._id, { status: "approved", approvedAt: new Date() });
    await createPhotoFixture(around._id, bob.user._id, { status: "approved", approvedAt: new Date() });

    // Before the block, both see each other's approved photos.
    let asBob = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", bob.auth);
    expect(asBob.body.photos).toHaveLength(2);

    // Alice blocks Bob.
    const block = await request(app).post(`/api/users/${bob.id}/block`).set("Authorization", alice.auth);
    expect(block.status).toBe(200);
    expect(await AroundBlockModel.countDocuments({ blockerId: alice.user._id, blockedId: bob.user._id })).toBe(1);

    // Bob no longer sees Alice's photo (blocked-by filter)...
    asBob = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", bob.auth);
    expect(asBob.body.photos).toHaveLength(1);
    expect(asBob.body.photos[0].uploaderId).toBe(bob.id);

    // ...and Alice no longer sees Bob's photo (blocker filter).
    const asAlice = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", alice.auth);
    expect(asAlice.body.photos).toHaveLength(1);
    expect(asAlice.body.photos[0].uploaderId).toBe(alice.id);

    // A third party still sees everything.
    const asOwner = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", owner.auth);
    expect(asOwner.body.photos).toHaveLength(2);
  });

  it("filters the member list in BOTH directions", async () => {
    const owner = await createUser("owner");
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const around = await createAroundFixture(owner.user._id);
    await addMember(around._id, alice.user._id);
    await addMember(around._id, bob.user._id);

    await request(app).post(`/api/users/${bob.id}/block`).set("Authorization", alice.auth);

    const asAlice = await request(app).get(`/api/arounds/${around._id}`).set("Authorization", alice.auth);
    expect(asAlice.status).toBe(200);
    const alicePseudos = asAlice.body.members.map((member: { pseudo: string }) => member.pseudo).sort();
    expect(alicePseudos).toEqual(["alice", "owner"]);

    const asBob = await request(app).get(`/api/arounds/${around._id}`).set("Authorization", bob.auth);
    const bobPseudos = asBob.body.members.map((member: { pseudo: string }) => member.pseudo).sort();
    expect(bobPseudos).toEqual(["bob", "owner"]);

    const asOwner = await request(app).get(`/api/arounds/${around._id}`).set("Authorization", owner.auth);
    expect(asOwner.body.members).toHaveLength(3);
    // Contract: each member exposes BOTH `id` and `userId` (the mobile client
    // reads userId for kick/block/report).
    for (const member of asOwner.body.members as Array<{ id: string; userId: string }>) {
      expect(member.userId).toBeTruthy();
      expect(member.userId).toBe(member.id);
    }
  });

  it("unblock restores visibility", async () => {
    const owner = await createUser("owner");
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const around = await createAroundFixture(owner.user._id);
    await addMember(around._id, alice.user._id);
    await addMember(around._id, bob.user._id);
    await createPhotoFixture(around._id, bob.user._id, { status: "approved", approvedAt: new Date() });

    await request(app).post(`/api/users/${bob.id}/block`).set("Authorization", alice.auth);
    let asAlice = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", alice.auth);
    expect(asAlice.body.photos).toHaveLength(0);

    await request(app).delete(`/api/users/${bob.id}/block`).set("Authorization", alice.auth);
    asAlice = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", alice.auth);
    expect(asAlice.body.photos).toHaveLength(1);
  });

  it("refuses blocking yourself", async () => {
    const alice = await createUser("alice");
    const res = await request(app).post(`/api/users/${alice.id}/block`).set("Authorization", alice.auth);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("CANNOT_BLOCK_SELF");
  });
});

describe("kick + banlist", () => {
  it("owner kicks a member; the member can no longer access the around", async () => {
    const owner = await createUser("owner");
    const alice = await createUser("alice");
    const around = await createAroundFixture(owner.user._id);
    await addMember(around._id, alice.user._id);

    const kick = await request(app)
      .delete(`/api/arounds/${around._id}/members/${alice.id}`)
      .set("Authorization", owner.auth);
    expect(kick.status).toBe(200);

    const detail = await request(app).get(`/api/arounds/${around._id}`).set("Authorization", alice.auth);
    expect(detail.status).toBe(403);
    expect(detail.body.error).toBe("NOT_A_MEMBER");
  });

  it("a non-owner cannot kick", async () => {
    const owner = await createUser("owner");
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    const around = await createAroundFixture(owner.user._id);
    await addMember(around._id, alice.user._id);
    await addMember(around._id, bob.user._id);

    const res = await request(app)
      .delete(`/api/arounds/${around._id}/members/${bob.id}`)
      .set("Authorization", alice.auth);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("OWNER_ONLY");
  });
});
