import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../types.js";
import { isDuplicateKeyError } from "./identity.js";
import { RateLimitCounterModel } from "./models.js";

// Mongo-backed twins of aroundRateLimit.ts's window limiter and progressive
// lockout, for the limiters that are SECURITY controls: in-memory state
// multiplies by the number of warm lambdas on the serverless deployment
// (nearby anti-scan, login lockouts...), and resets on every cold start.
//
// Design constraints these implementations answer:
//  * One atomic write per decision — never read-modify-write across lambdas.
//  * Correctness never depends on the TTL reaper (it lags by design): the
//    window start lives in the key, the lockout decay is re-checked at read.
//  * Failure writes happen BEFORE the response leaves (res.json interception),
//    not in res.on("finish"): Vercel freezes the lambda the instant the
//    response is sent, so a post-response write would pass every mono-process
//    test and never arm in production — the exact bug class serverless.ts
//    documents for the push fan-out.
//  * A store error is a 500 (fail closed), never a free pass; these routes
//    all talk to Mongo anyway.

type KeyFn = (req: AuthedRequest) => string;

export type SharedRateLimitMiddleware = (req: AuthedRequest, res: Response, next: NextFunction) => void;

function refuse(res: Response, untilMs: number, now: number) {
  const retryAfter = Math.max(1, Math.ceil((untilMs - now) / 1000));
  res.setHeader("Retry-After", String(retryAfter));
  return res.status(429).json({ error: "RATE_LIMITED", retryAfterSeconds: retryAfter });
}

/**
 * Fixed-window counter: one upserted $inc per request, window start baked
 * into the _id. A straddling pair of windows admits up to 2x the nominal
 * budget in the worst case — acceptable for every mounted instance (30/min
 * of nearby is still prohibitive for a city scan) and the price of needing
 * no sliding state.
 */
export function makeSharedRateLimit(options: {
  name: string;
  windowMs: number;
  max: number;
  keyFn: KeyFn;
}): SharedRateLimitMiddleware {
  const { name, windowMs, max, keyFn } = options;

  return (req, res, next) => {
    void (async () => {
      const now = Date.now();
      const windowStart = now - (now % windowMs);
      const _id = `${name}:${keyFn(req)}:${windowStart}`;
      const bump = { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + 2 * windowMs) } };
      let doc;
      try {
        doc = await RateLimitCounterModel.findOneAndUpdate({ _id }, bump, {
          upsert: true,
          returnDocument: "after"
        }).lean();
      } catch (error) {
        // Two lambdas racing the first hit of a (key, window): one upsert
        // loses with E11000. Retry once without upserting — the doc exists.
        if (!isDuplicateKeyError(error)) throw error;
        doc = await RateLimitCounterModel.findOneAndUpdate({ _id }, bump, {
          returnDocument: "after"
        }).lean();
      }
      if ((doc?.count ?? 1) > max) {
        return refuse(res, windowStart + windowMs, now);
      }
      return next();
    })().catch(next);
  };
}

/**
 * Progressive lockout: N consecutive 401s on a key lock it for a duration
 * that doubles with each further failure. The counter maths run in ONE
 * aggregation-pipeline update, so concurrent failures on different lambdas
 * can never lose increments to a read-modify-write race.
 */
export function makeSharedLockout(options: {
  name: string;
  keyFn: KeyFn;
  threshold: number;
  baseLockMs: number;
  maxLockMs: number;
  decayMs: number;
}): SharedRateLimitMiddleware {
  const { name, keyFn, threshold, baseLockMs, maxLockMs, decayMs } = options;
  if (maxLockMs > decayMs) {
    // The read treats a lock whose last failure is past decay as expired,
    // and the TTL reaps at lastFailureAt + decayMs: a longer lock would be
    // silently truncated. Fail at construction, not in production behavior.
    throw new Error(`makeSharedLockout(${name}): maxLockMs must be <= decayMs`);
  }

  return (req, res, next) => {
    void (async () => {
      const now = Date.now();
      const _id = `lock:${name}:${keyFn(req)}`;
      const doc = await RateLimitCounterModel.findById(_id).lean();
      if (
        doc?.lockedUntil &&
        doc.lockedUntil.getTime() > now &&
        doc.lastFailureAt &&
        now - doc.lastFailureAt.getTime() <= decayMs
      ) {
        return refuse(res, doc.lockedUntil.getTime(), now);
      }

      // The verdict (2xx clears, 401 counts, everything else is neutral) only
      // exists when the handler answers: intercept res.json so the write
      // completes BEFORE the response leaves the lambda. Both login handlers
      // answer through res.json on every path.
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        const status = res.statusCode;
        const write =
          status >= 200 && status < 300
            ? RateLimitCounterModel.deleteOne({ _id }).exec()
            : status === 401
              ? recordFailure(_id)
              : null;
        if (!write) return originalJson(body);
        void write
          .catch((error) => console.error(`[around:lockout] ${name} write failed`, error))
          .finally(() => originalJson(body));
        return res;
      }) as typeof res.json;

      return next();
    })().catch(next);
  };

  function recordFailure(_id: string) {
    const at = Date.now();
    const attempt = () => writeFailure(_id, at);
    return attempt().catch((error) => {
      // Two strictly concurrent FIRST failures race the upsert; the loser
      // can surface E11000. The doc exists by then: one retry applies the
      // pipeline to it instead of losing the count.
      if (!isDuplicateKeyError(error)) throw error;
      return attempt();
    });
  }

  function writeFailure(_id: string, at: number) {
    return RateLimitCounterModel.updateOne(
      { _id },
      [
        {
          $set: {
            failures: {
              $add: [
                {
                  $cond: [
                    // Consecutive-failure counter forgotten after decayMs idle.
                    {
                      $gt: [
                        { $subtract: [at, { $toLong: { $ifNull: ["$lastFailureAt", new Date(0)] } }] },
                        decayMs
                      ]
                    },
                    0,
                    { $ifNull: ["$failures", 0] }
                  ]
                },
                1
              ]
            },
            lastFailureAt: new Date(at)
          }
        },
        {
          $set: {
            lockedUntil: {
              $cond: [
                { $gte: ["$failures", threshold] },
                {
                  $toDate: {
                    $add: [
                      at,
                      {
                        $min: [
                          { $multiply: [baseLockMs, { $pow: [2, { $subtract: ["$failures", threshold] }] }] },
                          maxLockMs
                        ]
                      }
                    ]
                  }
                },
                { $ifNull: ["$lockedUntil", null] }
              ]
            },
            expiresAt: { $toDate: { $add: [at, decayMs] } }
          }
        }
      ],
      { upsert: true, updatePipeline: true }
    ).exec();
  }
}
