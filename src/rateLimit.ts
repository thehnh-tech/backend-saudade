import type { NextFunction, Request, Response } from "express";

const hits = new Map<string, number>();
const WINDOW_MS = 10_000;

export function uploadRateLimit(req: Request, res: Response, next: NextFunction) {
  const token = req.params.publicToken ?? "unknown";
  const forwarded = req.headers["x-forwarded-for"];
  const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim() || req.ip || "unknown";
  const key = `${ip}:${token}`;
  const now = Date.now();
  const last = hits.get(key);

  if (last && now - last < WINDOW_MS) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - last)) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({
      error: "RATE_LIMITED",
      message: "Only one photo is allowed every 10 seconds for this QR code.",
      retryAfterSeconds: retryAfter
    });
  }

  hits.set(key, now);
  for (const [storedKey, timestamp] of hits) {
    if (now - timestamp > WINDOW_MS * 6) hits.delete(storedKey);
  }
  return next();
}
