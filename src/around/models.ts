import mongoose, { Schema, Types } from "mongoose";

// ---------------------------------------------------------------------------
// "Picture me around" collections. Model names are prefixed with "Around" to
// avoid any collision with the frozen t-shirt/marketplace models; collection
// names are explicit (third argument of mongoose.model).
// ---------------------------------------------------------------------------

export type GeoPoint = {
  type: "Point";
  coordinates: [number, number]; // [lng, lat]
};

const pointSchema = new Schema<GeoPoint>({
  type: { type: String, enum: ["Point"], required: true, default: "Point" },
  coordinates: {
    type: [Number],
    required: true,
    validate: {
      validator: (value: number[]) => Array.isArray(value) && value.length === 2,
      message: "coordinates must be [lng, lat]"
    }
  }
}, { _id: false });

export function geoPoint(lat: number, lng: number): GeoPoint {
  return { type: "Point", coordinates: [lng, lat] };
}

// --- users -----------------------------------------------------------------

// The interface language, chosen by the user when the account is created and
// stored server-side so every device of that account (and every e-mail we send
// them) speaks the same language.
export const LOCALES = ["fr", "en"] as const;
export type AroundLocale = (typeof LOCALES)[number];

export type AroundUser = {
  _id: Types.ObjectId;
  appleSub?: string;
  googleSub?: string;
  // Apple refresh token, kept ONLY to revoke the Sign in with Apple grant on
  // account deletion (App Store 5.1.1(v)). `select: false` keeps it out of
  // every read path (userResponse and the .lean<AroundUser>() lookups).
  appleRefreshToken?: string | null;
  pseudo: string;
  pseudoLower: string;
  email?: string | null;
  // bcrypt digest of the password of an e-mail account (cost 12). NEVER the
  // password itself — the plaintext is read from the request body, hashed and
  // dropped. `select: false` for the same reason as appleRefreshToken: it must
  // not ride along the .lean<AroundUser>() read that feeds req.user, and from
  // there userResponse. Absent on an Apple-only account.
  passwordHash?: string | null;
  // Null until the 6-digit code sent to that mailbox has been entered. An
  // account with a passwordHash and no emailVerifiedAt cannot log in.
  emailVerifiedAt?: Date | null;
  locale: AroundLocale;
  radarEnabled: boolean;
  status: "active" | "banned";
  termsAcceptedAt: Date;
  termsVersion: string;
  radarConsentAt?: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
};

const userSchema = new Schema<AroundUser>({
  appleSub: { type: String },
  googleSub: { type: String },
  appleRefreshToken: { type: String, default: null, select: false },
  pseudo: { type: String, required: true, trim: true },
  pseudoLower: { type: String, required: true },
  email: { type: String, default: null, lowercase: true, trim: true },
  passwordHash: { type: String, default: null, select: false },
  emailVerifiedAt: { type: Date, default: null },
  locale: { type: String, enum: [...LOCALES], required: true, default: "fr" },
  radarEnabled: { type: Boolean, required: true, default: false },
  status: { type: String, enum: ["active", "banned"], required: true, default: "active" },
  termsAcceptedAt: { type: Date, required: true },
  termsVersion: { type: String, required: true, default: "2026-08" },
  radarConsentAt: { type: Date, default: null },
  createdAt: { type: Date, required: true, default: () => new Date() },
  lastSeenAt: { type: Date, required: true, default: () => new Date() }
});

userSchema.index({ appleSub: 1 }, { unique: true, sparse: true });
userSchema.index({ googleSub: 1 }, { unique: true, sparse: true });
// NOT unique: the public name is a display name, not an identity — several
// people can carry the same one (product decision, 2026-08-30). Members are
// told apart by userId everywhere that matters (kick, block, report, approve).
// The index itself stays for the lookups. syncIndexes() at boot drops the old
// unique version on the first deploy that ships this line.
userSchema.index({ pseudoLower: 1 });
// The e-mail became an identity the day POST /api/users/email/login existed, so
// it must be unique. `sparse: true` alone would NOT do: a sparse index still
// indexes an explicit `null`, and every account created through Sign in with
// Apple stores `email: null` (Apple only hands the address on the very first
// authorization, and the user may hide it behind a private relay). A unique
// sparse index would therefore refuse the second Apple account ever created.
// A PARTIAL index on the string type indexes real addresses only and leaves
// every null out of the constraint. Case-insensitivity comes from the
// `lowercase: true` setter above plus the explicit normalisation done in
// emailAuth.ts, so no collation is involved — which also means the ordinary
// `findOne({ email })` lookups keep using this index.
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string" } } }
);

// --- reserved pseudos (post-deletion tombstone) ----------------------------
// INERT since public names stopped being unique (2026-08-30): with duplicates
// allowed there is no exclusive claim to protect, so nothing reads this
// collection any more. Deletion still writes the tombstone (harmless, and the
// TTL empties the collection on its own) so the model and its history stay.

export const PSEUDO_RESERVATION_MS = 30 * 24 * 60 * 60 * 1000;

export type ReservedPseudo = {
  _id: Types.ObjectId;
  pseudoLower: string;
  releasedAt: Date;
};

const reservedPseudoSchema = new Schema<ReservedPseudo>({
  pseudoLower: { type: String, required: true },
  releasedAt: { type: Date, required: true, default: () => new Date() }
});

reservedPseudoSchema.index({ pseudoLower: 1 }, { unique: true });
reservedPseudoSchema.index({ releasedAt: 1 }, { expireAfterSeconds: PSEUDO_RESERVATION_MS / 1000 });

// --- email_verifications ---------------------------------------------------
// One live code per account (unique index on userId, the document is upserted
// on every send and DELETED on success, on expiry and on the 5th wrong try).
// The code itself is never stored: only a keyed digest, see emailAuth.ts.

export const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

export type EmailVerification = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  emailLower: string;
  // HMAC-SHA256 digest, hex. Salt is per-code and public; the key is a
  // server-side pepper that never reaches the database.
  codeHash: string;
  codeSalt: string;
  attempts: number;
  expiresAt: Date;
  sentAt: Date;
  createdAt: Date;
};

const emailVerificationSchema = new Schema<EmailVerification>({
  userId: { type: Schema.Types.ObjectId, required: true },
  emailLower: { type: String, required: true },
  codeHash: { type: String, required: true },
  codeSalt: { type: String, required: true },
  attempts: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
  sentAt: { type: Date, required: true, default: () => new Date() },
  createdAt: { type: Date, required: true, default: () => new Date() }
});

emailVerificationSchema.index({ userId: 1 }, { unique: true });
emailVerificationSchema.index({ emailLower: 1 });
// expireAfterSeconds: 0 means "delete once expiresAt is in the past". Belt and
// braces: every read path re-checks the expiry itself, because MongoDB only
// sweeps once a minute (and mongodb-memory-server may not sweep at all).
emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// --- pending signups -------------------------------------------------------
// An e-mail signup does NOT create a user any more: everything the account
// will need — including the bcrypt hash and the code digest — waits here
// until the mailbox is proven, then POST /verify turns it into a real user
// and deletes this row. Two clocks, on purpose: `expiresAt` is the CODE's
// 15 minutes (checked by every read, never a TTL), `purgeAt` is the ROW's
// day (the TTL) — so an expired or burnt code still leaves a row that
// /resend can put a fresh code on, and an abandoned signup still vanishes.

export type PendingSignup = {
  _id: Types.ObjectId;
  emailLower: string;
  pseudo: string;
  pseudoLower: string;
  passwordHash: string;
  locale: AroundLocale;
  termsVersion?: string | null;
  termsAcceptedAt: Date;
  codeHash: string;
  codeSalt: string;
  attempts: number;
  expiresAt: Date;
  sentAt: Date;
  purgeAt: Date;
  createdAt: Date;
};

const pendingSignupSchema = new Schema<PendingSignup>({
  emailLower: { type: String, required: true },
  pseudo: { type: String, required: true },
  pseudoLower: { type: String, required: true },
  passwordHash: { type: String, required: true },
  locale: { type: String, required: true, enum: LOCALES },
  termsVersion: { type: String, default: null },
  termsAcceptedAt: { type: Date, required: true },
  codeHash: { type: String, required: true },
  codeSalt: { type: String, required: true },
  attempts: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
  sentAt: { type: Date, required: true, default: () => new Date() },
  purgeAt: { type: Date, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() }
});

export const PENDING_SIGNUP_PURGE_MS = 24 * 60 * 60 * 1000;

pendingSignupSchema.index({ emailLower: 1 }, { unique: true });
pendingSignupSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

// --- devices ---------------------------------------------------------------

export type AroundDevice = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  installationId: string;
  expoPushToken?: string;
  pushEnabled: boolean;
  platform?: string | null;
  appVersion?: string | null;
  osVersion?: string | null;
  lastActiveAt: Date;
  invalidatedAt?: Date | null;
};

const deviceSchema = new Schema<AroundDevice>({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  installationId: { type: String, required: true },
  expoPushToken: { type: String },
  pushEnabled: { type: Boolean, required: true, default: true },
  platform: { type: String, default: null },
  appVersion: { type: String, default: null },
  osVersion: { type: String, default: null },
  lastActiveAt: { type: Date, required: true, default: () => new Date() },
  invalidatedAt: { type: Date, default: null }
});

deviceSchema.index({ userId: 1, installationId: 1 }, { unique: true });
deviceSchema.index({ expoPushToken: 1 }, { unique: true, sparse: true });

// --- device_presences ------------------------------------------------------
// One doc per user, upserted. The position is OVERWRITTEN (never a history).
// TTL on updatedAt garbage-collects stale docs after 1h; effective freshness
// (30 min) is filtered at query time.

export type DevicePresence = {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  location: GeoPoint;
  accuracy: number;
  capturedAt: Date;
  updatedAt: Date;
  source: "significant-change" | "foreground";
};

const presenceSchema = new Schema<DevicePresence>({
  userId: { type: Schema.Types.ObjectId, required: true },
  location: { type: pointSchema, required: true },
  accuracy: { type: Number, required: true },
  capturedAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true, default: () => new Date() },
  source: { type: String, enum: ["significant-change", "foreground"], required: true, default: "foreground" }
});

presenceSchema.index({ userId: 1 }, { unique: true });
presenceSchema.index({ location: "2dsphere" });
presenceSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 });

// --- arounds ---------------------------------------------------------------

export type AroundStatus = "active" | "closed" | "purging" | "purged";

export type Around = {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  name?: string | null;
  center: GeoPoint;
  radiusM: number;
  captureWindowMs: number;
  status: AroundStatus;
  createdAt: Date;
  captureEndsAt: Date;
  expiresAt: Date;
  endingNotifiedAt?: Date | null;
  closeReminderSentAt?: Date | null;
  pendingReminder24hSentAt?: Date | null;
  kickedUserIds: Types.ObjectId[];
  memberCount: number;
  photoCount: number;
};

const aroundSchema = new Schema<Around>({
  ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, default: null, trim: true },
  center: { type: pointSchema, required: true },
  radiusM: { type: Number, required: true, min: 10, max: 300 },
  captureWindowMs: { type: Number, required: true },
  status: { type: String, enum: ["active", "closed", "purging", "purged"], required: true, default: "active" },
  createdAt: { type: Date, required: true, default: () => new Date() },
  captureEndsAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  endingNotifiedAt: { type: Date, default: null },
  closeReminderSentAt: { type: Date, default: null },
  pendingReminder24hSentAt: { type: Date, default: null },
  kickedUserIds: { type: [Schema.Types.ObjectId], required: true, default: [] },
  memberCount: { type: Number, required: true, default: 1 },
  photoCount: { type: Number, required: true, default: 0 }
});

aroundSchema.index({ center: "2dsphere" });
aroundSchema.index({ status: 1, captureEndsAt: 1 });
aroundSchema.index({ status: 1, expiresAt: 1 });

// --- around_members --------------------------------------------------------

export type JoinFix = {
  lat: number;
  lng: number;
  accuracy: number;
  capturedAt: Date;
  distanceM: number;
};

export type AroundMember = {
  _id: Types.ObjectId;
  aroundId: Types.ObjectId;
  userId: Types.ObjectId;
  role: "owner" | "member";
  status: "active" | "left" | "removed";
  joinFixes: JoinFix[];
  interFixDistanceM?: number | null;
  joinIp?: string | null;
  joinGeo?: Record<string, unknown> | null;
  suspicious: boolean;
  anonymizedAt?: Date | null;
  // Monotonic counter of photos this member ever uploaded to this around. It
  // is NEVER decremented (not on delete, not on purge): the per-around quota
  // must be cumulative, otherwise deleting a photo hands back a credit and the
  // 50-photo cap becomes an instantaneous ceiling instead of a real quota.
  uploadedTotal: number;
  createdAt: Date;
};

const joinFixSchema = new Schema<JoinFix>({
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  accuracy: { type: Number, required: true },
  capturedAt: { type: Date, required: true },
  distanceM: { type: Number, required: true }
}, { _id: false });

const memberSchema = new Schema<AroundMember>({
  aroundId: { type: Schema.Types.ObjectId, required: true, index: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  role: { type: String, enum: ["owner", "member"], required: true, default: "member" },
  status: { type: String, enum: ["active", "left", "removed"], required: true, default: "active" },
  joinFixes: { type: [joinFixSchema], required: true, default: [] },
  interFixDistanceM: { type: Number, default: null },
  joinIp: { type: String, default: null },
  joinGeo: { type: Schema.Types.Mixed, default: null },
  suspicious: { type: Boolean, required: true, default: false },
  anonymizedAt: { type: Date, default: null },
  // `default: 0` covers the documents created before this field existed: no
  // migration needed, they simply start their quota from zero.
  uploadedTotal: { type: Number, required: true, default: 0 },
  createdAt: { type: Date, required: true, default: () => new Date() }
});

memberSchema.index({ aroundId: 1, userId: 1 }, { unique: true });

// --- around_photos ---------------------------------------------------------
// Cloudinary assets are uploaded with type "authenticated"; we only ever
// persist public_id + version (never a URL).

// Closed set: the value is persisted, echoed to every member of the around and
// read by the mobile client, so it must never be caller-controlled free text.
export const CAPTURE_MODES = ["double", "front", "back"] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export type AroundPhotoStatus = "pending" | "approved" | "rejected" | "removed_by_moderation";
export type PurgeState = "live" | "cloudinary_deleted" | "purged";

export type AroundPhoto = {
  _id: Types.ObjectId;
  aroundId: Types.ObjectId;
  uploaderId: Types.ObjectId;
  status: AroundPhotoStatus;
  captureMode: CaptureMode;
  rearPublicId: string;
  rearVersion: number;
  rearFormat: string;
  rearBytes: number;
  rearMime: string;
  frontPublicId?: string | null;
  frontVersion?: number | null;
  frontFormat?: string | null;
  frontBytes?: number | null;
  frontMime?: string | null;
  capturedAt: Date;
  approvedAt?: Date | null;
  reportCount: number;
  purgeState: PurgeState;
};

const photoSchema = new Schema<AroundPhoto>({
  aroundId: { type: Schema.Types.ObjectId, required: true, index: true },
  uploaderId: { type: Schema.Types.ObjectId, required: true, index: true },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected", "removed_by_moderation"],
    required: true,
    default: "pending"
  },
  captureMode: { type: String, enum: [...CAPTURE_MODES], required: true, default: "double" },
  rearPublicId: { type: String, required: true },
  rearVersion: { type: Number, required: true },
  rearFormat: { type: String, required: true, default: "jpg" },
  rearBytes: { type: Number, required: true, default: 0 },
  rearMime: { type: String, required: true, default: "image/jpeg" },
  frontPublicId: { type: String, default: null },
  frontVersion: { type: Number, default: null },
  frontFormat: { type: String, default: null },
  frontBytes: { type: Number, default: null },
  frontMime: { type: String, default: null },
  capturedAt: { type: Date, required: true, default: () => new Date() },
  approvedAt: { type: Date, default: null },
  reportCount: { type: Number, required: true, default: 0 },
  purgeState: { type: String, enum: ["live", "cloudinary_deleted", "purged"], required: true, default: "live" }
});

photoSchema.index({ aroundId: 1, uploaderId: 1 });
photoSchema.index({ aroundId: 1, _id: -1 });

// --- push_receipts (TTL 7d) ------------------------------------------------

export type PushReceipt = {
  _id: Types.ObjectId;
  ticketId: string;
  expoPushToken: string;
  userId?: Types.ObjectId | null;
  type: string;
  createdAt: Date;
};

const pushReceiptSchema = new Schema<PushReceipt>({
  ticketId: { type: String, required: true, index: true },
  expoPushToken: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, default: null },
  type: { type: String, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() }
});

pushReceiptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// --- reports ---------------------------------------------------------------

export const REPORT_REASONS = [
  "nudity",
  "violence",
  "harassment",
  "hate_speech",
  "no_consent",
  "illegal",
  "spam",
  "private_information",
  "other"
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

// "around" targets the around itself, i.e. its NAME — the only piece of its
// text that reaches people who never joined (it is the title/body of the push
// announcing the around). Reporting it must therefore NOT require membership,
// see POST /api/arounds/:id/report.
export type ReportTargetType = "photo" | "user" | "around";

export type AroundReport = {
  _id: Types.ObjectId;
  targetType: ReportTargetType;
  targetId: Types.ObjectId;
  aroundId?: Types.ObjectId | null;
  reporterId: Types.ObjectId;
  reason: ReportReason;
  comment?: string | null;
  status: "open" | "actioned" | "dismissed";
  createdAt: Date;
};

const reportSchema = new Schema<AroundReport>({
  targetType: { type: String, enum: ["photo", "user", "around"], required: true },
  targetId: { type: Schema.Types.ObjectId, required: true },
  aroundId: { type: Schema.Types.ObjectId, default: null, index: true },
  reporterId: { type: Schema.Types.ObjectId, required: true },
  reason: { type: String, enum: [...REPORT_REASONS], required: true },
  comment: { type: String, default: null, trim: true },
  status: { type: String, enum: ["open", "actioned", "dismissed"], required: true, default: "open" },
  createdAt: { type: Date, required: true, default: () => new Date() }
});

reportSchema.index({ targetType: 1, targetId: 1, reporterId: 1 }, { unique: true });
reportSchema.index({ status: 1, createdAt: -1 });

// --- blocks ----------------------------------------------------------------

export type AroundBlock = {
  _id: Types.ObjectId;
  blockerId: Types.ObjectId;
  blockedId: Types.ObjectId;
  createdAt: Date;
};

const blockSchema = new Schema<AroundBlock>({
  blockerId: { type: Schema.Types.ObjectId, required: true, index: true },
  blockedId: { type: Schema.Types.ObjectId, required: true, index: true },
  createdAt: { type: Date, required: true, default: () => new Date() }
});

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

// --- moderation_actions ----------------------------------------------------

export type ModerationAction = {
  _id: Types.ObjectId;
  action: string;
  targetType: string;
  targetId?: Types.ObjectId | null;
  meta?: Record<string, unknown> | null;
  createdAt: Date;
};

const moderationActionSchema = new Schema<ModerationAction>({
  action: { type: String, required: true },
  targetType: { type: String, required: true },
  targetId: { type: Schema.Types.ObjectId, default: null },
  meta: { type: Schema.Types.Mixed, default: null },
  createdAt: { type: Date, required: true, default: () => new Date(), index: true }
});

// ---------------------------------------------------------------------------

export const AroundUserModel = mongoose.model<AroundUser>("AroundUser", userSchema, "users");
export const AroundReservedPseudoModel = mongoose.model<ReservedPseudo>("AroundReservedPseudo", reservedPseudoSchema, "reserved_pseudos");
export const EmailVerificationModel = mongoose.model<EmailVerification>("AroundEmailVerification", emailVerificationSchema, "email_verifications");
export const PendingSignupModel = mongoose.model<PendingSignup>("AroundPendingSignup", pendingSignupSchema, "pending_signups");
export const AroundDeviceModel = mongoose.model<AroundDevice>("AroundDevice", deviceSchema, "devices");
export const DevicePresenceModel = mongoose.model<DevicePresence>("AroundDevicePresence", presenceSchema, "device_presences");
export const AroundModel = mongoose.model<Around>("Around", aroundSchema, "arounds");
export const AroundMemberModel = mongoose.model<AroundMember>("AroundMember", memberSchema, "around_members");
export const AroundPhotoModel = mongoose.model<AroundPhoto>("AroundPhoto", photoSchema, "around_photos");
export const PushReceiptModel = mongoose.model<PushReceipt>("AroundPushReceipt", pushReceiptSchema, "push_receipts");
export const AroundReportModel = mongoose.model<AroundReport>("AroundReport", reportSchema, "reports");
export const AroundBlockModel = mongoose.model<AroundBlock>("AroundBlock", blockSchema, "blocks");
export const ModerationActionModel = mongoose.model<ModerationAction>("AroundModerationAction", moderationActionSchema, "moderation_actions");

export async function syncAroundIndexes() {
  await Promise.all([
    AroundUserModel.syncIndexes(),
    AroundReservedPseudoModel.syncIndexes(),
    EmailVerificationModel.syncIndexes(),
    PendingSignupModel.syncIndexes(),
    AroundDeviceModel.syncIndexes(),
    DevicePresenceModel.syncIndexes(),
    AroundModel.syncIndexes(),
    AroundMemberModel.syncIndexes(),
    AroundPhotoModel.syncIndexes(),
    PushReceiptModel.syncIndexes(),
    AroundReportModel.syncIndexes(),
    AroundBlockModel.syncIndexes(),
    ModerationActionModel.syncIndexes()
  ]);
}
