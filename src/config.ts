import dotenv from "dotenv";

dotenv.config();

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

function required(name: string, value: string | undefined, fallback?: string) {
  if (value && value.trim().length > 0) return value;
  if (!isProduction && fallback !== undefined) return fallback;
  if (isProduction) {
    console.warn(`[config] ${name} is missing in production. Some features will be disabled.`);
  }
  return fallback ?? "";
}

export const config = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  apiPublicUrl: required("API_PUBLIC_URL", process.env.API_PUBLIC_URL, "http://localhost:4000"),
  webPublicUrl: required("WEB_PUBLIC_URL", process.env.WEB_PUBLIC_URL, "http://localhost:5173"),
  jwtSecret: required("JWT_SECRET", process.env.JWT_SECRET, "dev-only-change-me"),
  adminLogin: required("ADMIN_LOGIN", process.env.ADMIN_LOGIN, "saudadeHNH"),
  adminPassword: required("ADMIN_PASSWORD", process.env.ADMIN_PASSWORD, "saudade2026+"),
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
  mailReplyTo: process.env.MAIL_REPLY_TO ?? "hello@saudade.thehnh.tech",
  mailAdminBcc: process.env.MAIL_ADMIN_BCC ?? "",

  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:8081,http://localhost:19006,http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
};

export const stripeIsLive = config.stripeSecretKey.startsWith("sk_live_");

if (config.isProduction) {
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    console.warn("[config] Stripe is not fully configured. Checkout endpoints will return 503.");
  }
  if (!config.resendApiKey) {
    console.warn("[config] RESEND_API_KEY missing. Order confirmation emails are disabled.");
  }
  if (config.adminPassword === "saudade2026+") {
    console.error("[config] ADMIN_PASSWORD is the default. Set a strong password before going live.");
  }
}
