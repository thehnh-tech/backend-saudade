import { Types } from "mongoose";
import { signAuth } from "../auth.js";
import { AroundReservedPseudoModel, AroundUserModel, type AroundUser } from "./models.js";
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

// A pseudo is unavailable when a live account holds it OR when it is still
// tombstoned from a deleted account (see DELETE /api/users/me).
export async function pseudoIsTaken(pseudoLower: string, excludeUserId?: Types.ObjectId) {
  const byUser = await AroundUserModel.exists(
    excludeUserId ? { pseudoLower, _id: { $ne: excludeUserId } } : { pseudoLower }
  );
  if (byUser) return true;
  return Boolean(await AroundReservedPseudoModel.exists({ pseudoLower }));
}

export function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

// Which unique index a write collided with. Two of them can fire on the same
// insert (pseudoLower and email) and they do NOT get the same answer: a taken
// pseudo is told to the caller, a taken e-mail never is (see emailAuth.ts).
export function duplicateKeyFields(error: unknown): string[] {
  if (!isDuplicateKeyError(error)) return [];
  const pattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
  if (pattern && typeof pattern === "object") return Object.keys(pattern);
  const message = (error as { message?: string }).message ?? "";
  // Older drivers only carry the index name ("email_1 dup key").
  return message.includes("email") ? ["email"] : message.includes("pseudoLower") ? ["pseudoLower"] : [];
}

export function authTokenFor(user: Pick<AroundUser, "_id">) {
  return signAuth({ role: "user", userId: String(user._id) });
}
