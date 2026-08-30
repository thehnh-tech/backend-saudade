import bcrypt from "bcryptjs";
import type { Express, Response } from "express";
import { Types } from "mongoose";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Resend } from "resend";
import { z } from "zod";
import { config } from "../config.js";
import {
  emailLoginLockout,
  emailLoginRateLimit,
  emailRegisterRateLimit,
  emailResendCooldown,
  emailResendRateLimit,
  emailVerifyRateLimit
} from "./aroundRateLimit.js";
import { authTokenFor, duplicateKeyFields, isDuplicateKeyError, pseudoRefusal } from "./identity.js";
import { invalidateUserCache, wrap, type AroundRequest } from "./middleware.js";
import {
  AroundUserModel,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_MS,
  EmailVerificationModel,
  LOCALES,
  PENDING_SIGNUP_PURGE_MS,
  PendingSignupModel,
  type AroundLocale,
  type AroundUser,
  type EmailVerification,
  type PendingSignup
} from "./models.js";
import { userResponse } from "./serializers.js";

// ---------------------------------------------------------------------------
// E-mail sign-up, mailbox verification and password sign-in. Coexists with
// Sign in with Apple (POST /api/users/oauth): an account has an appleSub, or a
// passwordHash, and the two are never merged by this module.
//
// Three properties this file exists to hold:
//
//  1. NO PLAINTEXT PASSWORD, ANYWHERE. The body field is read, hashed with
//     bcrypt cost 12 and dropped. Nothing is written to a log, an error, a
//     response or a document.
//  2. NO ACCOUNT ENUMERATION. /register and /resend answer the exact same body
//     with the exact same status whether the address is free, already taken by
//     an e-mail account or already taken by an Apple account. /login answers
//     the same 401 for an unknown address and for a wrong password. What
//     differs is only what lands in the MAILBOX, which is by definition only
//     readable by the person who owns it.
//  3. FAIL-CLOSED. Without a Resend key the code cannot be delivered, so the
//     routes refuse (503) instead of creating accounts nobody can ever verify.
// ---------------------------------------------------------------------------

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const BCRYPT_COST = 12;
const EMAIL_MAX = 254; // RFC 5321 path limit.
const RESEND_COOLDOWN_MS = 60 * 1000;

// Timing equaliser for the "unknown address" branch of /login: comparing
// against a real cost-12 digest costs the same ~400 ms as comparing against the
// victim's, so the response time does not say whether the account exists. It is
// the bcrypt hash of a throwaway string, it protects nothing and is public on
// purpose.
const DUMMY_PASSWORD_HASH = "$2a$12$cxDLZ6iYsB1CrFL6yRWB9.pn3w21VDv.o0QWSNXTydZr22BZfaeKS";

// --- code hashing ----------------------------------------------------------
// The 6-digit code is stored as HMAC-SHA256(pepper, salt || code), never in
// clear. Chosen over bcrypt after weighing the two, as the brief asks:
//
//   * The search space is 10^6. A plain sha256+salt in a leaked dump is
//     exhausted in well under a second, so a salt alone is worth nothing here.
//     bcrypt cost 12 would raise that to ~10^6 x 0.4 s ~ 5 days — longer than
//     the 15-minute lifetime, so it does work.
//   * But the HMAC key is a server-side pepper (JWT_SECRET) that is NOT in the
//     database. A dump alone therefore yields nothing at all, which is strictly
//     better than "5 days" for the only threat that matters here (stolen
//     backup / read access to the collection). An attacker who also holds the
//     process secrets can simply set emailVerifiedAt themselves — no code
//     hashing scheme survives that.
//   * And it costs ~microseconds, so /verify and /resend do not each carry a
//     400 ms bcrypt round on top of the 400 ms already spent on the password.
//
// The password is the opposite case (long-lived, user-chosen, often reused
// elsewhere) and gets bcrypt cost 12, as required.
function hashCode(code: string, salt: string) {
  return createHmac("sha256", `${config.jwtSecret}:${salt}`).update(code).digest("hex");
}

// Constant-time comparison. Both operands are 32-byte SHA-256 digests, so the
// length guard below can never be the branch that decides — it only protects
// timingSafeEqual from throwing on a corrupted document.
function codeMatches(code: string, record: Pick<EmailVerification, "codeHash" | "codeSalt">) {
  const candidate = Buffer.from(hashCode(code, record.codeSalt), "hex");
  const expected = Buffer.from(record.codeHash, "hex");
  if (candidate.length !== expected.length || expected.length === 0) return false;
  return timingSafeEqual(candidate, expected);
}

// crypto.randomInt is the CSPRNG-backed, modulo-bias-free generator. Math.random
// would be predictable from a handful of observed codes.
function generateCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

// --- mail ------------------------------------------------------------------

let resendClient: Resend | null = null;

function mailer(): Resend | null {
  if (!config.resendApiKey) return null;
  if (!resendClient) resendClient = new Resend(config.resendApiKey);
  return resendClient;
}

export function emailAuthIsAvailable() {
  return Boolean(config.resendApiKey);
}

async function sendMail(to: string, subject: string, text: string) {
  const client = mailer();
  if (!client) {
    // Unreachable through the routes (they 503 first); kept so a future caller
    // cannot silently drop a code.
    console.warn("[around:emailAuth] Resend is not configured. Mail dropped.");
    return;
  }
  const { error } = await client.emails.send({
    from: config.mailFrom,
    to,
    replyTo: config.mailReplyTo,
    subject,
    text
  });
  // Never echo the recipient or the body: the message would end up in the logs.
  if (error) throw new Error(`Resend refused an e-mail auth message: ${error.message}`);
}

const CODE_MAIL: Record<AroundLocale, (code: string) => { subject: string; text: string }> = {
  fr: (code) => ({
    subject: "Votre code de verification",
    text: [
      "Voici le code pour confirmer votre adresse e-mail :",
      "",
      code,
      "",
      "Il est valable 15 minutes et ne peut servir qu'une fois.",
      "Si vous n'avez rien demande, ignorez ce message : aucun compte ne sera utilisable sans ce code."
    ].join("\n")
  }),
  en: (code) => ({
    subject: "Your verification code",
    text: [
      "Here is the code to confirm your e-mail address:",
      "",
      code,
      "",
      "It is valid for 15 minutes and can only be used once.",
      "If you did not ask for it, ignore this message: no account can be used without this code."
    ].join("\n")
  })
};

const EXISTING_ACCOUNT_MAIL: Record<AroundLocale, { subject: string; text: string }> = {
  fr: {
    subject: "Votre adresse est deja utilisee",
    text: [
      "Quelqu'un vient de demander la creation d'un compte avec cette adresse e-mail.",
      "",
      "Un compte existe deja : connectez-vous au lieu d'en creer un nouveau.",
      "Aucun nouveau compte n'a ete cree et rien n'a change sur le votre.",
      "Si ce n'etait pas vous, vous pouvez ignorer ce message."
    ].join("\n")
  },
  en: {
    subject: "Your address is already in use",
    text: [
      "Someone just asked to create an account with this e-mail address.",
      "",
      "An account already exists: sign in instead of creating a new one.",
      "No new account was created and nothing changed on yours.",
      "If this was not you, you can ignore this message."
    ].join("\n")
  }
};

function localeOf(value: unknown): AroundLocale {
  return LOCALES.includes(value as AroundLocale) ? (value as AroundLocale) : "fr";
}

// --- verification codes ----------------------------------------------------

type CodeTarget = { _id: Types.ObjectId; email?: string | null; locale?: AroundLocale };

/**
 * Replaces the pending code of an account and mails the new one. Returns false
 * when nothing was sent because the previous code is younger than the 60s
 * cooldown — the caller must NOT surface that difference to the network, it is
 * only there to keep the automatic re-sends (register on a pending account,
 * login on an unverified one) from bombing a mailbox.
 */
async function issueVerificationCode(user: CodeTarget, options: { respectCooldown?: boolean } = {}) {
  const email = user.email ? normalizeEmail(user.email) : "";
  if (!email) return false;

  if (options.respectCooldown) {
    const pending = await EmailVerificationModel.findOne({ userId: user._id }).lean<EmailVerification>();
    if (pending && Date.now() - pending.sentAt.getTime() < RESEND_COOLDOWN_MS) return false;
  }

  const code = generateCode();
  const codeSalt = randomBytes(16).toString("hex");
  const now = new Date();

  await EmailVerificationModel.updateOne(
    { userId: user._id },
    {
      $set: {
        emailLower: email,
        codeHash: hashCode(code, codeSalt),
        codeSalt,
        // A new code resets the attempt budget; the previous one is gone.
        attempts: 0,
        expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
        sentAt: now
      },
      $setOnInsert: { userId: user._id, createdAt: now }
    },
    { upsert: true }
  );

  const body = CODE_MAIL[localeOf(user.locale)](code);
  await sendMail(email, body.subject, body.text);
  return true;
}

/** Called by DELETE /api/users/me: a deleted account leaves no pending code. */
export async function purgeEmailVerifications(userId: Types.ObjectId, email?: string | null) {
  const or: Record<string, unknown>[] = [{ userId }];
  if (email) or.push({ emailLower: normalizeEmail(email) });
  await EmailVerificationModel.deleteMany({ $or: or });
}

// --- schemas ---------------------------------------------------------------

const emailField = z.string().trim().min(3).max(EMAIL_MAX).email();

const registerSchema = z.object({
  email: emailField,
  // Length only: a composition rule ("one uppercase, one digit") narrows the
  // search space more than it widens it. 8 chars minimum, 200 maximum because
  // bcrypt itself truncates at 72 bytes and an unbounded body is a free CPU
  // burn at cost 12.
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
  pseudo: z.string().trim().min(1).max(64),
  locale: z.enum(LOCALES),
  termsVersion: z.string().trim().max(40).optional()
});

const verifySchema = z.object({
  email: emailField,
  code: z.string().trim().regex(/^\d{6}$/)
});

const resendSchema = z.object({ email: emailField });

const loginSchema = z.object({
  email: emailField,
  // Not PASSWORD_MIN: the rule may change and old accounts must stay reachable.
  password: z.string().min(1).max(PASSWORD_MAX)
});

// The single answer /register and /resend give to every caller. Built fresh on
// each call so a handler can never mutate the shared object, and identical down
// to the key order in both branches.
function acceptedResponse(email: string) {
  return {
    ok: true as const,
    status: "verification_sent" as const,
    email,
    expiresInSeconds: EMAIL_CODE_TTL_MS / 1000
  };
}

function unavailable(res: Response) {
  console.error("[around:emailAuth] RESEND_API_KEY is not configured: e-mail sign-up is refused (fail-closed).");
  return res.status(503).json({ error: "EMAIL_AUTH_UNAVAILABLE" });
}

// A mail failure must not take the HTTP call down with it: the account exists,
// the caller is told the same thing as always, and /resend is the recourse.
async function sendQuietly(task: Promise<unknown>, label: string) {
  try {
    await task;
  } catch (error) {
    console.error(`[around:emailAuth] ${label} failed`, error);
  }
}

// --- handlers --------------------------------------------------------------

export const registerEmailHandler = wrap(async (req: AroundRequest, res: Response) => {
  if (!emailAuthIsAvailable()) return unavailable(res);

  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });

  const email = normalizeEmail(parsed.data.email);
  const pseudo = parsed.data.pseudo.trim();
  const refusal = pseudoRefusal(pseudo);
  if (refusal) return res.status(400).json(refusal);
  const pseudoLower = pseudo.toLowerCase();

  // Hashed BEFORE the account lookup, in both branches, so the ~400 ms of
  // bcrypt is spent whether or not the address is taken. Without this the
  // response time alone would answer "is this address registered?".
  const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);

  const existing = await AroundUserModel.findOne({ email }).select("+passwordHash").lean<AroundUser>();
  if (existing) {
    // Anti-enumeration: the caller gets the ordinary 201. The difference goes
    // to the MAILBOX. An account that is still waiting for its first code gets
    // a fresh one (that is the honest answer to "I signed up again because I
    // never received it"); anything else is told an account already exists.
    const pending = Boolean(existing.passwordHash) && !existing.emailVerifiedAt;
    if (pending) {
      await sendQuietly(issueVerificationCode(existing, { respectCooldown: true }), "verification code");
    } else {
      const body = EXISTING_ACCOUNT_MAIL[localeOf(existing.locale)];
      await sendQuietly(sendMail(email, body.subject, body.text), "existing account notice");
    }
    return res.status(201).json(acceptedResponse(email));
  }

  // NOTHING is created in `users` here. The whole signup — hash included —
  // waits in pending_signups until the mailbox is proven; /verify is the only
  // place an e-mail account is born.
  //
  // While a pending row holds a LIVE code, its payload is untouchable: the
  // code sitting in the mailbox must always create exactly the signup that
  // requested it, or whoever re-registers the address second could swap their
  // own passwordHash under the first person's code and inherit the account
  // the moment that person verifies. So a re-register only refreshes the code
  // for the ORIGINAL payload (cooldown permitting) — the same first-writer
  // semantics the unique email index used to enforce. Once the code is dead,
  // the claim is dead with it and the row is rewritten whole.
  const existingPending = await PendingSignupModel.findOne({ emailLower: email }).lean<PendingSignup>();
  const now = new Date();

  if (existingPending && existingPending.expiresAt.getTime() > now.getTime()) {
    if (now.getTime() - existingPending.sentAt.getTime() >= RESEND_COOLDOWN_MS) {
      const code = generateCode();
      const codeSalt = randomBytes(16).toString("hex");
      await PendingSignupModel.updateOne(
        { _id: existingPending._id },
        {
          $set: {
            codeHash: hashCode(code, codeSalt),
            codeSalt,
            attempts: 0,
            expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
            sentAt: now
          }
        }
      );
      const body = CODE_MAIL[localeOf(existingPending.locale)](code);
      await sendQuietly(sendMail(email, body.subject, body.text), "verification code");
    }
    return res.status(201).json(acceptedResponse(email));
  }

  const code = generateCode();
  const codeSalt = randomBytes(16).toString("hex");
  try {
    await PendingSignupModel.updateOne(
      { emailLower: email },
      {
        $set: {
          pseudo,
          pseudoLower,
          passwordHash,
          locale: parsed.data.locale,
          termsVersion: parsed.data.termsVersion ?? "2026-08",
          termsAcceptedAt: now,
          codeHash: hashCode(code, codeSalt),
          codeSalt,
          attempts: 0,
          expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
          sentAt: now,
          purgeAt: new Date(now.getTime() + PENDING_SIGNUP_PURGE_MS)
        },
        $setOnInsert: { emailLower: email, createdAt: now }
      },
      { upsert: true }
    );
  } catch (error) {
    // Two twins racing the insert arm of the upsert: the loser's E11000 means
    // the winner's row (and mail) exist, so the uniform answer stands.
    if (isDuplicateKeyError(error)) return res.status(201).json(acceptedResponse(email));
    throw error;
  }

  const body = CODE_MAIL[localeOf(parsed.data.locale)](code);
  await sendQuietly(sendMail(email, body.subject, body.text), "verification code");
  // No token: nothing exists yet that a token could name.
  return res.status(201).json(acceptedResponse(email));
});

export const verifyEmailHandler = wrap(async (req: AroundRequest, res: Response) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });

  const email = normalizeEmail(parsed.data.email);

  // Pending signup first: since 2026-08-30 this is where every new e-mail
  // account waits, and PROVING THE CODE IS WHAT CREATES THE USER. The
  // EmailVerification path below survives for accounts created unverified by
  // the previous build.
  const pending = await PendingSignupModel.findOneAndUpdate(
    { emailLower: email },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" }
  ).lean<PendingSignup>();
  if (pending) {
    // Expiry and the 5th wrong try kill the CODE, never the row: /resend must
    // still find something to put a fresh code on, or its anti-enumeration
    // 200 would quietly promise a mail that can never come. The row itself
    // dies on its own clock (purgeAt).
    if (pending.expiresAt.getTime() <= Date.now()) {
      return res.status(410).json({ error: "CODE_EXPIRED" });
    }
    const pendingAttemptsLeft = Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - pending.attempts);
    if (!codeMatches(parsed.data.code, pending)) {
      if (pendingAttemptsLeft === 0) {
        await PendingSignupModel.updateOne(
          { _id: pending._id },
          { $set: { expiresAt: new Date(0) } }
        );
      }
      return res.status(400).json({ error: "INVALID_CODE", attemptsLeft: pendingAttemptsLeft });
    }

    // Create FIRST, discard the row after: a transient write failure here
    // must leave the signup intact for a retry, not destroy it.
    const bornAt = new Date();
    let created: AroundUser;
    try {
      const document = await AroundUserModel.create({
        pseudo: pending.pseudo,
        pseudoLower: pending.pseudoLower,
        email,
        passwordHash: pending.passwordHash,
        emailVerifiedAt: bornAt,
        locale: pending.locale,
        radarEnabled: false,
        status: "active",
        termsAcceptedAt: pending.termsAcceptedAt,
        termsVersion: pending.termsVersion ?? "2026-08",
        createdAt: bornAt,
        lastSeenAt: bornAt
      });
      created = document.toObject() as AroundUser;
    } catch (error) {
      const fields = duplicateKeyFields(error);
      // The address was claimed while the code sat in the mailbox (an Apple
      // sign-in, or another device finishing first). Nothing left to verify —
      // the winner owns the address, and the row is worthless now.
      if (fields.includes("email")) {
        await PendingSignupModel.deleteOne({ _id: pending._id });
        return res.status(409).json({ error: "EMAIL_TAKEN" });
      }
      // Stale unique pseudoLower index (pre-migration): the row survives so
      // the same code works again once syncIndexes has done its job.
      if (fields.includes("pseudoLower")) {
        return res.status(409).json({ error: "PSEUDO_TAKEN" });
      }
      throw error;
    }
    await PendingSignupModel.deleteOne({ _id: pending._id });
    return res.json({ token: authTokenFor(created), user: userResponse(created) });
  }

  // The attempt is counted BEFORE the code is looked at, so a client that
  // disconnects mid-request still burns its try.
  const record = await EmailVerificationModel.findOneAndUpdate(
    { emailLower: email },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" }
  ).lean<EmailVerification>();
  if (!record) return res.status(400).json({ error: "INVALID_CODE", attemptsLeft: 0 });

  if (record.expiresAt.getTime() <= Date.now()) {
    await EmailVerificationModel.deleteOne({ _id: record._id });
    return res.status(410).json({ error: "CODE_EXPIRED" });
  }

  const attemptsLeft = Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - record.attempts);
  if (!codeMatches(parsed.data.code, record)) {
    // 5 wrong tries invalidate the code itself: a new one must be requested.
    if (attemptsLeft === 0) await EmailVerificationModel.deleteOne({ _id: record._id });
    return res.status(400).json({ error: "INVALID_CODE", attemptsLeft });
  }

  // Single use, whatever happens next.
  await EmailVerificationModel.deleteOne({ _id: record._id });

  const user = await AroundUserModel.findById(record.userId).lean<AroundUser>();
  if (!user) return res.status(400).json({ error: "INVALID_CODE", attemptsLeft: 0 });
  if (user.status === "banned") return res.status(403).json({ error: "USER_BANNED" });

  const now = new Date();
  await AroundUserModel.updateOne(
    { _id: user._id },
    { $set: { emailVerifiedAt: user.emailVerifiedAt ?? now, lastSeenAt: now } }
  );
  invalidateUserCache(String(user._id));

  const updated = await AroundUserModel.findById(user._id).lean<AroundUser>();
  if (!updated) return res.status(400).json({ error: "INVALID_CODE", attemptsLeft: 0 });
  return res.json({ token: authTokenFor(updated), user: userResponse(updated) });
});

export const resendEmailHandler = wrap(async (req: AroundRequest, res: Response) => {
  if (!emailAuthIsAvailable()) return unavailable(res);

  const parsed = resendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });

  const email = normalizeEmail(parsed.data.email);
  const user = await AroundUserModel.findOne({ email }).select("+passwordHash").lean<AroundUser>();

  if (!user) {
    // A signup still waiting on its mailbox gets a fresh code and a fresh
    // budget; the row's TTL moves with it. Same silent 200 either way.
    const pending = await PendingSignupModel.findOne({ emailLower: email }).lean<PendingSignup>();
    if (pending) {
      const code = generateCode();
      const codeSalt = randomBytes(16).toString("hex");
      const now = new Date();
      await PendingSignupModel.updateOne(
        { _id: pending._id },
        {
          $set: {
            codeHash: hashCode(code, codeSalt),
            codeSalt,
            attempts: 0,
            expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
            sentAt: now
          }
        }
      );
      const body = CODE_MAIL[localeOf(pending.locale)](code);
      await sendQuietly(sendMail(email, body.subject, body.text), "verification code");
    }
    return res.json(acceptedResponse(email));
  }

  if (user && user.passwordHash && !user.emailVerifiedAt && user.status !== "banned") {
    await sendQuietly(issueVerificationCode(user), "verification code");
  } else if (user) {
    // Verified account, Apple-only account or banned account: no code is ever
    // issued, but the mailbox is told what happened.
    const body = EXISTING_ACCOUNT_MAIL[localeOf(user.locale)];
    await sendQuietly(sendMail(email, body.subject, body.text), "existing account notice");
  }
  // Unknown address: nothing is sent, and the answer is the same as always.

  return res.json(acceptedResponse(email));
});

export const loginEmailHandler = wrap(async (req: AroundRequest, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });

  const email = normalizeEmail(parsed.data.email);
  const user = await AroundUserModel.findOne({ email }).select("+passwordHash").lean<AroundUser>();

  // A signup that never proved its mailbox has no user row yet — it lives in
  // pending_signups. Whoever holds ITS password gets routed to the code
  // screen, exactly like an unverified legacy account; anyone else falls
  // through to the same 401 as always.
  const pending = user
    ? null
    : await PendingSignupModel.findOne({ emailLower: email }).lean<PendingSignup>();

  // Unknown address, or an address that belongs to an Apple-only account: the
  // comparison still runs (against a decoy digest) and the answer is the exact
  // same 401 as a wrong password.
  const stored = user?.passwordHash || pending?.passwordHash || DUMMY_PASSWORD_HASH;
  const passwordOk = await bcrypt.compare(parsed.data.password, stored);

  if (!user && pending && passwordOk) {
    // Fresh code only if the last one is older than the cooldown, mirroring
    // the legacy unverified branch below.
    if (Date.now() - pending.sentAt.getTime() >= RESEND_COOLDOWN_MS) {
      const code = generateCode();
      const codeSalt = randomBytes(16).toString("hex");
      const now = new Date();
      await PendingSignupModel.updateOne(
        { _id: pending._id },
        {
          $set: {
            codeHash: hashCode(code, codeSalt),
            codeSalt,
            attempts: 0,
            expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
            sentAt: now
          }
        }
      );
      const body = CODE_MAIL[localeOf(pending.locale)](code);
      await sendQuietly(sendMail(email, body.subject, body.text), "verification code");
    }
    return res.status(403).json({
      error: "EMAIL_NOT_VERIFIED",
      email,
      expiresInSeconds: EMAIL_CODE_TTL_MS / 1000
    });
  }

  if (!user || !user.passwordHash || !passwordOk) {
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  if (user.status === "banned") return res.status(403).json({ error: "USER_BANNED" });

  // Checked AFTER the password: telling an anonymous caller "this account is
  // not verified" would be an enumeration oracle. Only whoever holds the
  // password gets this answer, and they get a fresh code with it.
  if (!user.emailVerifiedAt) {
    await sendQuietly(issueVerificationCode(user, { respectCooldown: true }), "verification code");
    return res.status(403).json({
      error: "EMAIL_NOT_VERIFIED",
      email,
      expiresInSeconds: EMAIL_CODE_TTL_MS / 1000
    });
  }

  const now = new Date();
  await AroundUserModel.updateOne({ _id: user._id }, { $set: { lastSeenAt: now } });
  invalidateUserCache(String(user._id));

  return res.json({ token: authTokenFor(user), user: userResponse(user) });
});

export function registerEmailAuthRoutes(app: Express) {
  app.post("/api/users/email/register", emailRegisterRateLimit, registerEmailHandler);
  app.post("/api/users/email/verify", emailVerifyRateLimit, verifyEmailHandler);
  app.post("/api/users/email/resend", emailResendCooldown, emailResendRateLimit, resendEmailHandler);
  app.post("/api/users/email/login", emailLoginRateLimit, emailLoginLockout, loginEmailHandler);
}
