import express from "express";
import { registerAdminAroundRoutes } from "../../src/around/adminAroundRoutes.js";
import { registerAroundPhotoRoutes } from "../../src/around/aroundPhotoRoutes.js";
import { registerAroundRoutes } from "../../src/around/aroundRoutes.js";
import { registerAroundUserRoutes } from "../../src/around/userRoutes.js";

// Local Express app factory for the tests: registers only the around routes
// plus the same error handler contract as src/server.ts.
export function makeTestApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

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

  return app;
}
