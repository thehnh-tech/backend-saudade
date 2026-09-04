import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { Types } from "mongoose";
import { config } from "../config.js";
import { haversineMeters } from "./geoUtils.js";
import {
  AROUND_MAX_RADIUS_M,
  AroundBlockModel,
  AroundDeviceModel,
  AroundMemberModel,
  AroundModel,
  AroundUserModel,
  DevicePresenceModel,
  PushReceiptModel,
  type Around,
  type AroundLocale,
  type PresenceSource
} from "./models.js";
import { arrivalRingsInLastHour, claimRing, claimRings, markRingsSent, releaseRing, releaseRings } from "./rings.js";

// Expo push pipeline. Every entry point is designed to be called
// fire-and-forget (`runDetached(notifyX(...).catch(...))`) — a push failure
// must never block or fail an API request. Payloads NEVER contain coordinates
// (presence leak): only {type, aroundId, name?, kind?}.
//
// Observability (2026-09-03): every fan-out, ring and probe writes ONE
// structured JSON line (tag "around:fanout" / "around:ring" / "around:probe")
// with counts — never user ids, never coordinates — and every Expo ticket or
// receipt error is counted by code instead of being dropped. The per-user
// trail lives in around_rings and is served by the admin radar route.

const expo = new Expo();

// Defence in depth on the ONE piece of attacker-controlled text this pipeline
// carries: around.name. It is filtered at creation (textFilter.ts), but a
// filter is a guard, not a guarantee, so the push layer never trusts it either.
//
// Two rules, and they differ on purpose:
//  1. Length. A 60-character name is truncated to 40 before it is put anywhere
//     in a notification, and its whitespace is collapsed (a name padded with
//     newlines could otherwise push the body off a lock screen).
//  2. Placement. For the three notifications that go to people who are already
//     members (photo pending/approved, around ending) the name stays the title:
//     they joined that around and see the name in the app anyway, and the title
//     is what makes the notification useful.
//     For the fan-out at creation and the arrival ring — the only ones
//     delivered to STRANGERS who never opted into this around — the title is
//     the neutral, constant product name and the around's name moves into the
//     body. A hostile name then no longer renders as the bold headline of a
//     notification on a stranger's locked screen; it reads as quoted
//     third-party text inside a sentence the app wrote, which is what it is.
const MAX_PUSH_NAME_CHARS = 40;

export function pushSafeName(name?: string | null): string | null {
  if (typeof name !== "string") return null;
  const collapsed = name.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_PUSH_NAME_CHARS
    ? `${collapsed.slice(0, MAX_PUSH_NAME_CHARS - 1)}…`
    : collapsed;
}

// "around-created" is also the type of the ARRIVAL ring (same deep link, same
// copy; `kind: "arrival"` in the data tells them apart). "presence-probe" is
// the silent wake-up push: no title, no body, data only.
export type AroundPushType = "around-created" | "photo-pending" | "photo-approved" | "around-ending" | "presence-probe";

type PushTarget = {
  userId: Types.ObjectId;
  expoPushToken: string;
  /** The account's interface language: notifications follow it, not the device. */
  locale: AroundLocale;
};

/**
 * Notification copy, per type and per language.
 *
 * Two things were wrong before this table existed. Every body was written in
 * French with the accents stripped, which is what an English-speaking user
 * received too — including the one notification the whole product rests on.
 * And the strings lived inline at each call site, so the copy a user reads
 * could only be found by reading the send code. Titles stay next to their
 * bodies here for the same reason.
 *
 * `name` is user-supplied text, already filtered (textFilter.ts) and clamped
 * (pushSafeName). For the two notifications that reach STRANGERS it never
 * becomes the title — see the note on pushSafeName above.
 */
const NEUTRAL_PUSH_TITLE = "Picture me around";

type Copy = { title: string; body: string };

const PUSH_COPY = {
  /** Creation fan-out and arrival ring — reaches people who never opted into this around. */
  "around-created": {
    fr: (name: string | null): Copy => ({
      title: NEUTRAL_PUSH_TITLE,
      body: name
        ? `« ${name} » vient de s'ouvrir près de toi. Rejoins-le tant que tu es dans le rayon.`
        : "Un around vient de s'ouvrir près de toi. Rejoins-le tant que tu es dans le rayon."
    }),
    en: (name: string | null): Copy => ({
      title: NEUTRAL_PUSH_TITLE,
      body: name
        ? `“${name}” just opened near you. Join it while you are inside the radius.`
        : "An around just opened near you. Join it while you are inside the radius."
    })
  },
  "photo-approved": {
    fr: (name: string | null): Copy => ({
      title: name ?? NEUTRAL_PUSH_TITLE,
      body: "Ta photo vient d'être débloquée pour tout le cercle."
    }),
    en: (name: string | null): Copy => ({
      title: name ?? NEUTRAL_PUSH_TITLE,
      body: "Your photo has just been unlocked for the whole circle."
    })
  },
  "photo-pending": {
    fr: (name: string | null, count = 1): Copy => ({
      title: name ?? NEUTRAL_PUSH_TITLE,
      body: `${count} photo${count > 1 ? "s" : ""} en attente d'approbation dans ton around.`
    }),
    en: (name: string | null, count = 1): Copy => ({
      title: name ?? NEUTRAL_PUSH_TITLE,
      body: `${count} photo${count > 1 ? "s" : ""} waiting for your approval in your around.`
    })
  },
  "around-ending": {
    fr: (name: string | null): Copy => ({
      title: name ?? NEUTRAL_PUSH_TITLE,
      body: "Dernière demi-heure : la fenêtre de capture ferme bientôt."
    }),
    en: (name: string | null): Copy => ({
      title: name ?? NEUTRAL_PUSH_TITLE,
      body: "Last half hour: the capture window closes soon."
    })
  }
} satisfies Record<string, Record<AroundLocale, (name: string | null, count?: number) => Copy>>;

export function pushCopy(
  type: keyof typeof PUSH_COPY,
  locale: AroundLocale,
  name: string | null,
  count?: number
): Copy {
  const table = PUSH_COPY[type];
  return (table[locale] ?? table.fr)(name, count);
}

export type SendStats = {
  messages: number;
  ticketsOk: number;
  // Expo ticket-level errors by code (DeviceNotRegistered, InvalidCredentials,
  // MessageRateExceeded, MessageTooBig, MismatchSenderId, ...).
  ticketErrors: Record<string, number>;
  // Chunks Expo refused as a whole (network, 4xx) and had to be retried one
  // message at a time.
  chunkFailures: number;
  ticketIdsByUser: Map<string, string[]>;
};

function emptyStats(): SendStats {
  return { messages: 0, ticketsOk: 0, ticketErrors: {}, chunkFailures: 0, ticketIdsByUser: new Map() };
}

function bump(counter: Record<string, number>, code: string) {
  counter[code] = (counter[code] ?? 0) + 1;
}

async function invalidatePushToken(expoPushToken: string) {
  await AroundDeviceModel.updateMany(
    { expoPushToken },
    { $set: { invalidatedAt: new Date() }, $unset: { expoPushToken: "" } }
  );
}

export async function pushTargetsForUsers(userIds: Types.ObjectId[]): Promise<PushTarget[]> {
  if (userIds.length === 0) return [];
  const devices = await AroundDeviceModel.find({
    userId: { $in: userIds },
    expoPushToken: { $exists: true, $ne: null },
    pushEnabled: true,
    invalidatedAt: null
  }).lean();
  const reachable = devices.filter(
    (device) => typeof device.expoPushToken === "string" && Expo.isExpoPushToken(device.expoPushToken)
  );
  if (reachable.length === 0) return [];
  // The language belongs to the ACCOUNT, not the device: it is chosen at
  // sign-up and follows the person from one install to the next.
  const users = await AroundUserModel.find(
    { _id: { $in: [...new Set(reachable.map((device) => String(device.userId)))].map((id) => new Types.ObjectId(id)) } },
    { locale: 1 }
  ).lean();
  const localeById = new Map(users.map((user) => [String(user._id), user.locale ?? "fr"]));
  return reachable.map((device) => ({
    userId: device.userId,
    expoPushToken: device.expoPushToken as string,
    locale: (localeById.get(String(device.userId)) ?? "fr") as AroundLocale
  }));
}

type ReceiptRow = {
  ticketId: string;
  expoPushToken: string;
  userId: Types.ObjectId | null;
  type: AroundPushType;
  createdAt: Date;
};

/**
 * One insertMany per chunk instead of one insert per ticket. A probe fan-out
 * can be 500 messages, and 500 sequential Atlas round-trips inside the
 * detached continuation of POST /api/arounds burn the lambda's remaining
 * budget — the tail of the work (the log line, the later chunks) was being
 * cut exactly when it mattered. Unordered: one bad row must not drop the rest,
 * and a receipt row is a diagnostic, never a reason to fail a send.
 */
async function flushReceipts(rows: ReceiptRow[]) {
  if (rows.length === 0) return;
  try {
    await PushReceiptModel.insertMany(rows, { ordered: false });
  } catch (error) {
    console.error(`[around:push] receipt insert failed (${rows.length} rows)`, error);
  }
  rows.length = 0;
}

async function recordTicket(
  ticket: ExpoPushTicket,
  message: ExpoPushMessage,
  type: AroundPushType,
  tokenOwners: Map<string, Types.ObjectId>,
  stats: SendStats,
  receipts: ReceiptRow[]
) {
  const token = typeof message.to === "string" ? message.to : message.to[0];
  if (ticket.status === "ok") {
    stats.ticketsOk += 1;
    const owner = tokenOwners.get(token);
    if (owner) {
      const key = String(owner);
      stats.ticketIdsByUser.set(key, [...(stats.ticketIdsByUser.get(key) ?? []), ticket.id]);
    }
    receipts.push({
      ticketId: ticket.id,
      expoPushToken: token,
      userId: owner ?? null,
      type,
      createdAt: new Date()
    });
    return;
  }
  const code = ticket.details?.error ?? "unknown";
  bump(stats.ticketErrors, code);
  if (code === "DeviceNotRegistered") {
    await invalidatePushToken(token);
  }
}

/**
 * Sends one message per target. A chunk Expo refuses as a whole (one foreign
 * token poisons the batch, a transient 4xx/5xx) is retried one message at a
 * time so a single bad row cannot silence 99 good ones; a message that fails
 * alone is counted under "chunk" and its token invalidated when the error is
 * a permanent Expo refusal.
 */
async function sendToTargets(
  targets: PushTarget[],
  type: AroundPushType,
  /** Resolved per recipient, so one send can carry two languages. */
  copyFor: ((locale: AroundLocale) => Copy) | null,
  data: Record<string, unknown>,
  options: { silent?: boolean; ttlS?: number } = {}
): Promise<SendStats> {
  const stats = emptyStats();
  if (targets.length === 0) return stats;
  const tokenOwners = new Map<string, Types.ObjectId>();
  const messages: ExpoPushMessage[] = targets.map((target) => {
    tokenOwners.set(target.expoPushToken, target.userId);
    const message: ExpoPushMessage = { to: target.expoPushToken, data };
    if (options.silent) {
      // content-available, no alert: iOS wakes the app's background
      // notification task without showing anything (budgeted by iOS, never
      // delivered to a force-quit app). "normal" is apns-priority 5, which is
      // what Apple requires for a payload carrying only content-available;
      // priority 10 on such a payload is documented as an error and can be
      // dropped without any trace in the tickets or the receipts.
      message._contentAvailable = true;
      message.priority = "normal";
    } else {
      message.sound = "default";
      const copy = copyFor?.(target.locale);
      if (copy?.title) message.title = copy.title;
      if (copy?.body) message.body = copy.body;
    }
    if (typeof options.ttlS === "number" && options.ttlS > 0) message.ttl = Math.floor(options.ttlS);
    return message;
  });
  stats.messages = messages.length;

  const chunks = expo.chunkPushNotifications(messages);
  const receipts: ReceiptRow[] = [];
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (let index = 0; index < tickets.length; index += 1) {
        await recordTicket(tickets[index], chunk[index], type, tokenOwners, stats, receipts);
      }
    } catch (error) {
      stats.chunkFailures += 1;
      console.error(`[around:push] send chunk failed (${chunk.length} messages, type=${type}); retrying one by one`, error);
      if (chunk.length === 1) {
        bump(stats.ticketErrors, "chunk");
        continue;
      }
      for (const message of chunk) {
        try {
          const [ticket] = await expo.sendPushNotificationsAsync([message]);
          if (ticket) await recordTicket(ticket, message, type, tokenOwners, stats, receipts);
        } catch (single) {
          bump(stats.ticketErrors, "chunk");
          console.error("[around:push] single message failed", single);
        }
      }
    }
    // Per chunk, not once at the end: a continuation cut short still leaves
    // the receipts of everything already sent.
    await flushReceipts(receipts);
  }
  return stats;
}

async function blockedUserIdSet(userId: Types.ObjectId): Promise<Set<string>> {
  const blocks = await AroundBlockModel.find({
    $or: [{ blockerId: userId }, { blockedId: userId }]
  }).lean();
  const set = new Set<string>();
  for (const block of blocks) {
    set.add(String(block.blockerId));
    set.add(String(block.blockedId));
  }
  set.delete(String(userId));
  return set;
}

function logLine(payload: Record<string, unknown>) {
  console.log(JSON.stringify(payload));
}

export type FanOutStats = {
  presences: number;
  candidates: number;
  recipients: number;
  alreadyRung: number;
  devices: number;
  ticketsOk: number;
  /** Claims given back because nothing reached Expo for that user. */
  released: number;
  ticketErrors: Record<string, number>;
  probes: ProbeStats | null;
};

// Fan-out at around creation: fresh presences (< presenceFreshMs) inside the
// radius, radar opt-in only, active accounts, bilateral blocks filtered. Every
// recipient is CLAIMED in around_rings before the send, so an arrival ring
// or a probe answer that follows never rings the same person twice. After the
// visible push, silent probes go to the radar devices that were NOT reached
// (no fresh presence): the ones that answer from inside the radius ring
// through the arrival path.
export async function fanOutAroundCreated(around: Around): Promise<FanOutStats> {
  const stats: FanOutStats = {
    presences: 0, candidates: 0, recipients: 0, alreadyRung: 0, devices: 0,
    ticketsOk: 0, released: 0, ticketErrors: {}, probes: null
  };
  // The centre only disappears at purge/owner erasure, never at creation —
  // the guard narrows the optional field for the geo query below.
  if (!around.center) return stats;
  const startedAt = Date.now();
  const freshAfter = new Date(Date.now() - config.presenceFreshMs);
  const presences = await DevicePresenceModel.find({
    location: {
      $nearSphere: {
        $geometry: around.center,
        $maxDistance: around.radiusM + 100
      }
    },
    capturedAt: { $gte: freshAfter }
  }).lean();
  stats.presences = presences.length;

  const candidateIds = presences
    .map((presence) => presence.userId)
    .filter((userId) => String(userId) !== String(around.ownerId));
  stats.candidates = candidateIds.length;

  let recipientIds: Types.ObjectId[] = [];
  if (candidateIds.length > 0) {
    const blocked = await blockedUserIdSet(around.ownerId);
    const users = await AroundUserModel.find({
      _id: { $in: candidateIds },
      radarEnabled: true,
      status: "active"
    }).lean();
    recipientIds = users
      .map((user) => user._id)
      .filter((id) => !blocked.has(String(id)));
  }
  stats.recipients = recipientIds.length;

  // Claim only the users that can actually be reached: a recipient without a
  // push device must stay unclaimed, so the arrival ring can still ring them
  // once they register a token and post a presence.
  const allTargets = await pushTargetsForUsers(recipientIds);
  const reachableIds = [...new Map(allTargets.map((target) => [String(target.userId), target.userId])).values()];
  const claimed = await claimRings(around._id, reachableIds, "created");
  stats.alreadyRung = reachableIds.length - claimed.length;
  const claimedSet = new Set(claimed.map(String));

  const safeName = pushSafeName(around.name);
  const targets = allTargets.filter((target) => claimedSet.has(String(target.userId)));
  stats.devices = targets.length;
  const sent = await sendToTargets(
    targets,
    "around-created",
    // Neutral title: this fan-out reaches strangers, see pushSafeName above.
    (locale) => pushCopy("around-created", locale, safeName),
    { type: "around-created", kind: "created", aroundId: String(around._id), ...(safeName ? { name: safeName } : {}) }
  );
  stats.ticketsOk = sent.ticketsOk;
  stats.ticketErrors = sent.ticketErrors;
  // A claim is only spent by a message that actually reached Expo. Marking
  // every claimed user as rung — whatever came back — turned a transient Expo
  // failure or a dead token into permanent silence for that around: the
  // arrival ring, the probe answer and the geofence entry all check the same
  // claim. Whoever got no ticket keeps their claim released, and the next
  // presence they post rings them.
  const wasDelivered = (userId: Types.ObjectId) => (sent.ticketIdsByUser.get(String(userId)) ?? []).length > 0;
  const delivered = claimed.filter(wasDelivered);
  const undelivered = claimed.filter((userId) => !wasDelivered(userId));
  stats.released = undelivered.length;
  await markRingsSent(around._id, delivered, sent.ticketIdsByUser);
  await releaseRings(around._id, undelivered);

  try {
    stats.probes = await sendPresenceProbes(around, [around.ownerId, ...recipientIds]);
  } catch (error) {
    console.error("[around:probe] probe fan-out failed", error);
  }

  logLine({
    tag: "around:fanout",
    aroundId: String(around._id),
    radiusM: around.radiusM,
    presences: stats.presences,
    candidates: stats.candidates,
    recipients: stats.recipients,
    alreadyRung: stats.alreadyRung,
    devices: stats.devices,
    ticketsOk: stats.ticketsOk,
    released: stats.released,
    ticketErrors: stats.ticketErrors,
    chunkFailures: sent.chunkFailures,
    probes: stats.probes ? { devices: stats.probes.devices, ticketsOk: stats.probes.ticketsOk, truncated: stats.probes.truncated } : null,
    ms: Date.now() - startedAt
  });
  return stats;
}

export type ProbeStats = {
  users: number;
  devices: number;
  ticketsOk: number;
  ticketErrors: Record<string, number>;
  truncated: boolean;
};

/**
 * Silent presence probe. iOS delivers a content-available push to a
 * backgrounded app (not to a force-quit one, and only a few per hour): the
 * app's background notification task takes a position and POSTs it, and the
 * arrival ring decides. It is a PROXIMITY HEURISTIC, not a broadcast: the
 * audience is built nearest-first from the stale presences around the new
 * around — the phones that were seen near here but have gone quiet — and only
 * then filled with accounts that have no presence at all (a phone that has
 * never spoken could be anywhere, so it is the last resort, newest device
 * first). Sorting matters: an unsorted `find` returns natural order, so past
 * a couple of thousand accounts the same oldest ones were probed every time
 * and nobody else ever was.
 */
export async function sendPresenceProbes(around: Around, excludeUserIds: Types.ObjectId[]): Promise<ProbeStats> {
  const stats: ProbeStats = { users: 0, devices: 0, ticketsOk: 0, ticketErrors: {}, truncated: false };
  const now = Date.now();
  const remainingS = Math.floor((around.captureEndsAt.getTime() - now) / 1000);
  if (remainingS <= 0 || config.presenceProbeMaxDevices <= 0 || !around.center) return stats;

  const freshAfter = new Date(now - config.presenceProbeFreshMs);
  const exclude = new Set(excludeUserIds.map(String));
  const candidateIds: Types.ObjectId[] = [];
  const seen = new Set<string>();

  // 1. Stale presences near the around, nearest first. These are the phones
  // most likely to be here and unable to say so.
  const nearby = await DevicePresenceModel.find(
    {
      location: { $nearSphere: { $geometry: around.center, $maxDistance: config.wakeRegionRangeM } }
    },
    { userId: 1, capturedAt: 1 }
  )
    .limit(config.presenceProbeMaxDevices * 2)
    .lean();
  for (const presence of nearby) {
    const key = String(presence.userId);
    // A presence fresher than the window was already evaluated by the fan-out.
    if (presence.capturedAt >= freshAfter || exclude.has(key) || seen.has(key)) continue;
    seen.add(key);
    candidateIds.push(presence.userId);
  }

  // 2. Fill the remaining budget with accounts seen recently in the app but
  // with no usable presence at all.
  if (candidateIds.length < config.presenceProbeMaxDevices) {
    const knownFresh = await DevicePresenceModel.find({ capturedAt: { $gte: freshAfter } }, { userId: 1 })
      .limit(5000)
      .lean();
    for (const presence of knownFresh) seen.add(String(presence.userId));
    const spare = await AroundUserModel.find(
      {
        radarEnabled: true,
        status: "active",
        _id: { $nin: [...new Set([...exclude, ...seen])].map((id) => new Types.ObjectId(id)) }
      },
      { _id: 1 }
    )
      .sort({ lastSeenAt: -1 })
      .limit(config.presenceProbeMaxDevices)
      .lean();
    for (const user of spare) candidateIds.push(user._id);
  }

  const users = await AroundUserModel.find(
    { _id: { $in: candidateIds }, radarEnabled: true, status: "active" },
    { _id: 1 }
  ).lean();
  stats.users = users.length;
  if (users.length === 0) return stats;

  const devices = await AroundDeviceModel.find({
    userId: { $in: users.map((user) => user._id) },
    expoPushToken: { $exists: true, $ne: null },
    pushEnabled: true,
    invalidatedAt: null
  })
    .sort({ lastActiveAt: -1 })
    .limit(config.presenceProbeMaxDevices + 1)
    .lean();
  stats.truncated = devices.length > config.presenceProbeMaxDevices;
  const targets: PushTarget[] = devices
    .slice(0, config.presenceProbeMaxDevices)
    .filter((device) => typeof device.expoPushToken === "string" && Expo.isExpoPushToken(device.expoPushToken))
    // A probe carries no text, so the locale is irrelevant here; the field is
    // filled to keep one target shape across every send path.
    .map((device) => ({ userId: device.userId, expoPushToken: device.expoPushToken as string, locale: "fr" as const }));
  stats.devices = targets.length;

  const sent = await sendToTargets(
    targets,
    "presence-probe",
    null,
    { type: "presence-probe", aroundId: String(around._id), expiresAt: around.captureEndsAt.toISOString() },
    { silent: true, ttlS: Math.min(remainingS, 60 * 60) }
  );
  stats.ticketsOk = sent.ticketsOk;
  stats.ticketErrors = sent.ticketErrors;
  logLine({
    tag: "around:probe",
    aroundId: String(around._id),
    users: stats.users,
    devices: stats.devices,
    truncated: stats.truncated,
    ticketsOk: stats.ticketsOk,
    ticketErrors: stats.ticketErrors,
    chunkFailures: sent.chunkFailures
  });
  return stats;
}

/**
 * A presence is judged inside an around when it is within
 * radiusM + accuracyCredit + ringToleranceM. The credit is the phone's own
 * reported accuracy, capped: a Balanced fix at 120 m standing 90 m from a
 * 50 m around IS inside, but a deliberately coarse fix must not buy range.
 */
export const MAX_ACCURACY_CREDIT_M = 150;

export function accuracyCreditM(accuracy: number) {
  return Math.min(Math.max(accuracy, 0), MAX_ACCURACY_CREDIT_M);
}

export type RingOnPresenceInput = {
  userId: Types.ObjectId;
  lat: number;
  lng: number;
  accuracy: number;
  source: PresenceSource;
  probeAroundId?: string | null;
};

/**
 * The arrival ring. Called after every presence write except a foreground
 * one (the user is looking at the list): every open around whose circle
 * contains the point — within radiusM + min(accuracy, 150) + ringToleranceM —
 * and of which the user is not (and never was) a member rings once, ever, per
 * (around, user), at most arrivalRingMaxPerHour times per user per hour.
 * Returns the ids of the arounds rung.
 */
export async function ringOnPresence(input: RingOnPresenceInput): Promise<string[]> {
  if (input.source === "foreground") return [];
  const now = new Date();
  // Widest circle any around can have, plus the widest accuracy credit the
  // filter below can grant, plus the slack: anything outside cannot qualify.
  const maxDistance = AROUND_MAX_RADIUS_M + MAX_ACCURACY_CREDIT_M + config.ringToleranceM;
  const nearby = await AroundModel.find({
    status: "active",
    captureEndsAt: { $gt: now },
    center: { $nearSphere: { $geometry: { type: "Point", coordinates: [input.lng, input.lat] }, $maxDistance: maxDistance } }
  })
    .limit(20)
    .lean<Around[]>();

  const viewerId = String(input.userId);
  const inside = nearby.filter((around) => {
    if (!around.center) return false;
    if (String(around.ownerId) === viewerId) return false;
    if (around.kickedUserIds.some((id) => String(id) === viewerId)) return false;
    const [centerLng, centerLat] = around.center.coordinates;
    const distance = haversineMeters(input.lat, input.lng, centerLat, centerLng);
    return distance <= around.radiusM + accuracyCreditM(input.accuracy) + config.ringToleranceM;
  });
  if (inside.length === 0) return [];

  const memberships = await AroundMemberModel.find(
    { userId: input.userId, aroundId: { $in: inside.map((around) => around._id) } },
    { aroundId: 1 }
  ).lean();
  const memberOf = new Set(memberships.map((membership) => String(membership.aroundId)));
  const blocked = await blockedUserIdSet(input.userId);
  const eligible = inside.filter(
    (around) => !memberOf.has(String(around._id)) && !blocked.has(String(around.ownerId))
  );
  if (eligible.length === 0) return [];

  const user = await AroundUserModel.findById(input.userId).lean();
  if (!user || !user.radarEnabled || user.status !== "active") return [];
  if ((await arrivalRingsInLastHour(input.userId)) >= config.arrivalRingMaxPerHour) return [];

  const targets = await pushTargetsForUsers([input.userId]);
  if (targets.length === 0) return [];

  const rung: string[] = [];
  for (const around of eligible) {
    const claimed = await claimRing(around._id, input.userId, "arrival", input.source);
    if (!claimed) continue;
    const safeName = pushSafeName(around.name);
    const sent = await sendToTargets(
      targets,
      "around-created",
      (locale) => pushCopy("around-created", locale, safeName),
      { type: "around-created", kind: "arrival", aroundId: String(around._id), ...(safeName ? { name: safeName } : {}) }
    );
    if (sent.ticketsOk === 0) {
      // Nothing left Expo: give the claim back so the next presence retries.
      await releaseRing(around._id, input.userId);
    } else {
      await markRingsSent(around._id, [input.userId], sent.ticketIdsByUser);
      rung.push(String(around._id));
    }
    logLine({
      tag: "around:ring",
      kind: "arrival",
      aroundId: String(around._id),
      source: input.source,
      probe: input.probeAroundId === String(around._id),
      devices: targets.length,
      ticketsOk: sent.ticketsOk,
      ticketErrors: sent.ticketErrors
    });
  }
  return rung;
}

export async function notifyPhotoApproved(around: Around, uploaderId: Types.ObjectId) {
  const safeName = pushSafeName(around.name);
  const targets = await pushTargetsForUsers([uploaderId]);
  await sendToTargets(
    targets,
    "photo-approved",
    (locale) => pushCopy("photo-approved", locale, safeName),
    { type: "photo-approved", aroundId: String(around._id), ...(safeName ? { name: safeName } : {}) }
  );
}

export async function notifyOwnerPhotoPending(around: Around, pendingCount: number) {
  const safeName = pushSafeName(around.name);
  const targets = await pushTargetsForUsers([around.ownerId]);
  await sendToTargets(
    targets,
    "photo-pending",
    (locale) => pushCopy("photo-pending", locale, safeName, pendingCount),
    { type: "photo-pending", aroundId: String(around._id), ...(safeName ? { name: safeName } : {}) }
  );
}

export async function notifyAroundEnding(around: Around) {
  const safeName = pushSafeName(around.name);
  const members = await AroundMemberModel.find({ aroundId: around._id, status: "active" }).lean();
  const targets = await pushTargetsForUsers(members.map((member) => member.userId));
  await sendToTargets(
    targets,
    "around-ending",
    (locale) => pushCopy("around-ending", locale, safeName),
    { type: "around-ending", aroundId: String(around._id), ...(safeName ? { name: safeName } : {}) }
  );
}

// Receipt processing (called from the 15-min job): DeviceNotRegistered
// receipts prune the token; EVERY error code is counted and logged (an
// InvalidCredentials receipt means the APNs key is broken and the radar is
// deaf for everyone — it must not vanish silently); processed receipts are
// deleted (TTL covers the stragglers).
export async function processPushReceipts() {
  // Expo recommends waiting ~15 minutes before checking receipts.
  const checkBefore = new Date(Date.now() - 15 * 60 * 1000);
  const receipts = await PushReceiptModel.find({ createdAt: { $lte: checkBefore } })
    .limit(300)
    .lean();
  if (receipts.length === 0) return;

  const byTicketId = new Map(receipts.map((receipt) => [receipt.ticketId, receipt]));
  const chunks = expo.chunkPushNotificationReceiptIds(receipts.map((receipt) => receipt.ticketId));
  let ok = 0;
  const errors: Record<string, number> = {};
  const errorsByType: Record<string, number> = {};
  for (const chunk of chunks) {
    try {
      const results = await expo.getPushNotificationReceiptsAsync(chunk);
      for (const [ticketId, result] of Object.entries(results)) {
        const stored = byTicketId.get(ticketId);
        if (!stored) continue;
        if (result.status === "ok") {
          ok += 1;
          continue;
        }
        const code = result.details?.error ?? "unknown";
        bump(errors, code);
        bump(errorsByType, `${stored.type}:${code}`);
        if (code === "DeviceNotRegistered") {
          await invalidatePushToken(stored.expoPushToken);
        }
      }
      await PushReceiptModel.deleteMany({ ticketId: { $in: chunk } });
    } catch (error) {
      console.error("[around:push] receipt chunk failed", error);
    }
  }
  if (Object.keys(errors).length > 0) {
    // InvalidCredentials / MismatchSenderId = the APNs side is broken for
    // every user, not a stale token: logged at error level so it stands out.
    const fatal = errors.InvalidCredentials || errors.MismatchSenderId;
    (fatal ? console.error : console.warn)(
      JSON.stringify({ tag: "around:receipts", checked: receipts.length, ok, errors, errorsByType })
    );
  }
}
