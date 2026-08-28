import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Resend is replaced by a collector: the tests read the 6-digit code out of the
// mailbox exactly like a real user would, and never out of the database.
const { sentEmails } = vi.hoisted(() => ({
  sentEmails: [] as { to: string; subject: string; text: string }[]
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (payload: { to: string; subject: string; text: string }) => {
        sentEmails.push(payload);
        return { data: { id: "mock-email" }, error: null };
      }
    };
  }
}));
vi.mock("cloudinary", async () => (await import("./helpers/mocks.js")).cloudinaryPackageMockFactory());
vi.mock("../src/cloudinary.js", async () => (await import("./helpers/mocks.js")).backendCloudinaryMockFactory());
vi.mock("expo-server-sdk", async () => (await import("./helpers/mocks.js")).expoMockFactory());

import { resetAroundRateLimits } from "../src/around/aroundRateLimit.js";
import { resetUserCache } from "../src/around/middleware.js";
import { AroundUserModel, EmailVerificationModel, type AroundUser } from "../src/around/models.js";
import { config } from "../src/config.js";
import { makeTestApp } from "./helpers/app.js";
import { clearCollections, setupTestDb, teardownTestDb } from "./helpers/db.js";
import { createUser } from "./helpers/fixtures.js";

const app = makeTestApp();

const EMAIL = "night@example.com";
const PASSWORD = "correct-horse-battery";

beforeAll(async () => {
  await setupTestDb();
  // The e-mail routes are fail-closed: without a Resend key they answer 503
  // instead of creating accounts nobody could ever verify. emailAuth.ts reads
  // the key lazily, so flipping it here (and only here) is enough — no other
  // test file is affected.
  config.resendApiKey = "test-resend-key";
});

afterAll(async () => {
  config.resendApiKey = "";
  await teardownTestDb();
});

beforeEach(async () => {
  await clearCollections();
  resetAroundRateLimits();
  resetUserCache();
  sentEmails.length = 0;
});

function register(overrides: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/users/email/register")
    .send({ email: EMAIL, password: PASSWORD, pseudo: "nightowl", locale: "en", ...overrides });
}

function lastMail() {
  const mail = sentEmails[sentEmails.length - 1];
  if (!mail) throw new Error("no e-mail was sent");
  return mail;
}

function lastCode() {
  const match = lastMail().text.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no verification code in the last e-mail: ${lastMail().subject}`);
  return match[1];
}

function otherCode(code: string) {
  return String((Number(code) + 1) % 1_000_000).padStart(6, "0");
}

async function storedUser(email = EMAIL) {
  return AroundUserModel.findOne({ email }).select("+passwordHash").lean<AroundUser>();
}

describe("POST /api/users/email/register", () => {
  it("creates an unverified account, mails a 6-digit code and issues NO token", async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      ok: true,
      status: "verification_sent",
      email: EMAIL,
      expiresInSeconds: 900
    });
    expect(res.body.token).toBeUndefined();

    expect(sentEmails).toHaveLength(1);
    expect(lastMail().to).toBe(EMAIL);
    expect(lastMail().subject).toBe("Your verification code");
    expect(lastCode()).toMatch(/^\d{6}$/);

    const user = await storedUser();
    expect(user?.emailVerifiedAt ?? null).toBeNull();
    expect(user?.locale).toBe("en");
    // The password is hashed, never stored, never echoed.
    expect(user?.passwordHash).toBeTruthy();
    expect(user?.passwordHash).not.toBe(PASSWORD);
    expect(user?.passwordHash?.startsWith("$2")).toBe(true);
    expect(JSON.stringify(user)).not.toContain(PASSWORD);

    // Only the digest of the code is persisted.
    const pending = await EmailVerificationModel.findOne({ emailLower: EMAIL }).lean();
    expect(pending?.codeHash).toBeTruthy();
    expect(pending?.codeHash).not.toBe(lastCode());
    expect(pending?.attempts).toBe(0);
  });

  it("mails the code in French when locale is fr", async () => {
    const res = await register({ locale: "fr", email: "jour@example.com" });
    expect(res.status).toBe(201);
    expect(lastMail().subject).toBe("Votre code de verification");

    const user = await storedUser("jour@example.com");
    expect(user?.locale).toBe("fr");
  });

  it("normalises the address (trim + lowercase) and matches it case-insensitively", async () => {
    const res = await register({ email: "  NightOwl@Example.COM " });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe("nightowl@example.com");
    expect(await storedUser("nightowl@example.com")).toBeTruthy();

    // The same address in another case is the SAME account: no second one.
    const again = await register({ email: "NIGHTOWL@EXAMPLE.COM", pseudo: "someoneelse" });
    expect(again.status).toBe(201);
    expect(await AroundUserModel.countDocuments()).toBe(1);
  });

  it("rejects a password shorter than 10 characters with 400 INVALID_INPUT", async () => {
    const res = await register({ password: "short1234" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_INPUT");
    expect(await AroundUserModel.countDocuments()).toBe(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("rejects a password longer than 200 characters", async () => {
    const res = await register({ password: "a".repeat(201) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_INPUT");
    expect(await AroundUserModel.countDocuments()).toBe(0);
  });

  it("filters the pseudo through checkUserText and PSEUDO_PATTERN", async () => {
    const tooShort = await register({ pseudo: "ab" });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body).toEqual({ error: "INVALID_PSEUDO" });

    const slur = await register({ pseudo: "salope" });
    expect(slur.status).toBe(400);
    expect(slur.body.error).toBe("INVALID_PSEUDO");
    expect(slur.body.reason).toBe("prohibited_term");

    const contact = await register({ pseudo: "hey.com" });
    expect(contact.status).toBe(400);
    expect(contact.body.error).toBe("INVALID_PSEUDO");
    expect(contact.body.reason).toBe("contact_info");

    expect(await AroundUserModel.countDocuments()).toBe(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("refuses a pseudo already taken (that leaks nothing about any address)", async () => {
    await createUser("nightowl");
    const res = await register();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("PSEUDO_TAKEN");
  });
});

describe("anti-enumeration", () => {
  it("answers an ALREADY REGISTERED address exactly like a free one", async () => {
    const first = await register();
    expect(first.status).toBe(201);

    // Different pseudo, same address: byte-for-byte the same answer.
    const second = await register({ pseudo: "somebodyelse" });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(second.body.token).toBeUndefined();

    // And nothing was created behind it.
    expect(await AroundUserModel.countDocuments()).toBe(1);
    expect((await storedUser())?.pseudo).toBe("nightowl");
  });

  it("answers the same for an address owned by an Apple account, and warns the mailbox", async () => {
    await createUser("appleuser", { email: "taken@example.com", locale: "fr" });

    const free = await register({ email: "free@example.com" });
    const taken = await register({ email: "taken@example.com", pseudo: "impostor" });

    expect(taken.status).toBe(free.status);
    expect(Object.keys(taken.body).sort()).toEqual(Object.keys(free.body).sort());
    expect(taken.body).toEqual({
      ok: true,
      status: "verification_sent",
      email: "taken@example.com",
      expiresInSeconds: 900
    });

    // No account was created for the impostor, and no code was issued for the
    // Apple account (a code there would be a takeover, not a verification).
    expect(await AroundUserModel.countDocuments()).toBe(2);
    expect(await EmailVerificationModel.countDocuments({ emailLower: "taken@example.com" })).toBe(0);

    // What differs is only what lands in the mailbox, in the OWNER's language.
    const notice = sentEmails.find((mail) => mail.to === "taken@example.com");
    expect(notice?.subject).toBe("Votre adresse est deja utilisee");
    expect(notice?.text).not.toMatch(/\b\d{6}\b/);
  });

  it("answers the same 401 for a wrong password and for an unknown address", async () => {
    await register();
    const code = lastCode();
    await request(app).post("/api/users/email/verify").send({ email: EMAIL, code });

    const wrongPassword = await request(app)
      .post("/api/users/email/login")
      .send({ email: EMAIL, password: "wrong-password-entirely" });
    const unknownAddress = await request(app)
      .post("/api/users/email/login")
      .send({ email: "nobody@example.com", password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAddress.status).toBe(401);
    expect(wrongPassword.body).toEqual({ error: "INVALID_CREDENTIALS" });
    expect(unknownAddress.body).toEqual(wrongPassword.body);
  });

  it("answers a resend for an unknown address like one for a real account", async () => {
    await register();
    sentEmails.length = 0;

    const known = await request(app).post("/api/users/email/resend").send({ email: EMAIL });
    const unknown = await request(app).post("/api/users/email/resend").send({ email: "ghost@example.com" });

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual({
      ok: true,
      status: "verification_sent",
      email: "ghost@example.com",
      expiresInSeconds: 900
    });
    // Only the real account got mail.
    expect(sentEmails.map((mail) => mail.to)).toEqual([EMAIL]);
  });
});

describe("POST /api/users/email/verify", () => {
  it("verifies the account, returns a JWT that works, and consumes the code", async () => {
    await register();
    const code = lastCode();

    const res = await request(app).post("/api/users/email/verify").send({ email: EMAIL, code });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user.pseudo).toBe("nightowl");
    expect(res.body.user.emailVerified).toBe(true);
    expect(res.body.user.locale).toBe("en");
    expect(res.body.user.email).toBeUndefined();

    const me = await request(app).get("/api/users/me").set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.emailVerified).toBe(true);

    // Single use: the document is gone and the same code no longer works.
    expect(await EmailVerificationModel.countDocuments()).toBe(0);
    const replay = await request(app).post("/api/users/email/verify").send({ email: EMAIL, code });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("INVALID_CODE");
  });

  it("invalidates the code after 5 wrong attempts", async () => {
    await register();
    const code = lastCode();
    const wrong = otherCode(code);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await request(app).post("/api/users/email/verify").send({ email: EMAIL, code: wrong });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_CODE");
      expect(res.body.attemptsLeft).toBe(5 - attempt);
    }

    // The code itself is burnt: even the RIGHT one is refused now.
    expect(await EmailVerificationModel.countDocuments()).toBe(0);
    const withRealCode = await request(app).post("/api/users/email/verify").send({ email: EMAIL, code });
    expect(withRealCode.status).toBe(400);
    expect(withRealCode.body.error).toBe("INVALID_CODE");
    expect((await storedUser())?.emailVerifiedAt ?? null).toBeNull();
  });

  it("refuses an expired code with 410 CODE_EXPIRED and drops it", async () => {
    await register();
    const code = lastCode();
    await EmailVerificationModel.updateOne(
      { emailLower: EMAIL },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const res = await request(app).post("/api/users/email/verify").send({ email: EMAIL, code });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe("CODE_EXPIRED");
    expect(await EmailVerificationModel.countDocuments()).toBe(0);
    expect((await storedUser())?.emailVerifiedAt ?? null).toBeNull();
  });

  it("refuses a malformed code with 400 INVALID_INPUT", async () => {
    await register();
    const res = await request(app).post("/api/users/email/verify").send({ email: EMAIL, code: "12345" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_INPUT");
  });
});

describe("POST /api/users/email/resend", () => {
  it("issues a fresh usable code and enforces the 60s cooldown with 429", async () => {
    await register();
    const firstCode = lastCode();

    const first = await request(app).post("/api/users/email/resend").send({ email: EMAIL });
    expect(first.status).toBe(200);
    const secondCode = lastCode();
    expect(sentEmails).toHaveLength(2);

    const throttled = await request(app).post("/api/users/email/resend").send({ email: EMAIL });
    expect(throttled.status).toBe(429);
    expect(throttled.body.error).toBe("RATE_LIMITED");
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(sentEmails).toHaveLength(2);

    // The new code replaces the old one.
    const stale = await request(app).post("/api/users/email/verify").send({ email: EMAIL, code: firstCode });
    expect(stale.status).toBe(400);
    const fresh = await request(app).post("/api/users/email/verify").send({ email: EMAIL, code: secondCode });
    expect(fresh.status).toBe(200);
  });
});

describe("POST /api/users/email/login", () => {
  it("refuses an unverified account with 403 EMAIL_NOT_VERIFIED and re-sends a code", async () => {
    await register();
    sentEmails.length = 0;

    const res = await request(app).post("/api/users/email/login").send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("EMAIL_NOT_VERIFIED");
    expect(res.body.token).toBeUndefined();
    // The code sent at registration is younger than the 60s cooldown, so the
    // mailbox is not bombed for a user tapping "sign in" twice.
    expect(sentEmails).toHaveLength(0);

    // Once the cooldown has passed, signing in mails a usable code again.
    await EmailVerificationModel.updateOne(
      { emailLower: EMAIL },
      { $set: { sentAt: new Date(Date.now() - 2 * 60 * 1000) } }
    );
    const again = await request(app).post("/api/users/email/login").send({ email: EMAIL, password: PASSWORD });
    expect(again.status).toBe(403);
    expect(sentEmails).toHaveLength(1);

    const verified = await request(app)
      .post("/api/users/email/verify")
      .send({ email: EMAIL, code: lastCode() });
    expect(verified.status).toBe(200);
  });

  it("signs a verified account in and returns the same shape as /oauth", async () => {
    await register();
    await request(app).post("/api/users/email/verify").send({ email: EMAIL, code: lastCode() });

    const res = await request(app).post("/api/users/email/login").send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user.id).toBeTruthy();
    expect(res.body.user.pseudo).toBe("nightowl");
    expect(res.body.user.emailVerified).toBe(true);

    const me = await request(app).get("/api/users/me").set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
  });

  it("refuses an Apple-only account with the generic 401 (no password to compare)", async () => {
    await createUser("appleonly", { email: "apple@example.com" });
    const res = await request(app)
      .post("/api/users/email/login")
      .send({ email: "apple@example.com", password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_CREDENTIALS" });
  });
});

describe("secret leakage", () => {
  it("never returns passwordHash, the code or its digest in any response", async () => {
    const registerRes = await register();
    const code = lastCode();
    const pending = await EmailVerificationModel.findOne({ emailLower: EMAIL }).lean();
    const codeHash = String(pending?.codeHash);

    const verifyRes = await request(app).post("/api/users/email/verify").send({ email: EMAIL, code });
    const loginRes = await request(app).post("/api/users/email/login").send({ email: EMAIL, password: PASSWORD });
    const meRes = await request(app)
      .get("/api/users/me")
      .set("Authorization", `Bearer ${loginRes.body.token}`);
    const patchRes = await request(app)
      .patch("/api/users/me")
      .set("Authorization", `Bearer ${loginRes.body.token}`)
      .send({ locale: "fr" });

    const user = await storedUser();
    const secrets = [PASSWORD, code, codeHash, String(user?.passwordHash)];
    for (const res of [registerRes, verifyRes, loginRes, meRes, patchRes]) {
      const payload = JSON.stringify(res.body);
      expect(payload).not.toContain("passwordHash");
      expect(payload).not.toContain("codeHash");
      for (const secret of secrets) expect(payload).not.toContain(secret);
    }
  });
});

describe("account fields", () => {
  it("PATCH /api/users/me updates the locale and userResponse echoes it", async () => {
    await register();
    const verified = await request(app)
      .post("/api/users/email/verify")
      .send({ email: EMAIL, code: lastCode() });
    const auth = `Bearer ${verified.body.token}`;
    expect(verified.body.user.locale).toBe("en");

    const res = await request(app).patch("/api/users/me").set("Authorization", auth).send({ locale: "fr" });
    expect(res.status).toBe(200);
    expect(res.body.user.locale).toBe("fr");
    expect(res.body.user.emailVerified).toBe(true);

    const bogus = await request(app).patch("/api/users/me").set("Authorization", auth).send({ locale: "de" });
    expect(bogus.status).toBe(400);
    expect(bogus.body.error).toBe("INVALID_INPUT");
  });

  it("DELETE /api/users/me purges the pending verification codes", async () => {
    await register();
    const verified = await request(app)
      .post("/api/users/email/verify")
      .send({ email: EMAIL, code: lastCode() });
    // A code issued after the account was verified (e.g. an address change
    // flow) must not survive the deletion either.
    await request(app).post("/api/users/email/resend").send({ email: EMAIL });

    const res = await request(app)
      .delete("/api/users/me")
      .set("Authorization", `Bearer ${verified.body.token}`);
    expect(res.status).toBe(200);
    expect(await EmailVerificationModel.countDocuments()).toBe(0);
    expect(await AroundUserModel.countDocuments()).toBe(0);
  });
});

describe("fail-closed", () => {
  it("refuses to sign anyone up with 503 when Resend is not configured", async () => {
    config.resendApiKey = "";
    try {
      const res = await register();
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("EMAIL_AUTH_UNAVAILABLE");
      expect(await AroundUserModel.countDocuments()).toBe(0);

      const resend = await request(app).post("/api/users/email/resend").send({ email: EMAIL });
      expect(resend.status).toBe(503);
    } finally {
      config.resendApiKey = "test-resend-key";
    }
  });
});
