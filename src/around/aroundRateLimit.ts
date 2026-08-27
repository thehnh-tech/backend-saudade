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

export function ipKey(req: AuthedRequest) {
  return `ip:${clientIpOf(req) ?? "unknown"}`;
}

export function userKey(req: AuthedRequest) {
  return req.auth?.userId ? `user:${req.auth.userId}` : ipKey(req);
}

const registry: RateLimitMiddleware[] = [];

export function makeRateLimit(options: { windowMs: number; max: number; keyFn: KeyFn }): RateLimitMiddleware {
  const { windowMs, max, keyFn } = options;
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();

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

    if (now - lastSweep > windowMs * 2) {
      lastSweep = now;
      for (const [storedKey, timestamps] of hits) {
        const fresh = timestamps.filter((timestamp) => now - timestamp < windowMs);
        if (fresh.length === 0) hits.delete(storedKey);
        else hits.set(storedKey, fresh);
      }
    }

    return next();
  }) as RateLimitMiddleware;

  middleware.reset = () => hits.clear();
  registry.push(middleware);
  return middleware;
}

export function resetAroundRateLimits() {
  for (const limiter of registry) limiter.reset();
}

// Instances (plan): oauth 10/h/IP, location 1/30s, join 5/min, create 3/h,
// photo upload 1/10s, reports 20/day, nearby 15/min (generous for the app's
// legitimate polling, prohibitive for a city-wide scan).
export const oauthRateLimit = makeRateLimit({ windowMs: 60 * 60 * 1000, max: 10, keyFn: ipKey });
export const locationRateLimit = makeRateLimit({ windowMs: 30 * 1000, max: 1, keyFn: userKey });
export const joinRateLimit = makeRateLimit({ windowMs: 60 * 1000, max: 5, keyFn: userKey });
export const createAroundRateLimit = makeRateLimit({ windowMs: 60 * 60 * 1000, max: 3, keyFn: userKey });
export const uploadPhotoRateLimit = makeRateLimit({ windowMs: 10 * 1000, max: 1, keyFn: userKey });
export const reportRateLimit = makeRateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 20, keyFn: userKey });
export const nearbyRateLimit = makeRateLimit({ windowMs: 60 * 1000, max: 15, keyFn: userKey });
