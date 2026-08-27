import type { NextFunction, Response } from "express";
import { isValidObjectId } from "mongoose";
import { requireRole } from "../auth.js";
import type { AuthedRequest } from "../types.js";
import { AroundUserModel, type Around, type AroundMember, type AroundUser } from "./models.js";

export type AroundRequest = AuthedRequest & {
  user?: AroundUser;
  around?: Around;
  membership?: AroundMember;
};

// Express 4 does not route a rejected promise from an async handler to the
// error middleware: wrap() forwards the rejection to next() so the central
// handler in server.ts answers a clean 500 instead of leaving the socket
// hanging. Every async handler of the around module must be wrapped.
export const wrap = (fn: (req: AroundRequest, res: Response) => Promise<unknown>) =>
  (req: AroundRequest, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

// A 7-day JWT must not survive a ban: every user route re-checks the account
// in database. A 60s in-memory cache keeps this cheap; ban/deletion paths call
// invalidateUserCache() so the change applies immediately in-process.
const USER_CACHE_TTL_MS = 60_000;
const userCache = new Map<string, { user: AroundUser | null; cachedAt: number }>();

export function invalidateUserCache(userId: string) {
  userCache.delete(userId);
}

export function resetUserCache() {
  userCache.clear();
}

async function loadUser(userId: string): Promise<AroundUser | null> {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < USER_CACHE_TTL_MS) return cached.user;
  const user = await AroundUserModel.findById(userId).lean<AroundUser>();
  userCache.set(userId, { user, cachedAt: Date.now() });
  if (userCache.size > 5000) {
    const cutoff = Date.now() - USER_CACHE_TTL_MS;
    for (const [key, entry] of userCache) {
      if (entry.cachedAt < cutoff) userCache.delete(key);
    }
  }
  return user;
}

const requireUserRole = requireRole("user");

export function requireUser(req: AroundRequest, res: Response, next: NextFunction) {
  requireUserRole(req, res, () => {
    void (async () => {
      try {
        const userId = req.auth?.userId;
        if (!userId || !isValidObjectId(userId)) {
          return res.status(401).json({ error: "INVALID_TOKEN" });
        }
        const user = await loadUser(userId);
        if (!user) return res.status(401).json({ error: "INVALID_TOKEN" });
        if (user.status === "banned") return res.status(403).json({ error: "USER_BANNED" });
        req.user = user;
        return next();
      } catch (error) {
        return next(error);
      }
    })();
  });
}
