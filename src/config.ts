import dotenv from "dotenv";

dotenv.config();

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

// Public constant, only ever usable on a local host (see the boot guard below).
const DEV_JWT_SECRET = "dev-only-change-me";

function cleanEnvValue(value: string) {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function required(name: string, value: string | undefined, fallback?: string) {
  if (value && value.trim().length > 0) return cleanEnvValue(value);
  if (!isProduction && fallback !== undefined) return fallback;
  if (isProduction) {
    console.warn(`[config] ${name} is missing in production. Some features will be disabled.`);
  }
  return fallback ?? "";
}

// Unlike `required()`, an absent value here is not a misconfiguration: the
// fallback is the intended production value (e.g. HOST=127.0.0.1). Warning
// "some features will be disabled" would be plainly false — so only warn when
// the fallback is empty, which does mean the feature is off.
function optional(name: string, value: string | undefined, fallback: string) {
  if (value && value.trim().length > 0) return cleanEnvValue(value);
  if (isProduction && fallback === "") {
    console.warn(`[config] ${name} is missing in production. Some features will be disabled.`);
  }
  return fallback;
}

// A signing secret / admin password must NEVER fall back to a constant that
// lives in this repository. `required()` is fail-open by design (it only warns
// and still returns the fallback), which would turn "dev-only-change-me" into
// a public forging key for every role (admin, client, user). Secrets get their
// own helper that refuses to boot instead.
function requiredSecret(name: string, value: string | undefined, devFallback: string) {
  const cleaned = value && value.trim().length > 0 ? cleanEnvValue(value) : "";
  if (!isProduction) return cleaned || devFallback;
  if (cleaned.length < 32 || cleaned === devFallback) {
    throw new Error(
      `[config] ${name} must be set in production to a private random value of at least 32 characters (never the development fallback). Refusing to start.`
    );
  }
  return cleaned;
}

// Fail-closed: only an explicitly affirmative value turns a flag on. The
// previous rule ("anything that is not false/0/no/off") silently enabled a
// flag on typos such as DEV_BYPASS_RADIUS=disabled.
function flag(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  const normalized = cleanEnvValue(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  console.warn(`[config] unrecognised boolean value "${normalized}" — treated as false.`);
  return false;
}

function numberEnv(name: string, value: string | undefined, fallback: number) {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(cleanEnvValue(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[config] ${name} is not a valid number. Falling back to ${fallback}.`);
    return fallback;
  }
  return parsed;
}

function csvEnv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  // Bind address. Express runs with `trust proxy 1`, so the client IP used by
  // the rate limits and by the GeoIP join check is read from X-Forwarded-For.
  // That is only trustworthy while every request goes through the reverse
  // proxy: if the application port is reachable directly, the "trusted hop" is
  // the caller and the value is attacker-chosen. Binding loopback in
  // production makes that unreachable by construction, so the guarantee no
  // longer depends on a firewall rule being right.
  // Platforms that route to the container from outside (Vercel, Render, Fly,
  // Railway, Docker without host networking) need the wildcard instead: set
  // HOST=0.0.0.0 there.
  host: optional("HOST", process.env.HOST, isProduction ? "127.0.0.1" : "0.0.0.0"),
  apiPublicUrl: required("API_PUBLIC_URL", process.env.API_PUBLIC_URL, "http://localhost:4000"),
  webPublicUrl: required("WEB_PUBLIC_URL", process.env.WEB_PUBLIC_URL, "http://localhost:5173"),
  jwtSecret: requiredSecret("JWT_SECRET", process.env.JWT_SECRET, DEV_JWT_SECRET),
  adminLogin: optional("ADMIN_LOGIN", process.env.ADMIN_LOGIN, "admin"),
  adminPassword: required("ADMIN_PASSWORD", process.env.ADMIN_PASSWORD, isProduction ? undefined : "admin"),
  demoAdminEnabled: flag(process.env.DEMO_ADMIN_ENABLED, false),
  // No built-in demo credentials: a fallback literal committed to this repo is
  // a public admin password the moment DEMO_ADMIN_ENABLED is flipped on.
  demoAdminLogin: process.env.DEMO_ADMIN_LOGIN ? cleanEnvValue(process.env.DEMO_ADMIN_LOGIN) : "",
  demoAdminPassword: process.env.DEMO_ADMIN_PASSWORD ? cleanEnvValue(process.env.DEMO_ADMIN_PASSWORD) : "",
  mongoUri: required("MONGODB_URI", process.env.MONGODB_URI, "mongodb://127.0.0.1:27017/saudade"),

  // Stripe
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  marketplacePublicUrl: required("MARKETPLACE_PUBLIC_URL", process.env.MARKETPLACE_PUBLIC_URL, "http://localhost:3000"),

  // Cloudinary
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME ?? "",
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY ?? "",
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET ?? "",
  cloudinaryUploadFolder: process.env.CLOUDINARY_UPLOAD_FOLDER ?? "saudade",
  // Cloudinary "Token-based authentication" key (Settings > Security). Optional
  // add-on: when it is set, every signed delivery URL carries an expiry the CDN
  // itself enforces. See around/photoDelivery.ts for what happens without it.
  cloudinaryAuthTokenKey: process.env.CLOUDINARY_AUTH_TOKEN_KEY ? cleanEnvValue(process.env.CLOUDINARY_AUTH_TOKEN_KEY) : "",

  // Resend (transactional email)
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  mailFrom: process.env.MAIL_FROM ?? "SAUDADE <orders@saudade.thehnh.tech>",
  mailReplyTo: process.env.MAIL_REPLY_TO ?? "contact@thehnh.tech",
  mailAdminBcc: process.env.MAIL_ADMIN_BCC ?? "",

  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:8081,http://localhost:19006,http://localhost:3000,https://saudade.thehnh.tech,https://www.saudade.thehnh.tech")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Picture me around
  appleBundleId: optional("APPLE_BUNDLE_ID", process.env.APPLE_BUNDLE_ID, "tech.thehnh.saudade"),
  // Sign in with Apple REST credentials, used to revoke the user's Apple token
  // on account deletion (App Store Review 5.1.1(v)). All optional: when they
  // are missing the deletion still proceeds, it is only logged as unrevoked.
  appleTeamId: process.env.APPLE_TEAM_ID ? cleanEnvValue(process.env.APPLE_TEAM_ID) : "",
  appleKeyId: process.env.APPLE_KEY_ID ? cleanEnvValue(process.env.APPLE_KEY_ID) : "",
  // Contents of the .p8 key; literal "\n" sequences are re-expanded so the PEM
  // can travel through a single-line environment variable.
  applePrivateKey: (process.env.APPLE_PRIVATE_KEY ? cleanEnvValue(process.env.APPLE_PRIVATE_KEY) : "").replace(/\\n/g, "\n"),
  googleWebClientId: process.env.GOOGLE_WEB_CLIENT_ID ? cleanEnvValue(process.env.GOOGLE_WEB_CLIENT_ID) : "",
  googleIosClientId: process.env.GOOGLE_IOS_CLIENT_ID ? cleanEnvValue(process.env.GOOGLE_IOS_CLIENT_ID) : "",
  aroundMinWindowMs: numberEnv("AROUND_MIN_WINDOW_MS", process.env.AROUND_MIN_WINDOW_MS, 60 * 60 * 1000),
  aroundMaxWindowMs: numberEnv("AROUND_MAX_WINDOW_MS", process.env.AROUND_MAX_WINDOW_MS, 6 * 60 * 60 * 1000),
  aroundDefaultWindowMs: numberEnv("AROUND_DEFAULT_WINDOW_MS", process.env.AROUND_DEFAULT_WINDOW_MS, 4 * 60 * 60 * 1000),
  aroundRetentionMs: numberEnv("AROUND_RETENTION_MS", process.env.AROUND_RETENTION_MS, 7 * 24 * 60 * 60 * 1000),
  presenceFreshMs: numberEnv("PRESENCE_FRESH_MS", process.env.PRESENCE_FRESH_MS, 30 * 60 * 1000),
  joinMaxAccuracyM: numberEnv("JOIN_MAX_ACCURACY_M", process.env.JOIN_MAX_ACCURACY_M, 150),
  joinMaxFixAgeMs: numberEnv("JOIN_MAX_FIX_AGE_MS", process.env.JOIN_MAX_FIX_AGE_MS, 60 * 1000),
  joinMinFixSpacingMs: numberEnv("JOIN_MIN_FIX_SPACING_MS", process.env.JOIN_MIN_FIX_SPACING_MS, 8 * 1000),
  joinMaxInterFixSpeedMps: numberEnv("JOIN_MAX_INTER_FIX_SPEED_MPS", process.env.JOIN_MAX_INTER_FIX_SPEED_MPS, 10),
  reviewModeUserIds: csvEnv(process.env.REVIEW_MODE_USER_IDS),
  moderationAlertEmail: process.env.MODERATION_ALERT_EMAIL ? cleanEnvValue(process.env.MODERATION_ALERT_EMAIL) : "",
  devBypassRadius: flag(process.env.DEV_BYPASS_RADIUS, false)
};

export const stripeIsLive = config.stripeSecretKey.startsWith("sk_live_");

// NODE_ENV-independent guard: a host started with NODE_ENV unset, "prod" or
// "staging" would keep `isProduction === false` and silently serve on the
// public development secret. Anything that is not a local API URL must have a
// real JWT_SECRET.
function isLocalHostname(url: string) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

if (config.jwtSecret === DEV_JWT_SECRET && !isLocalHostname(config.apiPublicUrl)) {
  throw new Error(
    "[config] Refusing to boot with the development JWT secret on a non-local API_PUBLIC_URL. Set JWT_SECRET to a private random value."
  );
}

// DEV_BYPASS_RADIUS skips the whole physical-presence proof (radius, movement
// plausibility, GeoIP). The old guard only fired on NODE_ENV === "production",
// so a host started with NODE_ENV unset — the default of `node dist/server.js`
// and of the documented PM2 command — armed nothing at all. Same fail-closed
// rule as the JWT secret above, and NODE_ENV alone is not trusted: the bypass
// requires BOTH an explicitly local NODE_ENV and a local API_PUBLIC_URL.
if (config.devBypassRadius && (!["development", "test"].includes(nodeEnv) || !isLocalHostname(config.apiPublicUrl))) {
  throw new Error(
    `[config] DEV_BYPASS_RADIUS is enabled but this host is not manifestly local (NODE_ENV="${nodeEnv}", API_PUBLIC_URL="${config.apiPublicUrl}"). ` +
    "It is only allowed with NODE_ENV=development|test on a localhost API_PUBLIC_URL. Remove DEV_BYPASS_RADIUS and restart."
  );
}

// Demo admin: symmetrical to DEV_BYPASS_RADIUS. There are no built-in
// credentials any more, and the switch cannot be flipped in production.
if (config.isProduction && config.demoAdminEnabled) {
  throw new Error("[config] DEMO_ADMIN_ENABLED must never be enabled in production. Remove the env variable and restart.");
}
if (config.demoAdminEnabled && (!config.demoAdminLogin || !config.demoAdminPassword)) {
  throw new Error("[config] DEMO_ADMIN_ENABLED requires explicit DEMO_ADMIN_LOGIN and DEMO_ADMIN_PASSWORD (there are no built-in defaults).");
}

if (config.isProduction) {
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    console.warn("[config] Stripe is not fully configured. Checkout endpoints will return 503.");
  }
  if (!config.resendApiKey) {
    console.warn("[config] RESEND_API_KEY missing. Order confirmation emails are disabled.");
  }
  if (config.reviewModeUserIds.length > 0) {
    // REVIEW_MODE_USER_IDS is a complete bypass of the physical-presence
    // proof. It must not outlive App Store review: make the oversight loud at
    // every boot (each individual use is logged in aroundRoutes.ts).
    console.warn(
      `[config] REVIEW MODE ACTIVE for ${config.reviewModeUserIds.length} account(s): geo checks are bypassed for them. ` +
      "Clear REVIEW_MODE_USER_IDS and redeploy once App Store review is over."
    );
  }
  if (!config.adminPassword || config.adminPassword === "admin") {
    // Same fail-closed rule as JWT_SECRET: an empty (or default) admin
    // password would let `/api/admin/login` be passed with a known value.
    throw new Error("[config] ADMIN_PASSWORD must be set to a strong value in production (never empty, never the development default). Refusing to start.");
  }
}
