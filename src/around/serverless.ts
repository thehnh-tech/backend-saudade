import type { NextFunction, Request, Response } from "express";
import { waitUntil } from "@vercel/functions";
import { safeMinuteTick, safePurgeTick } from "./jobs.js";

// ---------------------------------------------------------------------------
// Vercel freezes the lambda the instant the response is sent: anything left
// running — a push fan-out, a background tick — is suspended mid-flight and
// usually never resumes. Every notification "sent" after res.json() on this
// platform was in fact never sent; that is how the radar shipped deaf.
//
// Two adaptations, both no-ops off Vercel:
//
//  * runDetached(): the platform-aware fire-and-forget. waitUntil() keeps the
//    lambda alive until the task settles, without delaying the response.
//  * aroundOpportunisticJobs: the setInterval jobs cannot exist between
//    requests, so the requests themselves carry them — any hit past the
//    interval boundary tows the tick along, behind its own response. Ticks
//    are idempotent by design (findOneAndUpdate claims), so two warm lambdas
//    towing the same minute is a wasted query, never a double push.
// ---------------------------------------------------------------------------

/** Fire-and-forget that survives the end of the request on serverless. */
export function runDetached(task: Promise<unknown>) {
  try {
    if (process.env.VERCEL) {
      waitUntil(task);
      return;
    }
  } catch {
    // No request context to attach to: fall through to plain detachment.
  }
  void task;
}

const MINUTE_TICK_MS = 60 * 1000;
const PURGE_TICK_MS = 15 * 60 * 1000;

// Per-instance clocks: a fresh lambda ticks on its first request, a warm one
// keeps its own cadence.
let lastMinuteTickAt = 0;
let lastPurgeTickAt = 0;

export function aroundOpportunisticJobs(req: Request, _res: Response, next: NextFunction) {
  // The cron sweep runs the ticks itself and awaits them: towing them here
  // first would leave the handler's own calls bouncing off the re-entrance
  // locks, answering {ok:true} while the work rides waitUntil.
  if (req.path.startsWith("/api/internal/")) return next();
  const now = Date.now();
  if (now - lastMinuteTickAt >= MINUTE_TICK_MS) {
    lastMinuteTickAt = now;
    runDetached(safeMinuteTick());
  }
  if (now - lastPurgeTickAt >= PURGE_TICK_MS) {
    lastPurgeTickAt = now;
    runDetached(safePurgeTick());
  }
  next();
}

/**
 * The safety net under the opportunistic ticks: a Vercel cron hits this once
 * a day, so windows close and the 7-day purge runs even across a stretch
 * with no traffic at all. Vercel sends `Authorization: Bearer <CRON_SECRET>`
 * on its own when the env var exists; anything else is turned away.
 */
export async function cronSweepHandler(req: Request, res: Response) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
  // Both ticks are AWAITED so the response attests the work: a null count
  // means another tick held the lock on this instance (the cron answers on
  // whatever lambda Vercel routes it to; the ticks are idempotent).
  const minute = await safeMinuteTick();
  const purge = await safePurgeTick();
  return res.json({ ok: true, minute, purge });
}
