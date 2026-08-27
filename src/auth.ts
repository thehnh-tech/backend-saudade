import type { NextFunction, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { config } from "./config.js";
import type { AuthedRequest, AuthPayload, AuthRole } from "./types.js";

const defaultAuthOptions: SignOptions = { expiresIn: "7d" };

// HS256 is pinned on both sides: it is already the effective algorithm (it is
// jsonwebtoken's default for a string secret), and pinning it on verify removes
// any latitude left to the attacker-controlled `alg` header.
export function signAuth(payload: AuthPayload, options: SignOptions = defaultAuthOptions) {
  return jwt.sign(payload, config.jwtSecret, { algorithm: "HS256", ...options });
}

export function requireRole(role: AuthRole) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      return res.status(401).json({ error: "AUTH_REQUIRED" });
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as AuthPayload;
      if (payload.role !== role) {
        return res.status(403).json({ error: "FORBIDDEN" });
      }
      req.auth = payload;
      return next();
    } catch {
      return res.status(401).json({ error: "INVALID_TOKEN" });
    }
  };
}
