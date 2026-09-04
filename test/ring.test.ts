import request from "supertest";
import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { resetUserCache } from "../src/around/middleware.js";
import {
  AroundBlockModel,
  AroundDeviceModel,
  AroundRingModel,
  DevicePresenceModel,
  geoPoint
} from "../src/around/models.js";
import { fanOutAroundCreated } from "../src/around/push.js";
import { RING_CLAIM_STALE_MS, wakeRegionsNear } from "../src/around/rings.js";
import { purgeAround } from "../src/around/purge.js";
import { config } from "../src/config.js";
import { makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import { LAUSANNE, addMember, createAroundFixture, createUser, offsetLatByMeters } from "./helpers/fixtures.js";
import { expoChunkPoison, expoSent, expoTicketErrors, resetExpoSent } from "./helpers/mocks.js";

const app = makeTestApp();

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  vi.useRealTimers();
  await clearCollections();
  resetAroundRateLimits();
  resetUserCache();
  resetExpoSent();
  expoTicketErrors.clear();
  expoChunkPoison.clear();
  config.reviewModeUserIds.length = 0;
});

// The fan-out and the arrival ring ride behind the response (runDetached):
// wait for the mocked Expo client to see the messages, or for a quiet
// window to prove nothing was sent.
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("waitFor: condition not met in time");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 350));

let tokenSeq = 0;
async function createDevice(userId: Types.ObjectId, overrides: Record<string, unknown> = {}) {
  tokenSeq += 1;
  const expoPushToken = `ExponentPushToken[ring-${tokenSeq}]`;
  await AroundDeviceModel.create({
    userId,
    installationId: `install-${tokenSeq}`,
    expoPushToken,
    pushEnabled: true,
    lastActiveAt: new Date(),
    invalidatedAt: null,
    ...overrides
  });
  return expoPushToken;
}

async function createPresence(
  userId: Types.ObjectId,
  lat: number,
  lng: number,
  options: { accuracy?: number; ageMs?: number } = {}
) {
  const capturedAt = new Date(Date.now() - (options.ageMs ?? 0));
  await DevicePresenceModel.create({
    userId,
    location: geoPoint(lat, lng),
    accuracy: options.accuracy ?? 20,
    capturedAt,
    updatedAt: new Date(),
    source: "background"
  });
}

async function radarUser(pseudo: string) {
  const created = await createUser(pseudo, { radarEnabled: true });
  const token = await createDevice(created.user._id);
  return { ...created, token };
}

const visible = () => expoSent.filter((message) => message.data?.type === "around-created");
const probes = () => expoSent.filter((message) => message.data?.type === "presence-probe");

describe("fan-out at creation — who is rung, who is probed", () => {
  it("rings fresh presences inside the radius exactly once and probes the radar devices it could not evaluate", async () => {
    const owner = await createUser("owner", { radarEnabled: true });
    await createDevice(owner.user._id);

    const inside = await radarUser("inside");
    await createPresence(inside.user._id, LAUSANNE.lat, LAUSANNE.lng);
    const radarOff = await createUser("radar-off", { radarEnabled: false });
    await createDevice(radarOff.user._id);
    await createPresence(radarOff.user._id, LAUSANNE.lat, LAUSANNE.lng);
    const outside = await radarUser("outside");
    await createPresence(outside.user._id, offsetLatByMeters(LAUSANNE.lat, 600), LAUSANNE.lng);
    const stale = await radarUser("stale");
    await createPresence(stale.user._id, LAUSANNE.lat, LAUSANNE.lng, { ageMs: config.presenceFreshMs + 60_000 });
    const blocked = await radarUser("blocked");
    await createPresence(blocked.user._id, LAUSANNE.lat, LAUSANNE.lng);
    await AroundBlockModel.create({ blockerId: owner.user._id, blockedId: blocked.user._id, createdAt: new Date() });
    // No presence at all, radar on, a token: the probe audience.
    const silent = await radarUser("silent");

    const created = await request(app)
      .post("/api/arounds")
      .set("Authorization", owner.auth)
      .send({ name: "Soiree test", lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 10, radiusM: 200, durationH: 3 });
    expect(created.status).toBe(201);
    const aroundId = created.body.around.id as string;

    await waitFor(() => visible().length >= 1 && probes().length >= 1);
    await settle();

    const rung = visible();
    expect(rung.map((message) => message.to)).toEqual([inside.token]);
    expect(rung[0].title).toBe("Picture me around");
    expect(rung[0].data).toMatchObject({ type: "around-created", kind: "created", aroundId, name: "Soiree test" });

    const probed = probes().map((message) => message.to);
    expect(probed).toContain(silent.token);
    expect(probed).not.toContain(inside.token);
    const radarOffToken = (await AroundDeviceModel.findOne({ userId: radarOff.user._id }).lean())?.expoPushToken;
    expect(probed).not.toContain(radarOffToken);
    const probe = probes().find((message) => message.to === silent.token);
    expect(probe?._contentAvailable).toBe(true);
    expect(probe?.title).toBeUndefined();
    expect(probe?.data).toMatchObject({ type: "presence-probe", aroundId });

    const rings = await AroundRingModel.find({ aroundId: new Types.ObjectId(aroundId) }).lean();
    expect(rings).toHaveLength(1);
    expect(String(rings[0].userId)).toBe(inside.id);
    expect(rings[0].kind).toBe("created");
    expect(rings[0].sentAt).not.toBeNull();
  });

  it("gives the claim back when nothing reached Expo, so the arrival ring still rings that phone", async () => {
    const owner = await createUser("owner", { radarEnabled: true });
    const around = await createAroundFixture(owner.user._id, { radiusM: 200 });
    const guest = await radarUser("guest");
    await createPresence(guest.user._id, LAUSANNE.lat, LAUSANNE.lng);
    // Every message of the chunk fails, and the one-by-one retry fails too.
    expoChunkPoison.add(guest.token);

    await fanOutAroundCreated(around);
    expect(visible()).toHaveLength(0);
    // The claim must NOT survive: it would silence this around for good.
    expect(await AroundRingModel.countDocuments({ aroundId: around._id })).toBe(0);

    // Same phone, next presence: Expo is healthy again and it rings.
    expoChunkPoison.clear();
    resetAroundRateLimits();
    const post = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", guest.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 20, source: "background" });
    expect(post.status).toBe(200);

    await waitFor(() => visible().length === 1);
    expect(visible()[0].to).toBe(guest.token);
    expect(visible()[0].data).toMatchObject({ kind: "arrival" });
  });

  it("takes over a claim left behind by a lambda that died before sending", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, { radiusM: 200 });
    const guest = await radarUser("guest");
    // A claim written, never sent, older than the takeover delay.
    await AroundRingModel.create({
      aroundId: around._id,
      userId: guest.user._id,
      kind: "created",
      claimedAt: new Date(Date.now() - RING_CLAIM_STALE_MS - 60_000),
      sentAt: null,
      ticketIds: []
    });

    const post = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", guest.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 20, source: "background" });
    expect(post.status).toBe(200);

    // The claim is stamped AFTER the send returns, so wait on the stamp
    // rather than on the message: waiting on the message alone is a race.
    await waitFor(async () => {
      const ring = await AroundRingModel.findOne({ aroundId: around._id, userId: guest.user._id }).lean();
      return Boolean(ring?.sentAt);
    });
    expect(visible()).toHaveLength(1);
    expect(visible()[0].to).toBe(guest.token);
    expect(await AroundRingModel.countDocuments({ aroundId: around._id })).toBe(1);
  });

  it("does not take over a claim that was just made by a send still in flight", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, { radiusM: 200 });
    const guest = await radarUser("guest");
    await AroundRingModel.create({
      aroundId: around._id,
      userId: guest.user._id,
      kind: "created",
      claimedAt: new Date(),
      sentAt: null,
      ticketIds: []
    });

    const post = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", guest.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 20, source: "background" });
    expect(post.status).toBe(200);
    await settle();
    expect(visible()).toHaveLength(0);
  });

  it("writes each notification in the recipient's own language, accents included", async () => {
    const owner = await createUser("owner");
    const french = await createUser("french", { radarEnabled: true, locale: "fr" });
    const frToken = await createDevice(french.user._id);
    await createPresence(french.user._id, LAUSANNE.lat, LAUSANNE.lng);
    const english = await createUser("english", { radarEnabled: true, locale: "en" });
    const enToken = await createDevice(english.user._id);
    await createPresence(english.user._id, LAUSANNE.lat, LAUSANNE.lng);

    const created = await request(app)
      .post("/api/arounds")
      .set("Authorization", owner.auth)
      .send({ name: "Chez Lea", lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 10, radiusM: 200, durationH: 3 });
    expect(created.status).toBe(201);

    await waitFor(() => visible().length === 2);
    const fr = visible().find((message) => message.to === frToken);
    const en = visible().find((message) => message.to === enToken);

    // Both reach strangers, so both keep the neutral product name as title.
    expect(fr?.title).toBe("Picture me around");
    expect(en?.title).toBe("Picture me around");
    expect(fr?.body).toContain("vient de s'ouvrir près de toi");
    expect(en?.body).toContain("just opened near you");
    // The accents were stripped from every body before the copy table existed.
    expect(fr?.body).toMatch(/près/);
    expect(en?.body).not.toMatch(/ouvrir/);
    // The around's name is quoted inside the body, never promoted to the title.
    expect(fr?.body).toContain("Chez Lea");
    expect(en?.body).toContain("Chez Lea");
  });

  it("retries a poisoned chunk one message at a time so one foreign token cannot silence the others", async () => {
    const owner = await createUser("owner", { radarEnabled: true });
    const good = await radarUser("good");
    await createPresence(good.user._id, LAUSANNE.lat, LAUSANNE.lng);
    const poison = await radarUser("poison");
    await createPresence(poison.user._id, LAUSANNE.lat, LAUSANNE.lng);
    expoChunkPoison.add(poison.token);

    const created = await request(app)
      .post("/api/arounds")
      .set("Authorization", owner.auth)
      .send({ name: "Chunk", lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 10, radiusM: 200, durationH: 3 });
    expect(created.status).toBe(201);

    await waitFor(() => visible().some((message) => message.to === good.token));
    await settle();
    expect(visible().map((message) => message.to)).toEqual([good.token]);
  });

  it("invalidates a token that Expo reports as DeviceNotRegistered", async () => {
    const owner = await createUser("owner", { radarEnabled: true });
    const gone = await radarUser("gone");
    await createPresence(gone.user._id, LAUSANNE.lat, LAUSANNE.lng);
    expoTicketErrors.set(gone.token, "DeviceNotRegistered");

    const created = await request(app)
      .post("/api/arounds")
      .set("Authorization", owner.auth)
      .send({ name: "Gone", lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 10, radiusM: 200, durationH: 3 });
    expect(created.status).toBe(201);

    await waitFor(async () => {
      const device = await AroundDeviceModel.findOne({ userId: gone.user._id }).lean();
      return Boolean(device?.invalidatedAt) && !device?.expoPushToken;
    });
  });
});

describe("arrival ring — POST /api/users/me/location", () => {
  it("rings a non-member whose background presence lands inside an open around, once, and returns wake regions", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, { radiusM: 150 });
    const guest = await radarUser("guest");

    const first = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", guest.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 30, source: "background", installationId: "install-guest" });
    expect(first.status).toBe(200);
    expect(first.body.wakeRegions).toHaveLength(1);
    expect(first.body.wakeRegions[0].id).toBe(String(around._id));
    expect(first.body.wakeRegions[0].radiusM).toBe(150 + 150);

    await waitFor(() => visible().length === 1);
    expect(visible()[0].to).toBe(guest.token);
    expect(visible()[0].data).toMatchObject({ type: "around-created", kind: "arrival", aroundId: String(around._id) });
    const ring = await AroundRingModel.findOne({ aroundId: around._id, userId: guest.user._id }).lean();
    expect(ring?.kind).toBe("arrival");
    expect(ring?.source).toBe("background");

    // Same phone, next fix: the claim holds.
    resetAroundRateLimits();
    resetExpoSent();
    const second = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", guest.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 30, source: "heartbeat" });
    expect(second.status).toBe(200);
    await settle();
    expect(visible()).toHaveLength(0);
  });

  it("does not ring on a foreground presence, nor a member, the owner, a kicked or a blocked user", async () => {
    const owner = await createUser("owner", { radarEnabled: true });
    await createDevice(owner.user._id);
    const around = await createAroundFixture(owner.user._id, { radiusM: 150 });

    const viewer = await radarUser("viewer");
    const member = await radarUser("member");
    await addMember(around._id, member.user._id);
    const kicked = await radarUser("kicked");
    await addMember(around._id, kicked.user._id, "removed");
    const blocked = await radarUser("blocked");
    await AroundBlockModel.create({ blockerId: blocked.user._id, blockedId: owner.user._id, createdAt: new Date() });

    const post = (auth: string, source: string) =>
      request(app)
        .post("/api/users/me/location")
        .set("Authorization", auth)
        .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 20, source });

    expect((await post(viewer.auth, "foreground")).status).toBe(200);
    expect((await post(member.auth, "background")).status).toBe(200);
    expect((await post(kicked.auth, "background")).status).toBe(200);
    expect((await post(blocked.auth, "probe")).status).toBe(200);
    expect((await post(owner.auth, "background")).status).toBe(200);
    await settle();
    expect(visible()).toHaveLength(0);
    expect(await AroundRingModel.countDocuments({})).toBe(0);
  });

  it("does not ring outside radius + min(accuracy, 150) + tolerance, and caps arrivals per hour", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, { radiusM: 100 });
    const far = await radarUser("far");
    // 100 + 20 + 30 = 150 m allowed with accuracy 20: 300 m away is out.
    const out = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", far.auth)
      .send({ lat: offsetLatByMeters(LAUSANNE.lat, 300), lng: LAUSANNE.lng, accuracy: 20, source: "background" });
    expect(out.status).toBe(200);
    await settle();
    expect(visible()).toHaveLength(0);

    const capped = await radarUser("capped");
    await AroundRingModel.insertMany(
      Array.from({ length: config.arrivalRingMaxPerHour }, () => ({
        aroundId: new Types.ObjectId(),
        userId: capped.user._id,
        kind: "arrival",
        claimedAt: new Date(),
        sentAt: new Date(),
        ticketIds: []
      }))
    );
    const inside = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", capped.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 20, source: "background" });
    expect(inside.status).toBe(200);
    await settle();
    expect(visible()).toHaveLength(0);
    expect(await AroundRingModel.countDocuments({ aroundId: around._id })).toBe(0);
  });

  it("still refuses the retired source and unknown sources (400)", async () => {
    const user = await radarUser("legacy");
    const res = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", user.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 20, source: "significant-change" });
    expect(res.status).toBe(400);
  });
});

describe("wake regions", () => {
  it("never discloses the true centre: grid-aligned decoy, padded radius, capped list", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, { radiusM: 120 });

    const [region] = await wakeRegionsNear(LAUSANNE.lat, LAUSANNE.lng);
    expect(region.id).toBe(String(around._id));
    // The decoy is offset AND snapped to a 100 m grid: it can never be the
    // anchor, and probing the list cannot converge on it.
    expect(region.lat).not.toBe(LAUSANNE.lat);
    expect(region.lng).not.toBe(LAUSANNE.lng);
    const latStep = 100 / 111_320;
    expect(Math.abs(region.lat / latStep - Math.round(region.lat / latStep))).toBeLessThan(1e-6);
    // The padding must keep the whole true circle inside the monitored region.
    const offsetM = Math.hypot(
      (region.lat - LAUSANNE.lat) * 111_320,
      (region.lng - LAUSANNE.lng) * 111_320 * Math.cos((LAUSANNE.lat * Math.PI) / 180)
    );
    expect(region.radiusM).toBe(120 + 150);
    expect(offsetM + 120).toBeLessThanOrEqual(region.radiusM);

    // At most 15 regions, and only arounds within range.
    const owners = await Promise.all(Array.from({ length: 17 }, (_, i) => createUser(`owner-grid-${i}`)));
    await Promise.all(owners.map((o) => createAroundFixture(o.user._id, { radiusM: 50 })));
    expect((await wakeRegionsNear(LAUSANNE.lat, LAUSANNE.lng)).length).toBe(15);
    expect(await wakeRegionsNear(offsetLatByMeters(LAUSANNE.lat, 50_000), LAUSANNE.lng)).toHaveLength(0);
  });

  it("purging an around takes its ring claims with it", async () => {
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, { radiusM: 200 });
    const guest = await radarUser("guest");

    const post = await request(app)
      .post("/api/users/me/location")
      .set("Authorization", guest.auth)
      .send({ lat: LAUSANNE.lat, lng: LAUSANNE.lng, accuracy: 20, source: "background" });
    expect(post.status).toBe(200);
    await waitFor(async () => (await AroundRingModel.countDocuments({ aroundId: around._id })) === 1);

    expect(await purgeAround(around)).toBe(true);
    expect(await AroundRingModel.countDocuments({ aroundId: around._id })).toBe(0);
  });
});

describe("GET /api/admin/around/users/:userId/radar", () => {
  it("answers the runbook question without any coordinate", async () => {
    const { adminAuth } = await import("./helpers/fixtures.js");
    const owner = await createUser("owner");
    const around = await createAroundFixture(owner.user._id, { radiusM: 100 });
    const guest = await radarUser("guest");
    await createPresence(guest.user._id, LAUSANNE.lat, LAUSANNE.lng, { accuracy: 40, ageMs: 5 * 60_000 });

    const res = await request(app)
      .get(`/api/admin/around/users/${guest.id}/radar`)
      .query({ aroundId: String(around._id) })
      .set("Authorization", adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: guest.id, radarEnabled: true });
    expect(res.body.presence).toMatchObject({ fresh: true, accuracy: 40, source: "background" });
    expect(res.body.presence.location).toBeUndefined();
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].hasToken).toBe(true);
    expect(res.body.wouldRing).toMatchObject({ aroundFound: true, inside: true, reasons: [] });
    expect(JSON.stringify(res.body)).not.toContain(String(LAUSANNE.lng));

    const stranger = await createUser("stranger");
    const dark = await request(app)
      .get(`/api/admin/around/users/${stranger.id}/radar`)
      .query({ aroundId: String(around._id) })
      .set("Authorization", adminAuth());
    expect(dark.status).toBe(200);
    expect(dark.body.presence).toBeNull();
    expect(dark.body.wouldRing.reasons).toEqual(expect.arrayContaining(["radar_off", "no_push_device", "no_presence"]));
  });
});
