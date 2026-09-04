import { AroundMemberModel, AroundModel, AroundPhotoModel, type Around } from "./models.js";
import { purgeAround } from "./purge.js";
import { notifyAroundEnding, notifyOwnerPhotoPending, processPushReceipts } from "./push.js";

// In-process jobs (setInterval + re-entrance locks). Fine for the documented
// mono-instance deployment. Both ticks are exported so tests (and ops) can run
// them directly with a controlled clock.

const ENDING_NOTICE_MS = 30 * 60 * 1000;
const OWNER_REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;

async function pendingCountFor(around: Around) {
  return AroundPhotoModel.countDocuments({ aroundId: around._id, status: "pending", purgeState: "live" });
}

// 60s tick: "ending soon" notification (idempotent via endingNotifiedAt),
// window close at captureEndsAt, owner photo-pending reminders at close and
// T+24h (no auto-approval, ever).
export type MinuteTickStats = { endingSent: number; closed: number; closeReminders: number; lateReminders: number };

export async function runAroundMinuteTick(now = new Date()): Promise<MinuteTickStats> {
  const stats: MinuteTickStats = { endingSent: 0, closed: 0, closeReminders: 0, lateReminders: 0 };

  // 1. around-ending, from T-30min until close. On Vercel a tick only runs
  // when a request tows it: if the whole T-30 window passes in a traffic
  // hole, a late notice still beats none (the $gt now bound is on step 2's
  // close, which sends its own reminder — step 1 only cares that the window
  // is still open).
  const endingSoon = await AroundModel.find({
    status: "active",
    endingNotifiedAt: null,
    captureEndsAt: { $gt: now, $lte: new Date(now.getTime() + ENDING_NOTICE_MS) }
  }).lean<Around[]>();
  for (const around of endingSoon) {
    const claimed = await AroundModel.findOneAndUpdate(
      { _id: around._id, endingNotifiedAt: null },
      { $set: { endingNotifiedAt: now } }
    ).lean<Around>();
    if (!claimed) continue;
    stats.endingSent += 1;
    await notifyAroundEnding(around).catch((error) => {
      console.error("[around:jobs] around-ending push failed", error);
    });
  }

  // 2. close windows + owner reminder at close
  const toClose = await AroundModel.find({
    status: "active",
    captureEndsAt: { $lte: now }
  }).lean<Around[]>();
  for (const around of toClose) {
    const claimed = await AroundModel.findOneAndUpdate(
      { _id: around._id, status: "active" },
      { $set: { status: "closed" } }
    ).lean<Around>();
    if (!claimed) continue;
    stats.closed += 1;
    const pending = await pendingCountFor(around);
    if (pending > 0) {
      await AroundModel.updateOne({ _id: around._id }, { $set: { closeReminderSentAt: now } });
      stats.closeReminders += 1;
      await notifyOwnerPhotoPending(around, pending).catch((error) => {
        console.error("[around:jobs] photo-pending push failed", error);
      });
    }
  }

  // 3. owner reminder T+24h after close — claimed exactly like steps 1–2:
  // two lambdas towing the same minute used to both pass the find and both
  // push (the stamp was written unconditionally after the send).
  const reminderDue = await AroundModel.find({
    status: "closed",
    pendingReminder24hSentAt: null,
    captureEndsAt: { $lte: new Date(now.getTime() - OWNER_REMINDER_DELAY_MS) },
    expiresAt: { $gt: now }
  }).lean<Around[]>();
  for (const around of reminderDue) {
    const claimed = await AroundModel.findOneAndUpdate(
      { _id: around._id, pendingReminder24hSentAt: null },
      { $set: { pendingReminder24hSentAt: now } }
    ).lean<Around>();
    if (!claimed) continue;
    const pending = await pendingCountFor(around);
    if (pending > 0) {
      stats.lateReminders += 1;
      await notifyOwnerPhotoPending(around, pending).catch((error) => {
        console.error("[around:jobs] photo-pending T+24h push failed", error);
      });
    }
  }

  if (stats.endingSent || stats.closed || stats.closeReminders || stats.lateReminders) {
    console.log(JSON.stringify({ tag: "around:tick", tick: "minute", ...stats }));
  }
  return stats;
}

// 15min tick: J+7 purge (Cloudinary-first, resumable via purgeState) + push
// receipt processing.
export type PurgeTickStats = { due: number; purged: number; incomplete: number; failed: number };

export async function runAroundPurgeTick(now = new Date()): Promise<PurgeTickStats> {
  const stats: PurgeTickStats = { due: 0, purged: 0, incomplete: 0, failed: 0 };
  const due = await AroundModel.find({
    status: { $in: ["active", "closed", "purging"] },
    expiresAt: { $lte: now }
  }).lean<Around[]>();
  stats.due = due.length;
  for (const around of due) {
    try {
      if (await purgeAround(around)) stats.purged += 1;
      else stats.incomplete += 1;
    } catch (error) {
      stats.failed += 1;
      console.error(`[around:jobs] purge failed for around ${String(around._id)}`, error);
    }
  }
  if (stats.due > 0) {
    console.log(JSON.stringify({ tag: "around:tick", tick: "purge", ...stats }));
  }

  try {
    await processPushReceipts();
  } catch (error) {
    console.error("[around:jobs] receipt processing failed", error);
  }

  // Legacy privacy sweeps: docs written before the strip-at-write erasure
  // still carry coordinates the app promises not to keep. Both updates are
  // idempotent (safe across concurrent lambdas) and match nothing once the
  // backlog is drained — (b) empties itself within 7 days, since member docs
  // of purged arounds are deleted; the whole block is then removable.
  try {
    await AroundModel.updateMany(
      { status: "purged", center: { $exists: true } },
      { $unset: { center: "" }, $set: { name: null, kickedUserIds: [] } }
    );
    await AroundMemberModel.updateMany(
      {
        $or: [
          { joinIp: { $ne: null } },
          { joinGeo: { $ne: null } },
          { "joinFixes.lat": { $exists: true } }
        ]
      },
      [
        {
          $set: {
            joinFixes: {
              $map: {
                input: "$joinFixes",
                as: "fix",
                in: {
                  accuracy: "$$fix.accuracy",
                  capturedAt: "$$fix.capturedAt",
                  distanceM: "$$fix.distanceM"
                }
              }
            }
          }
        },
        { $unset: ["joinIp", "joinGeo"] }
      ],
      // Mongoose refuses an array update without this opt-in.
      { updatePipeline: true }
    );
  } catch (error) {
    console.error("[around:jobs] legacy privacy sweep failed", error);
  }
  return stats;
}

let minuteRunning = false;
let purgeRunning = false;

/** Returns the tick's counts, or null when another tick was already running. */
export async function safeMinuteTick(): Promise<MinuteTickStats | null> {
  if (minuteRunning) return null;
  minuteRunning = true;
  try {
    return await runAroundMinuteTick();
  } catch (error) {
    console.error("[around:jobs] minute tick failed", error);
    return null;
  } finally {
    minuteRunning = false;
  }
}

export async function safePurgeTick(): Promise<PurgeTickStats | null> {
  if (purgeRunning) return null;
  purgeRunning = true;
  try {
    return await runAroundPurgeTick();
  } catch (error) {
    console.error("[around:jobs] purge tick failed", error);
    return null;
  } finally {
    purgeRunning = false;
  }
}

export function startAroundJobs() {
  setInterval(() => { void safeMinuteTick(); }, 60 * 1000).unref();
  setInterval(() => { void safePurgeTick(); }, 15 * 60 * 1000).unref();
  // Run one purge pass shortly after boot to catch up after downtime.
  setTimeout(() => { void safePurgeTick(); }, 15 * 1000).unref();
  console.log("[around:jobs] scheduled (60s window tick, 15min purge tick)");
}
