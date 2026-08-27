import dotenv from "dotenv";

dotenv.config();

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

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

function optional(name: string, value: string | undefined, fallback: string) {
  return required(name, value, fallback);
}

function flag(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return !["false", "0", "no", "off"].includes(cleanEnvValue(value).toLowerCase());
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
  apiPublicUrl: required("API_PUBLIC_URL", process.env.API_PUBLIC_URL, "http://localhost:4000"),
  webPublicUrl: required("WEB_PUBLIC_URL", process.env.WEB_PUBLIC_URL, "http://localhost:5173"),
  jwtSecret: required("JWT_SECRET", process.env.JWT_SECRET, "dev-only-change-me"),
  adminLogin: optional("ADMIN_LOGIN", process.env.ADMIN_LOGIN, "admin"),
  adminPassword: required("ADMIN_PASSWORD", process.env.ADMIN_PASSWORD, isProduction ? undefined : "admin"),
  demoAdminEnabled: flag(process.env.DEMO_ADMIN_ENABLED, false),
  demoAdminLogin: optional("DEMO_ADMIN_LOGIN", process.env.DEMO_ADMIN_LOGIN, "demo-admin"),
  demoAdminPassword: optional("DEMO_ADMIN_PASSWORD", process.env.DEMO_ADMIN_PASSWORD, "demo-admin"),
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

if (config.isProduction && config.devBypassRadius) {
  throw new Error("[config] DEV_BYPASS_RADIUS must never be enabled in production. Remove the env variable and restart.");
}

if (config.isProduction) {
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    console.warn("[config] Stripe is not fully configured. Checkout endpoints will return 503.");
  }
  if (!config.resendApiKey) {
    console.warn("[config] RESEND_API_KEY missing. Order confirmation emails are disabled.");
  }
  if (!config.adminPassword || config.adminPassword === "admin") {
    console.error("[config] ADMIN_PASSWORD must be set to a strong value before going live.");
  }
  if (config.demoAdminEnabled) {
    console.warn("[config] Demo admin credentials are enabled. Disable them unless they are explicitly needed.");
  }
}
