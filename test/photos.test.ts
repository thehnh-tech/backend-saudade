import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { MAX_PHOTOS_PER_USER_PER_AROUND } from "../src/around/aroundPhotoRoutes.js";
import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { resetUserCache } from "../src/around/middleware.js";
import { AroundMemberModel, AroundPhotoModel } from "../src/around/models.js";
import { makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  addMember,
  createAroundFixture,
  createPhotoFixture,
  createUser,
  jpegBuffer
} from "./helpers/fixtures.js";

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

async function setupCircle() {
  const owner = await createUser("owner");
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const around = await createAroundFixture(owner.user._id);
  await addMember(around._id, alice.user._id);
  await addMember(around._id, bob.user._id);
  return { owner, alice, bob, around };
}

describe("photo upload", () => {
  it("uploads a double capture as authenticated assets and stores no URL", async () => {
    const { alice, around } = await setupCircle();
    const { uploadImageBuffer } = await import("../src/cloudinary.js");

    const res = await request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", alice.auth)
      .field("captureMode", "double")
      .attach("photoRear", jpegBuffer(), "rear.jpg")
      .attach("photoFront", jpegBuffer(), "front.jpg");

    expect(res.status).toBe(201);
    expect(res.body.photo.status).toBe("pending");
    expect(res.body.photo.canSeeClear).toBe(true); // uploader always sees clear

    const uploadMock = uploadImageBuffer as unknown as ReturnType<typeof vi.fn>;
    expect(uploadMock).toHaveBeenCalledTimes(2);
    for (const call of uploadMock.mock.calls) {
      expect(call[1].type).toBe("authenticated");
    }

    const stored = await AroundPhotoModel.findOne({ aroundId: around._id }).lean();
    expect(stored?.rearPublicId).toBeTruthy();
    expect(stored?.frontPublicId).toBeTruthy();
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain("https://");
  });

  it("auto-approves the owner's photos", async () => {
    const { owner, around } = await setupCircle();
    const res = await request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", owner.auth)
      .field("captureMode", "double")
      .attach("photoRear", jpegBuffer(), "rear.jpg")
      .attach("photoFront", jpegBuffer(), "front.jpg");

    expect(res.status).toBe(201);
    expect(res.body.photo.status).toBe("approved");
    expect(res.body.photo.approvedAt).toBeTruthy();
  });

  it("returns 410 when uploading after the window closed", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, { captureEndsAt: new Date(Date.now() - 1000) });
    const res = await request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", owner.auth)
      .field("captureMode", "double")
      .attach("photoRear", jpegBuffer(), "rear.jpg")
      .attach("photoFront", jpegBuffer(), "front.jpg");
    expect(res.status).toBe(410);
    expect(res.body.error).toBe("CAPTURE_WINDOW_CLOSED");
  });

  it("refuses non-members", async () => {
    const { around } = await setupCircle();
    const stranger = await createUser("stranger");
    const res = await request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", stranger.auth)
      .field("captureMode", "double")
      .attach("photoRear", jpegBuffer(), "rear.jpg")
      .attach("photoFront", jpegBuffer(), "front.jpg");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("NOT_A_MEMBER");
  });
});

describe("anti-leak invariant: pending photos of others are blurred, signed, and never expose public ids", () => {
  it("serves only a signed blurred URL to a non-owner member", async () => {
    const { alice, bob, around } = await setupCircle();
    const photo = await createPhotoFixture(around._id, alice.user._id, { status: "pending" });

    const res = await request(app)
      .get(`/api/arounds/${around._id}/photos`)
      .set("Authorization", bob.auth);

    expect(res.status).toBe(200);
    expect(res.body.photos).toHaveLength(1);
    const item = res.body.photos[0];
    expect(item.canSeeClear).toBe(false);
    // Blur transformation is inside the SIGNED part of the URL.
    expect(item.rearUrl).toContain("s--BLURSIG--");
    expect(item.rearUrl).toContain("e_blur:2000");
    expect(item.frontUrl).toContain("s--BLURSIG--");

    const raw = JSON.stringify(res.body);
    // No clear URL anywhere in the payload.
    expect(raw).not.toContain("s--CLEARSIG--");
    // No raw public_id field leaked.
    expect(raw).not.toMatch(/publicId/i);
    expect(raw).not.toContain(`"${photo.rearPublicId}"`);
    // No unsigned cloudinary URL.
    for (const match of raw.match(/https:[^"]+/g) ?? []) {
      expect(match).toContain("s--");
    }
  });

  it("refuses the clear download of a pending photo to a non-owner member", async () => {
    const { alice, bob, around } = await setupCircle();
    const photo = await createPhotoFixture(around._id, alice.user._id, { status: "pending" });

    const res = await request(app)
      .get(`/api/arounds/${around._id}/photos/${photo._id}/download`)
      .set("Authorization", bob.auth);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("FORBIDDEN");
    expect(JSON.stringify(res.body)).not.toContain("https://");
  });

  it("hides rejected photos from everyone but the author", async () => {
    const { owner, alice, bob, around } = await setupCircle();
    await createPhotoFixture(around._id, alice.user._id, { status: "rejected" });

    const asBob = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", bob.auth);
    expect(asBob.body.photos).toHaveLength(0);

    const asOwner = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", owner.auth);
    expect(asOwner.body.photos).toHaveLength(0);

    const asAlice = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", alice.auth);
    expect(asAlice.body.photos).toHaveLength(1);
    expect(asAlice.body.photos[0].status).toBe("rejected");
    expect(asAlice.body.photos[0].canSeeClear).toBe(true);
  });

  it("hides removed_by_moderation photos from everyone", async () => {
    const { alice, around } = await setupCircle();
    await createPhotoFixture(around._id, alice.user._id, { status: "removed_by_moderation" });
    const asAlice = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", alice.auth);
    expect(asAlice.body.photos).toHaveLength(0);
  });
});

describe("serializer matrix viewer x status", () => {
  it("applies the canSeeClear rule for every viewer/status combination", async () => {
    const { owner, alice, bob, around } = await setupCircle();
    await createPhotoFixture(around._id, alice.user._id, { status: "pending" });
    await createPhotoFixture(around._id, alice.user._id, { status: "approved", approvedAt: new Date() });
    await createPhotoFixture(around._id, alice.user._id, { status: "rejected" });

    const expectations: Array<{
      auth: string;
      expected: Record<string, { clear: boolean }>;
    }> = [
      // Uploader: sees all three, always clear.
      { auth: alice.auth, expected: { pending: { clear: true }, approved: { clear: true }, rejected: { clear: true } } },
      // Owner (first-level moderator): pending + approved clear, rejected hidden.
      { auth: owner.auth, expected: { pending: { clear: true }, approved: { clear: true } } },
      // Other member: pending blurred, approved clear, rejected hidden.
      { auth: bob.auth, expected: { pending: { clear: false }, approved: { clear: true } } }
    ];

    for (const { auth, expected } of expectations) {
      const res = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", auth);
      expect(res.status).toBe(200);
      const byStatus = new Map(res.body.photos.map((photo: { status: string }) => [photo.status, photo]));
      expect([...byStatus.keys()].sort()).toEqual(Object.keys(expected).sort());
      for (const [status, { clear }] of Object.entries(expected)) {
        const photo = byStatus.get(status) as { canSeeClear: boolean; rearUrl: string };
        expect(photo.canSeeClear).toBe(clear);
        expect(photo.rearUrl).toContain(clear ? "s--CLEARSIG--" : "s--BLURSIG--");
      }
    }
  });
});

describe("approve / reject / download", () => {
  it("owner approves a pending photo (pending-only transition) and unlocks it for members", async () => {
    const { owner, alice, bob, around } = await setupCircle();
    const photo = await createPhotoFixture(around._id, alice.user._id, { status: "pending" });

    const notOwner = await request(app)
      .post(`/api/arounds/${around._id}/photos/${photo._id}/approve`)
      .set("Authorization", bob.auth);
    expect(notOwner.status).toBe(403);

    const approve = await request(app)
      .post(`/api/arounds/${around._id}/photos/${photo._id}/approve`)
      .set("Authorization", owner.auth);
    expect(approve.status).toBe(200);
    expect(approve.body.photo.status).toBe("approved");

    const again = await request(app)
      .post(`/api/arounds/${around._id}/photos/${photo._id}/approve`)
      .set("Authorization", owner.auth);
    expect(again.status).toBe(409);

    const asBob = await request(app).get(`/api/arounds/${around._id}/photos`).set("Authorization", bob.auth);
    expect(asBob.body.photos[0].canSeeClear).toBe(true);

    const download = await request(app)
      .get(`/api/arounds/${around._id}/photos/${photo._id}/download`)
      .set("Authorization", bob.auth);
    expect(download.status).toBe(200);
    expect(download.body.rearUrl).toContain("s--DLSIG--");
    expect(download.body.frontUrl).toContain("s--DLSIG--");
  });

  it("owner rejects a pending photo; the author keeps access", async () => {
    const { owner, alice, around } = await setupCircle();
    const photo = await createPhotoFixture(around._id, alice.user._id, { status: "pending" });

    const reject = await request(app)
      .post(`/api/arounds/${around._id}/photos/${photo._id}/reject`)
      .set("Authorization", owner.auth);
    expect(reject.status).toBe(200);
    expect(reject.body.photo.status).toBe("rejected");

    const download = await request(app)
      .get(`/api/arounds/${around._id}/photos/${photo._id}/download`)
      .set("Authorization", alice.auth);
    expect(download.status).toBe(200);
  });

  it("returns 409 when approving a photo that was already rejected (and keeps it rejected)", async () => {
    const { owner, alice, around } = await setupCircle();
    const photo = await createPhotoFixture(around._id, alice.user._id, { status: "pending" });

    const reject = await request(app)
      .post(`/api/arounds/${around._id}/photos/${photo._id}/reject`)
      .set("Authorization", owner.auth);
    expect(reject.status).toBe(200);

    const approve = await request(app)
      .post(`/api/arounds/${around._id}/photos/${photo._id}/approve`)
      .set("Authorization", owner.auth);
    expect(approve.status).toBe(409);
    expect(approve.body.error).toBe("INVALID_STATUS_TRANSITION");

    const stored = await AroundPhotoModel.findById(photo._id).lean();
    expect(stored?.status).toBe("rejected");
  });

  it("concurrent approve + reject: exactly one wins, the loser gets 409, the stored status matches the winner", async () => {
    const { owner, alice, around } = await setupCircle();
    const photo = await createPhotoFixture(around._id, alice.user._id, { status: "pending" });

    const [approveRes, rejectRes] = await Promise.all([
      request(app)
        .post(`/api/arounds/${around._id}/photos/${photo._id}/approve`)
        .set("Authorization", owner.auth),
      request(app)
        .post(`/api/arounds/${around._id}/photos/${photo._id}/reject`)
        .set("Authorization", owner.auth)
    ]);

    // Whether the requests serialized (pre-check 409) or truly raced (the
    // conditional updateOne matched nothing -> 409), exactly one transition
    // wins and the response/database never disagree.
    expect([approveRes.status, rejectRes.status].sort()).toEqual([200, 409]);
    const loser = approveRes.status === 409 ? approveRes : rejectRes;
    expect(loser.body.error).toBe("INVALID_STATUS_TRANSITION");

    const stored = await AroundPhotoModel.findById(photo._id).lean();
    expect(stored?.status).toBe(approveRes.status === 200 ? "approved" : "rejected");
  });
});

describe("upload input hardening", () => {
  // The 50-photo quota used to count LIVE documents, so deleting a photo
  // handed a credit back: the cap was an instantaneous ceiling, not a quota.
  // It is now a monotonic counter on the membership.
  it("counts photos ever uploaded, not live ones: deleting does not free a credit", async () => {
    const { alice, around } = await setupCircle();
    const membership = await AroundMemberModel.findOne({ aroundId: around._id, userId: alice.user._id });

    // Start one below the cap so the test stays cheap.
    await AroundMemberModel.updateOne(
      { _id: membership?._id },
      { $set: { uploadedTotal: MAX_PHOTOS_PER_USER_PER_AROUND - 1 } }
    );

    const last = await request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", alice.auth)
      .field("captureMode", "back")
      .attach("photoRear", jpegBuffer(), "rear.jpg");
    expect(last.status).toBe(201);

    // Free every live document AND reset the upload rate limiter: the only
    // thing left standing between Alice and a 51st photo is the quota.
    const removed = await request(app)
      .delete(`/api/arounds/${around._id}/photos/${last.body.photo.id}`)
      .set("Authorization", alice.auth);
    expect(removed.status).toBe(200);
    expect(await AroundPhotoModel.countDocuments({ aroundId: around._id, uploaderId: alice.user._id })).toBe(0);
    resetAroundRateLimits();

    const overQuota = await request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", alice.auth)
      .field("captureMode", "back")
      .attach("photoRear", jpegBuffer(), "rear.jpg");
    expect(overQuota.status).toBe(403);
    expect(overQuota.body.error).toBe("PHOTO_QUOTA_REACHED");

    const stored = await AroundMemberModel.findOne({ aroundId: around._id, userId: alice.user._id }).lean();
    expect(stored?.uploadedTotal).toBe(MAX_PHOTOS_PER_USER_PER_AROUND);
  });

  it("stores only enum captureMode values (an arbitrary string falls back to double)", async () => {
    const { alice, around } = await setupCircle();

    const res = await request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", alice.auth)
      .field("captureMode", "not-a-mode")
      .attach("photoRear", jpegBuffer(), "rear.jpg")
      .attach("photoFront", jpegBuffer(), "front.jpg");

    expect(res.status).toBe(201);
    expect(res.body.photo.captureMode).toBe("double");
    const stored = await AroundPhotoModel.findById(res.body.photo.id).lean();
    expect(stored?.captureMode).toBe("double");
  });

  it("accepts the front/back single-camera modes", async () => {
    const { alice, around } = await setupCircle();

    const res = await request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", alice.auth)
      .field("captureMode", "front")
      .attach("photoRear", jpegBuffer(), "rear.jpg");

    expect(res.status).toBe(201);
    expect(res.body.photo.captureMode).toBe("front");
  });

  it("rejects a multipart body stuffed with text fields instead of buffering it", async () => {
    const { alice, around } = await setupCircle();

    const req = request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", alice.auth);
    for (let i = 0; i < 40; i += 1) req.field(`filler${i}`, "y");
    const res = await req.attach("photoRear", jpegBuffer(), "rear.jpg");

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("REQUEST_TOO_LARGE");
  });

  it("rejects an oversized captureMode value instead of persisting it", async () => {
    const { alice, around } = await setupCircle();

    const res = await request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", alice.auth)
      .field("captureMode", "x".repeat(100_000))
      .attach("photoRear", jpegBuffer(), "rear.jpg");

    expect(res.status).toBe(413);
    expect(await AroundPhotoModel.countDocuments({ aroundId: around._id })).toBe(0);
  });

  it("never echoes a raw internal error message to the client", async () => {
    const { alice, around } = await setupCircle();
    const cloudinaryModule = await import("../src/cloudinary.js");
    const spy = vi.spyOn(cloudinaryModule, "uploadImageBuffer").mockRejectedValueOnce(
      new Error("Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.")
    );

    const res = await request(app)
      .post(`/api/arounds/${around._id}/photos`)
      .set("Authorization", alice.auth)
      .field("captureMode", "back")
      .attach("photoRear", jpegBuffer(), "rear.jpg");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "INTERNAL_ERROR" });
    expect(JSON.stringify(res.body)).not.toContain("CLOUDINARY");
    spy.mockRestore();
  });
});
