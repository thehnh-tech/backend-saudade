import express from "express";
import cors from "cors";
import helmetDefault from "helmet";

type HelmetMiddleware = (
  options?: { crossOriginResourcePolicy?: { policy: "cross-origin" | "same-origin" | "same-site" } }
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

const helmet = helmetDefault as unknown as HelmetMiddleware;
import { config } from "./config.js";
import { connectDb } from "./db.js";
import { registerRoutes } from "./routes.js";
import { registerCheckoutRoutes, registerStripeWebhook } from "./stripeRoutes.js";
import { registerAdminAroundRoutes } from "./around/adminAroundRoutes.js";
import { registerAroundPhotoRoutes } from "./around/aroundPhotoRoutes.js";
import { registerAroundRoutes } from "./around/aroundRoutes.js";
import { startAroundJobs } from "./around/jobs.js";
import { syncAroundIndexes } from "./around/models.js";
import { registerAroundUserRoutes } from "./around/userRoutes.js";

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

registerCheckoutRoutes(app);
registerRoutes(app);

// Picture me around (additive module)
registerAroundUserRoutes(app);
registerAroundRoutes(app);
registerAroundPhotoRoutes(app);
registerAdminAroundRoutes(app);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unexpected error";
  if (message.includes("File too large")) return res.status(413).json({ error: "PHOTO_TOO_LARGE" });
  if (message.includes("Unsupported image type")) return res.status(400).json({ error: "UNSUPPORTED_IMAGE_TYPE" });
  return res.status(500).json({ error: "INTERNAL_ERROR", message });
});

await connectDb();
try {
  await syncAroundIndexes();
} catch (err) {
  // The additive around module must never take the frozen API down: log and
  // keep booting (the module runs degraded until the index issue is fixed).
  console.error("[around] index sync failed — around module degraded, frozen API unaffected:", err);
}
startAroundJobs();

app.listen(config.port, () => {
  console.log(`Saudade API listening on ${config.apiPublicUrl}`);
});
