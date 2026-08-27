import type { Request } from "express";

export type AuthRole = "admin" | "client" | "user";

export type AuthPayload = {
  role: AuthRole;
  garmentId?: number;
  clientId?: string;
  userId?: string;
};

export type AuthedRequest = Request & {
  auth?: AuthPayload;
};
