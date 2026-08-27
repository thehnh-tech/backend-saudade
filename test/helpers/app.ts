import express from "express";
import { registerAdminAroundRoutes } from "../../src/around/adminAroundRoutes.js";
import { registerAroundPhotoRoutes } from "../../src/around/aroundPhotoRoutes.js";
import { registerAroundRoutes } from "../../src/around/aroundRoutes.js";
import { registerAroundUserRoutes } from "../../src/around/userRoutes.js";
import { aroundErrorHandler } from "../../src/errorHandler.js";

// Local Express app factory for the tests: registers only the around routes
// plus the SAME error handler as src/server.ts (imported, not duplicated, so
// the tests can never drift from the production error contract).
export function makeTestApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  registerAroundUserRoutes(app);
  registerAroundRoutes(app);
  registerAroundPhotoRoutes(app);
  registerAdminAroundRoutes(app);

  app.use(aroundErrorHandler);

  return app;
}

// Separate factory for the frozen routes.ts surface (POST /api/admin/login and
// friends). Kept apart from makeTestApp so the existing around test suites are
// unaffected; registerRoutes is imported lazily because routes.ts pulls in the
// marketplace models, geoip and the mailer.
export async function makeLegacyTestApp() {
  const { registerRoutes } = await import("../../src/routes.js");
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  registerRoutes(app);

  app.use(aroundErrorHandler);

  return app;
}
