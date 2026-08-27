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
import { AroundMemberModel, AroundReportModel, AroundUserModel } from "../src/around/models.js";
import { makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import { LAUSANNE, adminAuth, createAroundFixture, createUser } from "./helpers/fixtures.js";

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

// The name of an around is pushed to strangers nearby. Someone who received
// that notification and never joined MUST be able to report it — Terms §6.
describe("POST /api/arounds/:id/report", () => {
  it("lets a NON-member report an around (201) without any membership", async () => {
    const owner = await createUser("owner");
    const stranger = await createUser("stranger");
    const around = await createAroundFixture(owner.user._id, { name: "Nom douteux" });

    const membership = await AroundMemberModel.findOne({ aroundId: around._id, userId: stranger.user._id });
    expect(membership).toBeNull();

    const res = await request(app)
      .post(`/api/arounds/${String(around._id)}/report`)
      .set("Authorization", stranger.auth)
      .send({ reason: "hate_speech", comment: "nom insultant recu en notification" });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const stored = await AroundReportModel.find({ targetType: "around" }).lean();
    expect(stored).toHaveLength(1);
    expect(String(stored[0].targetId)).toBe(String(around._id));
    expect(String(stored[0].aroundId)).toBe(String(around._id));
    expect(String(stored[0].reporterId)).toBe(stranger.id);
    expect(stored[0].reason).toBe("hate_speech");
    expect(stored[0].status).toBe("open");
  });

  it("is idempotent per (around, reporter)", async () => {
    const owner = await createUser("owner");
    const stranger = await createUser("stranger");
    const around = await createAroundFixture(owner.user._id, { name: "Nom douteux" });

    const first = await request(app)
      .post(`/api/arounds/${String(around._id)}/report`)
      .set("Authorization", stranger.auth)
      .send({ reason: "harassment" });
    const second = await request(app)
      .post(`/api/arounds/${String(around._id)}/report`)
      .set("Authorization", stranger.auth)
      .send({ reason: "spam" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await AroundReportModel.countDocuments({ targetType: "around" })).toBe(1);

    // Another reporter is a separate report.
    const other = await createUser("other");
    const third = await request(app)
      .post(`/api/arounds/${String(around._id)}/report`)
      .set("Authorization", other.auth)
      .send({ reason: "harassment" });
    expect(third.status).toBe(201);
    expect(await AroundReportModel.countDocuments({ targetType: "around" })).toBe(2);
  });

  it("refuses an unauthenticated caller, a banned account, the owner, and a bad reason", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, { name: "Ma soiree" });

    const anonymous = await request(app)
      .post(`/api/arounds/${String(around._id)}/report`)
      .send({ reason: "spam" });
    expect(anonymous.status).toBe(401);

    const ownReport = await request(app)
      .post(`/api/arounds/${String(around._id)}/report`)
      .set("Authorization", owner.auth)
      .send({ reason: "spam" });
    expect(ownReport.status).toBe(400);
    expect(ownReport.body.error).toBe("CANNOT_REPORT_OWN_AROUND");

    const stranger = await createUser("stranger");
    const badReason = await request(app)
      .post(`/api/arounds/${String(around._id)}/report`)
      .set("Authorization", stranger.auth)
      .send({ reason: "je-n-aime-pas" });
    expect(badReason.status).toBe(400);
    expect(badReason.body.error).toBe("INVALID_INPUT");

    const banned = await createUser("badguy");
    await AroundUserModel.updateOne({ _id: banned.user._id }, { $set: { status: "banned" } });
    resetUserCache();
    const bannedReport = await request(app)
      .post(`/api/arounds/${String(around._id)}/report`)
      .set("Authorization", banned.auth)
      .send({ reason: "spam" });
    expect(bannedReport.status).toBe(403);

    const missing = await request(app)
      .post("/api/arounds/ffffffffffffffffffffffff/report")
      .set("Authorization", stranger.auth)
      .send({ reason: "spam" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("AROUND_NOT_FOUND");
  });

  it("shares the 20/day report budget with the other report routes", async () => {
    const stranger = await createUser("stranger");
    for (let index = 0; index < 20; index += 1) {
      const owner = await createUser(`owner${index}`);
      const around = await createAroundFixture(owner.user._id, { name: `Around ${index}` });
      const res = await request(app)
        .post(`/api/arounds/${String(around._id)}/report`)
        .set("Authorization", stranger.auth)
        .send({ reason: "spam" });
      expect(res.status).toBe(201);
    }

    const lastOwner = await createUser("lastowner");
    const lastAround = await createAroundFixture(lastOwner.user._id, { name: "Un de trop" });
    const throttled = await request(app)
      .post(`/api/arounds/${String(lastAround._id)}/report`)
      .set("Authorization", stranger.auth)
      .send({ reason: "spam" });
    expect(throttled.status).toBe(429);
    expect(throttled.body.error).toBe("RATE_LIMITED");
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("surfaces the around report in the admin moderation queue with its context", async () => {
    const owner = await createUser("owner");
    const stranger = await createUser("stranger");
    const around = await createAroundFixture(owner.user._id, { name: "Nom douteux" });

    await request(app)
      .post(`/api/arounds/${String(around._id)}/report`)
      .set("Authorization", stranger.auth)
      .send({ reason: "hate_speech" });

    const res = await request(app).get("/api/admin/around/reports").set("Authorization", adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);

    const report = res.body.reports[0];
    expect(report.targetType).toBe("around");
    expect(report.reporterPseudo).toBe("stranger");
    expect(report.photo).toBeUndefined();
    expect(report.user).toBeUndefined();
    expect(report.around).toEqual({
      id: String(around._id),
      name: "Nom douteux",
      ownerId: String(owner.user._id),
      ownerPseudo: "owner",
      status: "active",
      memberCount: around.memberCount,
      photoCount: around.photoCount
    });
  });
});

// The filter promised by §6 ("the name is filtered when the around is
// created"). It is a first-line guard: these tests pin the contract, not an
// exhaustive coverage claim.
describe("filtering of user text at creation", () => {
  async function createAround(auth: string, name: string) {
    return request(app)
      .post("/api/arounds")
      .set("Authorization", auth)
      .send({ name, lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 10, radiusM: 150, durationH: 2 });
  }

  it("refuses an around name carrying a contact channel", async () => {
    const alice = await createUser("alice");
    const res = await createAround(alice.auth, "Rejoins moi sur monsite.com");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_NAME");
    expect(res.body.reason).toBe("contact_info");
  });

  it("refuses an around name carrying a prohibited term, even obfuscated", async () => {
    const alice = await createUser("alice");
    const res = await createAround(alice.auth, "s4l0pe");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_NAME");
    expect(res.body.reason).toBe("prohibited_term");
  });

  it("still accepts an ordinary party name", async () => {
    const alice = await createUser("alice");
    const res = await createAround(alice.auth, "Popcorn & Netflix");
    expect(res.status).toBe(201);
    expect(res.body.around.name).toBe("Popcorn & Netflix");
  });

  it("refuses a pseudo carrying a prohibited term at signup and at rename", async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: "apple-sub-filter", aud: "tech.thehnh.saudade", iss: "https://appleid.apple.com" },
      protectedHeader: { alg: "RS256" }
    });
    const signup = await request(app)
      .post("/api/users/oauth")
      .send({ provider: "apple", identityToken: "apple-token", pseudo: "bougnoule" });
    expect(signup.status).toBe(400);
    expect(signup.body.error).toBe("INVALID_PSEUDO");
    expect(signup.body.reason).toBe("prohibited_term");

    const alice = await createUser("alice");
    const rename = await request(app)
      .patch("/api/users/me")
      .set("Authorization", alice.auth)
      .send({ pseudo: "0612345678" });
    expect(rename.status).toBe(400);
    expect(rename.body.error).toBe("INVALID_PSEUDO");
    expect(rename.body.reason).toBe("contact_info");

    // A shape violation stays a plain INVALID_PSEUDO, with no reason.
    const tooShort = await request(app)
      .patch("/api/users/me")
      .set("Authorization", alice.auth)
      .send({ pseudo: "x" });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error).toBe("INVALID_PSEUDO");
    expect(tooShort.body.reason).toBeUndefined();

    // And an ordinary pseudo with digits still goes through.
    const ok = await request(app)
      .patch("/api/users/me")
      .set("Authorization", alice.auth)
      .send({ pseudo: "nightowl2026" });
    expect(ok.status).toBe(200);
    expect(ok.body.user.pseudo).toBe("nightowl2026");
  });
});
