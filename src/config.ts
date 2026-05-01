import dotenv from "dotenv";

dotenv.config();

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
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME ?? "",
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY ?? "",
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET ?? "",
  cloudinaryUploadFolder: process.env.CLOUDINARY_UPLOAD_FOLDER ?? "saudade",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:8081,http://localhost:19006")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
};
