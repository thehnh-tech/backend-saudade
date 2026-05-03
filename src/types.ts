import type { Request } from "express";

export type AuthRole = "admin" | "client";

export type AuthPayload = {
  role: AuthRole;
  garmentId?: number;
  clientId?: string;
};

export type AuthedRequest = Request & {
  auth?: AuthPayload;
};
