import type { NextFunction, Request, Response } from "express";

// Central Express error handler. Shared by src/server.ts and the integration
// test app (test/helpers/app.ts) so the tests exercise the production contract.
//
// It must NEVER echo err.message back to the caller. wrap() (around/middleware
// .ts) forwards every unexpected rejection here, so the raw message could be a
// MongoServerError carrying an index name and duplicated key, a
// MongoServerSelectionError listing the replica-set hosts, a Cloudinary API
// error containing the string that was signed (folder, public_id, timestamp),
// or the "Cloudinary is not configured..." text that enumerates the expected
// environment variables. The around module has a disciplined symbolic error
// contract (NOT_A_MEMBER, PHOTO_NOT_FOUND, ...); an unexpected failure gets a
// symbolic code too, and the details are logged server-side.
export function aroundErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const message = err instanceof Error ? err.message : "Unexpected error";
  if (message.includes("File too large")) return res.status(413).json({ error: "PHOTO_TOO_LARGE" });
  if (message.includes("Unsupported image type")) return res.status(400).json({ error: "UNSUPPORTED_IMAGE_TYPE" });

  // Multer's other limits (text fields, part count) surface as coded errors;
  // without this they would fall through to a 500.
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === "LIMIT_FIELD_COUNT" || code === "LIMIT_PART_COUNT"
    || code === "LIMIT_FIELD_VALUE" || code === "LIMIT_FIELD_KEY") {
    return res.status(413).json({ error: "REQUEST_TOO_LARGE" });
  }
  if (code === "LIMIT_FILE_COUNT") return res.status(400).json({ error: "TOO_MANY_FILES" });
  if (code === "LIMIT_UNEXPECTED_FILE") return res.status(400).json({ error: "UNEXPECTED_FILE" });

  console.error(`[error] ${req.method} ${req.path}`, err);
  return res.status(500).json({ error: "INTERNAL_ERROR" });
}
