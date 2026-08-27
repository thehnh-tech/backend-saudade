import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../types.js";
import { clientIpOf } from "./geoUtils.js";

// Sliding-window in-memory rate limiter, same 429 contract as the existing
// rateLimit.ts ({error:"RATE_LIMITED"} + Retry-After header). In-memory is
// fine for the documented mono-instance deployment.

type KeyFn = (req: AuthedRequest) => string;

export type RateLimitMiddleware = ((req: AuthedRequest, res: Response, next: NextFunction) => void) & {
  reset: () => void;
};

// Hard ceiling on the number of tracked keys, aligned with the user cache of
// middleware.ts. Without it a flood of unique keys (one per source IP) grows
// the Map without bound between sweeps.
const MAX_KEYS = 10_000;

// IPv6: a single client is routinely handed a whole /64, so keying on the full
// address lets it rotate through 2^64 addresses and defeat every limit. Bucket
// IPv6 on its /64 prefix; IPv4 (including the ::ffff:a.b.c.d mapped form) stays
// keyed on the exact address.
function ipBucket(raw: string): string {
  const value = raw.trim().toLowerCase().split("%")[0].replace(/^::ffff:/, "");
  if (!value.includes(":")) return value;
  let parts: string[];
  if (value.includes("::")) {
    const [head, tail] = value.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const fill = Math.max(0, 8 - headParts.length - tailParts.length);
    parts = [...headParts, ...Array(fill).fill("0"), ...tailParts];
  } else {
    parts = value.split(":");
  }
  return `${parts.slice(0, 4).map((part) => (part || "0").padStart(4, "0")).join(":")}::/64`;
}

export function ipKey(req: AuthedRequest) {
  const raw = clientIpOf(req);
  return `ip:${raw ? ipBucket(raw) : "unknown"}`;
}

export function userKey(req: AuthedRequest) {
  return req.auth?.userId ? `user:${req.auth.userId}` : ipKey(req);
}

const registry: { reset: () => void }[] = [];

export function makeRateLimit(options: {
  windowMs: number;
  max: number;
  keyFn: KeyFn;
  // When provided, a response whose status matches releases the slot the
  // request consumed: only the statuses that are NOT released count against
  // the quota. Used by the OAuth limiter so a legitimate sign-in does not
  // burn quota shared by everyone behind the same NAT.
  releaseWhen?: (statusCode: number) => boolean;
}): RateLimitMiddleware {
  const { windowMs, max, keyFn, releaseWhen } = options;
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();
  // Sweep at least once a minute instead of once every 2 windows: with a 24 h
  // window the old rule swept every 48 h and the Map grew unbounded meanwhile.
  const sweepEveryMs = Math.min(windowMs, 60_000);

  const middleware = ((req: AuthedRequest, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = keyFn(req);
    const bucket = (hits.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);

    if (bucket.length >= max) {
      const oldest = Math.min(...bucket);
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "RATE_LIMITED", retryAfterSeconds: retryAfter });
    }

    bucket.push(now);
    hits.set(key, bucket);

    if (releaseWhen) {
      res.on("finish", () => {
        if (!releaseWhen(res.statusCode)) return;
        const current = hits.get(key);
        if (!current) return;
        const index = current.indexOf(now);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) hits.delete(key);
      });
    }

    if (now - lastSweep > sweepEveryMs || hits.size > MAX_KEYS) {
      lastSweep = now;
      for (const [storedKey, timestamps] of hits) {
        const fresh = timestamps.filter((timestamp) => now - timestamp < windowMs);
        if (fresh.length === 0) hits.delete(storedKey);
        else hits.set(storedKey, fresh);
      }
      // A sweep frees nothing when every entry is still fresh (a 1 h window
      // under a flood of unique IPs): fall back to hard eviction in insertion
      // order (Map preserves it), never evicting the current request's key.
      if (hits.size > MAX_KEYS) {
        let toEvict = hits.size - MAX_KEYS;
        for (const storedKey of hits.keys()) {
          if (toEvict-- <= 0) break;
          if (storedKey !== key) hits.delete(storedKey);
        }
      }
    }

    return next();
  }) as RateLimitMiddleware;

  middleware.reset = () => hits.clear();
  registry.push(middleware);
  return middleware;
}

// Progressive lockout: on top of the sliding window, N consecutive failures on
// the same key lock it for a duration that doubles with every further failure.
// The window limiter alone caps an attacker at `max` tries per window forever;
// the lockout makes a sustained campaign cost exponentially more time.
export function makeProgressiveLockout(options: {
  keyFn: KeyFn;
  threshold: number;
  baseLockMs: number;
  maxLockMs: number;
  // Consecutive-failure counter is forgotten after this much idle time.
  decayMs: number;
}): RateLimitMiddleware {
  const { keyFn, threshold, baseLockMs, maxLockMs, decayMs } = options;
  const state = new Map<string, { failures: number; lockedUntil: number; lastFailureAt: number }>();

  const middleware = ((req: AuthedRequest, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = keyFn(req);
    const entry = state.get(key);

    if (entry) {
      if (entry.lockedUntil > now) {
        const retryAfter = Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(429).json({ error: "RATE_LIMITED", retryAfterSeconds: retryAfter });
      }
      if (now - entry.lastFailureAt > decayMs) state.delete(key);
    }

    res.on("finish", () => {
      const at = Date.now();
      const status = res.statusCode;
      // 2xx = the credentials were right: clear the counter.
      if (status >= 200 && status < 300) {
        state.delete(key);
        return;
      }
      // Only an actual credential rejection counts. 400 (malformed body) and
      // 429 (already throttled) must neither arm nor clear the lockout.
      if (status !== 401) return;

      const current = state.get(key) ?? { failures: 0, lockedUntil: 0, lastFailureAt: at };
      current.failures += 1;
      current.lastFailureAt = at;
      if (current.failures >= threshold) {
        const factor = 2 ** (current.failures - threshold);
        current.lockedUntil = at + Math.min(baseLockMs * factor, maxLockMs);
      }
      state.set(key, current);

      if (state.size > MAX_KEYS) {
        for (const [storedKey, stored] of state) {
          if (at - stored.lastFailureAt > decayMs && stored.lockedUntil < at) state.delete(storedKey);
        }
      }
    });

    return next();
  }) as RateLimitMiddleware;

  middleware.reset = () => state.clear();
  registry.push(middleware);
  return middleware;
}

export function resetAroundRateLimits() {
  for (const limiter of registry) limiter.reset();
}

// Instances (plan): oauth 30/h/IP failures only, location 1/30s, join 5/min,
// create 3/h, photo upload 1/10s, reports 20/day, nearby 15/min (generous for
// the app's legitimate polling, prohibitive for a city-wide scan).

// OAuth is mounted BEFORE the identity token is verified, and the product
// scenario is a party: 30 people share the venue's NAT (or a carrier CGNAT).
// A flat 10/h/IP locked the whole venue out. Two changes keep the bruteforce
// closed while unblocking the venue: the budget is raised to 30/h, and only
// FAILED attempts consume it — 200/201 (signed in) and 409 (PSEUDO_REQUIRED /
// PSEUDO_TAKEN, normal steps of the two-call signup) release their slot.
// An attacker sending bogus tokens only ever gets 400/401/403, so they stay
// capped at 30 failures per hour per IP (per /64 for IPv6).
export const oauthRateLimit = makeRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyFn: ipKey,
  releaseWhen: (status) => status === 200 || status === 201 || status === 409
});
export const locationRateLimit = makeRateLimit({ windowMs: 30 * 1000, max: 1, keyFn: userKey });
export const joinRateLimit = makeRateLimit({ windowMs: 60 * 1000, max: 5, keyFn: userKey });
export const createAroundRateLimit = makeRateLimit({ windowMs: 60 * 60 * 1000, max: 3, keyFn: userKey });
export const uploadPhotoRateLimit = makeRateLimit({ windowMs: 10 * 1000, max: 1, keyFn: userKey });
export const deletePhotoRateLimit = makeRateLimit({ windowMs: 10 * 1000, max: 3, keyFn: userKey });
export const reportRateLimit = makeRateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 20, keyFn: userKey });
export const nearbyRateLimit = makeRateLimit({ windowMs: 60 * 1000, max: 15, keyFn: userKey });
export const deviceRateLimit = makeRateLimit({ windowMs: 60 * 1000, max: 10, keyFn: userKey });

// Admin auth. A single static shared password guards the whole moderation
// surface, so this route gets both a strict window (5 tries / 15 min / IP) and
// a progressive lockout (5 consecutive 401s => 5 min, doubling up to 1 h).
// ipKey -> clientIpOf -> req.ip, derived from `trust proxy: 1` (server.ts), so
// the key cannot be forged with an X-Forwarded-For header.
export const adminLoginRateLimit = makeRateLimit({ windowMs: 15 * 60 * 1000, max: 5, keyFn: ipKey });
export const adminLoginLockout = makeProgressiveLockout({
  keyFn: ipKey,
  threshold: 5,
  baseLockMs: 5 * 60 * 1000,
  maxLockMs: 60 * 60 * 1000,
  decayMs: 60 * 60 * 1000
});
