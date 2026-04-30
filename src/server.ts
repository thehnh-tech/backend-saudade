import express from "express";
import cors from "cors";
import helmetDefault from "helmet";
import { config } from "./config.js";
import { connectDb } from "./db.js";
import { registerRoutes } from "./routes.js";
import { registerCheckoutRoutes, registerStripeWebhook } from "./stripeRoutes.js";

type HelmetMiddleware = (
  options?: { crossOriginResourcePolicy?: { policy: "cross-origin" | "same-origin" | "same-site" } }
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

const helmet = helmetDefault as unknown as HelmetMiddleware;

const app = express();

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
    else callback(new Error("CORS blocked"));
  }
}));
registerStripeWebhook(app);
app.use(express.json({ limit: "1mb" }));
app.use("/storage", express.static(config.storageDir, { fallthrough: true, immutable: false }));

registerCheckoutRoutes(app);
registerRoutes(app);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unexpected error";
  if (message.includes("File too large")) return res.status(413).json({ error: "PHOTO_TOO_LARGE" });
  if (message.includes("Unsupported image type")) return res.status(400).json({ error: "UNSUPPORTED_IMAGE_TYPE" });
  return res.status(500).json({ error: "INTERNAL_ERROR", message });
});

await connectDb();

app.listen(config.port, () => {
  console.log(`Saudade API listening on ${config.apiPublicUrl}`);
});
