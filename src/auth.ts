import type { NextFunction, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { config } from "./config.js";
import type { AuthedRequest, AuthPayload, AuthRole } from "./types.js";

const defaultAuthOptions: SignOptions = { expiresIn: "7d" };

export function signAuth(payload: AuthPayload, options: SignOptions = defaultAuthOptions) {
  return jwt.sign(payload, config.jwtSecret, options);
}

export function requireRole(role: AuthRole) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      return res.status(401).json({ error: "AUTH_REQUIRED" });
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret) as AuthPayload;
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
