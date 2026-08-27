import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { Types } from "mongoose";
import { config } from "../config.js";
import {
  AroundBlockModel,
  AroundDeviceModel,
  AroundMemberModel,
  AroundUserModel,
  DevicePresenceModel,
  PushReceiptModel,
  type Around
} from "./models.js";

// Expo push pipeline. Every entry point is designed to be called
// fire-and-forget (`void notifyX(...).catch(...)`) — a push failure must never
// block or fail an API request. Payloads NEVER contain coordinates (presence
// leak): only {type, aroundId, name?}.

const expo = new Expo();

export type AroundPushType = "around-created" | "photo-pending" | "photo-approved" | "around-ending";

type PushTarget = {
  userId: Types.ObjectId;
  expoPushToken: string;
};

async function invalidatePushToken(expoPushToken: string) {
  await AroundDeviceModel.updateMany(
    { expoPushToken },
    { $set: { invalidatedAt: new Date() }, $unset: { expoPushToken: "" } }
  );
}

async function pushTargetsForUsers(userIds: Types.ObjectId[]): Promise<PushTarget[]> {
  if (userIds.length === 0) return [];
  const devices = await AroundDeviceModel.find({
    userId: { $in: userIds },
    expoPushToken: { $exists: true, $ne: null },
    pushEnabled: true,
    invalidatedAt: null
  }).lean();
  return devices
    .filter((device) => typeof device.expoPushToken === "string" && Expo.isExpoPushToken(device.expoPushToken))
    .map((device) => ({ userId: device.userId, expoPushToken: device.expoPushToken as string }));
}

async function sendToTargets(
  targets: PushTarget[],
  type: AroundPushType,
  title: string,
  body: string,
  data: { type: AroundPushType; aroundId: string; name?: string }
) {
  if (targets.length === 0) return;
  const tokenOwners = new Map<string, Types.ObjectId>();
  const messages: ExpoPushMessage[] = targets.map((target) => {
    tokenOwners.set(target.expoPushToken, target.userId);
    return {
      to: target.expoPushToken,
      sound: "default" as const,
      title,
      body,
      data
    };
  });

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (let index = 0; index < tickets.length; index += 1) {
        const ticket = tickets[index];
        const message = chunk[index];
        const token = typeof message.to === "string" ? message.to : message.to[0];
        if (ticket.status === "ok") {
          await PushReceiptModel.create({
            ticketId: ticket.id,
            expoPushToken: token,
            userId: tokenOwners.get(token) ?? null,
            type,
            createdAt: new Date()
          });
        } else if (ticket.details?.error === "DeviceNotRegistered") {
          await invalidatePushToken(token);
        }
      }
    } catch (error) {
      console.error("[around:push] send chunk failed", error);
    }
  }
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

// Fan-out at around creation: fresh presences (< presenceFreshMs) inside the
// radius, radar opt-in only, active accounts, bilateral blocks filtered.
export async function fanOutAroundCreated(around: Around) {
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

  const candidateIds = presences
    .map((presence) => presence.userId)
    .filter((userId) => String(userId) !== String(around.ownerId));
  if (candidateIds.length === 0) return;

  const blocked = await blockedUserIdSet(around.ownerId);
  const users = await AroundUserModel.find({
    _id: { $in: candidateIds },
    radarEnabled: true,
    status: "active"
  }).lean();
  const recipientIds = users
    .map((user) => user._id)
    .filter((id) => !blocked.has(String(id)));

  const targets = await pushTargetsForUsers(recipientIds);
  await sendToTargets(
    targets,
    "around-created",
    around.name ? `${around.name}` : "Picture me around",
    "Un around vient de s'ouvrir pres de toi. Rejoins-le tant que tu es dans le rayon.",
    { type: "around-created", aroundId: String(around._id), ...(around.name ? { name: around.name } : {}) }
  );
}

export async function notifyPhotoApproved(around: Around, uploaderId: Types.ObjectId) {
  const targets = await pushTargetsForUsers([uploaderId]);
  await sendToTargets(
    targets,
    "photo-approved",
    around.name ? `${around.name}` : "Picture me around",
    "Ta photo vient d'etre debloquee pour tout le cercle.",
    { type: "photo-approved", aroundId: String(around._id), ...(around.name ? { name: around.name } : {}) }
  );
}

export async function notifyOwnerPhotoPending(around: Around, pendingCount: number) {
  const targets = await pushTargetsForUsers([around.ownerId]);
  await sendToTargets(
    targets,
    "photo-pending",
    around.name ? `${around.name}` : "Picture me around",
    `${pendingCount} photo${pendingCount > 1 ? "s" : ""} en attente d'approbation dans ton around.`,
    { type: "photo-pending", aroundId: String(around._id), ...(around.name ? { name: around.name } : {}) }
  );
}

export async function notifyAroundEnding(around: Around) {
  const members = await AroundMemberModel.find({ aroundId: around._id, status: "active" }).lean();
  const targets = await pushTargetsForUsers(members.map((member) => member.userId));
  await sendToTargets(
    targets,
    "around-ending",
    around.name ? `${around.name}` : "Picture me around",
    "Derniere demi-heure : la fenetre de capture ferme bientot.",
    { type: "around-ending", aroundId: String(around._id), ...(around.name ? { name: around.name } : {}) }
  );
}

// Receipt processing (called from the 15-min job): DeviceNotRegistered
// receipts prune the token; processed receipts are deleted (TTL covers the
// stragglers).
export async function processPushReceipts() {
  // Expo recommends waiting ~15 minutes before checking receipts.
  const checkBefore = new Date(Date.now() - 15 * 60 * 1000);
  const receipts = await PushReceiptModel.find({ createdAt: { $lte: checkBefore } })
    .limit(300)
    .lean();
  if (receipts.length === 0) return;

  const byTicketId = new Map(receipts.map((receipt) => [receipt.ticketId, receipt]));
  const chunks = expo.chunkPushNotificationReceiptIds(receipts.map((receipt) => receipt.ticketId));
  for (const chunk of chunks) {
    try {
      const results = await expo.getPushNotificationReceiptsAsync(chunk);
      for (const [ticketId, result] of Object.entries(results)) {
        const stored = byTicketId.get(ticketId);
        if (!stored) continue;
        if (result.status === "error" && result.details?.error === "DeviceNotRegistered") {
          await invalidatePushToken(stored.expoPushToken);
        }
      }
      await PushReceiptModel.deleteMany({ ticketId: { $in: chunk } });
    } catch (error) {
      console.error("[around:push] receipt chunk failed", error);
    }
  }
}
