import { signAuth } from "../auth.js";
import { AroundUserModel, type AroundUser } from "./models.js";
import { checkUserText } from "./textFilter.js";

// Identity primitives shared by the two ways into an account: Sign in with
// Apple (userRoutes.ts) and e-mail sign-up (emailAuth.ts). They used to live in
// userRoutes.ts; they are here so emailAuth.ts can reuse them without the two
// modules importing each other.

export const PSEUDO_PATTERN = /^[a-zA-Z0-9._-]{3,24}$/;

// The pseudo is displayed to people who never joined anything (it is the
// `ownerPseudo` of every around card in /nearby, next to the name pushed to
// strangers), so it goes through the same first-line filter as an around name.
// Shape first (PSEUDO_PATTERN), content second: a caller gets INVALID_PSEUDO
// either way, and only the content refusal carries a `reason`.
export function pseudoRefusal(pseudo: string): { error: string; reason?: string } | null {
  if (!PSEUDO_PATTERN.test(pseudo)) return { error: "INVALID_PSEUDO" };
  const verdict = checkUserText(pseudo, "pseudo");
  if (!verdict.ok) return { error: "INVALID_PSEUDO", reason: verdict.reason };
  return null;
}

export function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

// Which unique index a write collided with. Public names are not unique any
// more, so pseudoLower can only fire from a stale index that predates the
// migration; the mapping is kept as a net until syncIndexes has run in prod.
export function duplicateKeyFields(error: unknown): string[] {
  if (!isDuplicateKeyError(error)) return [];
  const pattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
  if (pattern && typeof pattern === "object") return Object.keys(pattern);
  const message = (error as { message?: string }).message ?? "";
  // Older drivers only carry the index name ("email_1 dup key").
  return message.includes("email") ? ["email"] : message.includes("pseudoLower") ? ["pseudoLower"] : [];
}

export function authTokenFor(user: Pick<AroundUser, "_id">) {
  // A fresh sign-in starts a new lineage (`sat`); renewals keep it.
  return signAuth({ role: "user", userId: String(user._id), sat: Math.floor(Date.now() / 1000) });
}
