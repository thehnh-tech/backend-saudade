import { AroundModel, AroundPhotoModel, type Around } from "./models.js";
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
export async function runAroundMinuteTick(now = new Date()) {
  // 1. around-ending T-30min
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
    void notifyAroundEnding(around).catch((error) => {
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
    const pending = await pendingCountFor(around);
    if (pending > 0) {
      await AroundModel.updateOne({ _id: around._id }, { $set: { closeReminderSentAt: now } });
      void notifyOwnerPhotoPending(around, pending).catch((error) => {
        console.error("[around:jobs] photo-pending push failed", error);
      });
    }
  }

  // 3. owner reminder T+24h after close
  const reminderDue = await AroundModel.find({
    status: "closed",
    pendingReminder24hSentAt: null,
    captureEndsAt: { $lte: new Date(now.getTime() - OWNER_REMINDER_DELAY_MS) },
    expiresAt: { $gt: now }
  }).lean<Around[]>();
  for (const around of reminderDue) {
    await AroundModel.updateOne({ _id: around._id }, { $set: { pendingReminder24hSentAt: now } });
    const pending = await pendingCountFor(around);
    if (pending > 0) {
      void notifyOwnerPhotoPending(around, pending).catch((error) => {
        console.error("[around:jobs] photo-pending T+24h push failed", error);
      });
    }
  }
}

// 15min tick: J+7 purge (Cloudinary-first, resumable via purgeState) + push
// receipt processing.
export async function runAroundPurgeTick(now = new Date()) {
  const due = await AroundModel.find({
    status: { $in: ["active", "closed", "purging"] },
    expiresAt: { $lte: now }
  }).lean<Around[]>();
  for (const around of due) {
    try {
      await purgeAround(around);
    } catch (error) {
      console.error(`[around:jobs] purge failed for around ${String(around._id)}`, error);
    }
  }

  try {
    await processPushReceipts();
  } catch (error) {
    console.error("[around:jobs] receipt processing failed", error);
  }
}

let minuteRunning = false;
let purgeRunning = false;

async function safeMinuteTick() {
  if (minuteRunning) return;
  minuteRunning = true;
  try {
    await runAroundMinuteTick();
  } catch (error) {
    console.error("[around:jobs] minute tick failed", error);
  } finally {
    minuteRunning = false;
  }
}

async function safePurgeTick() {
  if (purgeRunning) return;
  purgeRunning = true;
  try {
    await runAroundPurgeTick();
  } catch (error) {
    console.error("[around:jobs] purge tick failed", error);
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
