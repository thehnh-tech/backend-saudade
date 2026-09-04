import type { Request } from "express";

export type AuthRole = "admin" | "client" | "user";

export type AuthPayload = {
  role: AuthRole;
  garmentId?: number;
  clientId?: string;
  userId?: string;
  // Set by jsonwebtoken on sign / read back on verify.
  iat?: number;
  exp?: number;
  // "session started at" (epoch seconds): the sign-in this token descends
  // from. Carried unchanged through every renewal so the lineage can be
  // capped (see around/middleware.ts). Absent on tokens signed before v1.1.
  sat?: number;
};

export type AuthedRequest = Request & {
  auth?: AuthPayload;
};
