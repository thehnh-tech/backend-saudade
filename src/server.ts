import express from "express";
import cors from "cors";
import helmetDefault from "helmet";

type HelmetMiddleware = (
  options?: { crossOriginResourcePolicy?: { policy: "cross-origin" | "same-origin" | "same-site" } }
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

const helmet = helmetDefault as unknown as HelmetMiddleware;
import { config } from "./config.js";
import { connectDb } from "./db.js";
import { aroundErrorHandler } from "./errorHandler.js";
import { registerRoutes } from "./routes.js";
import { registerCheckoutRoutes, registerStripeWebhook } from "./stripeRoutes.js";
import { registerAdminAroundRoutes } from "./around/adminAroundRoutes.js";
import { registerAroundPhotoRoutes } from "./around/aroundPhotoRoutes.js";
import { registerAroundRoutes } from "./around/aroundRoutes.js";
import { startAroundJobs } from "./around/jobs.js";
import { aroundOpportunisticJobs, cronSweepHandler } from "./around/serverless.js";
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
// On Vercel the requests tow the jobs (see serverless.ts); the cron sweep is
// the once-a-day net under them, inert without its secret.
if (process.env.VERCEL) app.use(aroundOpportunisticJobs);
app.get("/api/internal/cron/sweep", (req, res) => {
  void cronSweepHandler(req, res).catch(() => res.status(500).json({ error: "INTERNAL_ERROR" }));
});
registerAroundUserRoutes(app);
registerAroundRoutes(app);
registerAroundPhotoRoutes(app);
registerAdminAroundRoutes(app);

app.use(aroundErrorHandler);

await connectDb();
try {
  await syncAroundIndexes();
} catch (err) {
  // The additive around module must never take the frozen API down: log and
  // keep booting (the module runs degraded until the index issue is fixed).
  console.error("[around] index sync failed — around module degraded, frozen API unaffected:", err);
}
if (!process.env.VERCEL) startAroundJobs();

app.listen(config.port, config.host, () => {
  console.log(`Saudade API listening on ${config.host}:${config.port} (public: ${config.apiPublicUrl})`);
  if (config.isProduction && config.host !== "127.0.0.1" && config.host !== "localhost" && config.host !== "::1") {
    // Reachable beyond the loopback interface: X-Forwarded-For is then
    // caller-controlled for anyone who can hit this port directly, which
    // defeats the per-IP rate limits and the GeoIP check on join.
    console.warn(
      `[security] Listening on ${config.host} in production. Keep this port unreachable from the internet ` +
        "(firewall it, or set HOST=127.0.0.1 when a reverse proxy runs on the same host)."
    );
  }
});
