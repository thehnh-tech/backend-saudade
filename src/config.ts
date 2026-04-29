import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  port: Number(process.env.PORT ?? 4000),
  apiPublicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:4000",
  webPublicUrl: process.env.WEB_PUBLIC_URL ?? "http://localhost:5173",
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",
  adminLogin: process.env.ADMIN_LOGIN ?? "saudadeHNH",
  adminPassword: process.env.ADMIN_PASSWORD ?? "saudade2026+",
  mongoUri: process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/saudade",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  marketplacePublicUrl: process.env.MARKETPLACE_PUBLIC_URL ?? "http://localhost:3000",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:8081,http://localhost:19006")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  dataDir: path.join(root, "data"),
  storageDir: path.join(root, "storage"),
  uploadsDir: path.join(root, "storage", "uploads"),
  qrDir: path.join(root, "storage", "qrcodes")
};
