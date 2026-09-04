import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify, errors as joseErrors, type JWTVerifyOptions } from "jose";
import { config } from "../config.js";

// Server-side verification of the identity tokens sent by the mobile app.
// We never trust any profile data supplied by the client: only what the
// provider-signed JWT contains.

export type VerifiedIdentity = {
  sub: string;
  email: string | null; // only set when the provider marked it verified
  emailVerified: boolean;
};

export class OAuthVerificationError extends Error {
  constructor(
    public readonly status: 401 | 503,
    public readonly code: "INVALID_IDENTITY_TOKEN" | "OAUTH_PROVIDER_UNAVAILABLE"
  ) {
    super(code);
    this.name = "OAuthVerificationError";
  }
}

const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function isProviderUnavailable(error: unknown) {
  if (error instanceof joseErrors.JWKSTimeout) return true;
  // Network failures while fetching the remote JWKS surface as TypeError
  // ("fetch failed") or generic errors carrying a fetch cause.
  if (error instanceof TypeError) return true;
  const code = (error as { code?: string }).code;
  return code === "ERR_JWKS_TIMEOUT" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT";
}

async function verifyWith(
  jwks: ReturnType<typeof createRemoteJWKSet>,
  identityToken: string,
  options: JWTVerifyOptions
): Promise<VerifiedIdentity> {
  try {
    const { payload } = await jwtVerify(identityToken, jwks, options);
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) throw new OAuthVerificationError(401, "INVALID_IDENTITY_TOKEN");
    // Apple serialises email_verified as the string "true" in some tokens.
    const emailVerified = payload.email_verified === true || payload.email_verified === "true";
    const email = emailVerified && typeof payload.email === "string" && payload.email.includes("@")
      ? payload.email.trim().toLowerCase()
      : null;
    return { sub, email, emailVerified };
  } catch (error) {
    if (error instanceof OAuthVerificationError) throw error;
    if (isProviderUnavailable(error)) throw new OAuthVerificationError(503, "OAUTH_PROVIDER_UNAVAILABLE");
    throw new OAuthVerificationError(401, "INVALID_IDENTITY_TOKEN");
  }
}

export async function verifyAppleIdentityToken(identityToken: string): Promise<VerifiedIdentity> {
  return verifyWith(appleJwks, identityToken, {
    issuer: "https://appleid.apple.com",
    audience: config.appleBundleId
  });
}

// ---------------------------------------------------------------------------
// Sign in with Apple REST API (token exchange + revocation).
// Required by App Store Review 5.1.1(v): an app offering Sign in with Apple
// AND account deletion must revoke the user's Apple token on deletion.
// Every function here is best-effort: a missing configuration or an Apple-side
// failure must NEVER block the local deletion of the account.
// ---------------------------------------------------------------------------

const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

export function appleRestConfigured() {
  return Boolean(config.appleTeamId && config.appleKeyId && config.applePrivateKey && config.appleBundleId);
}

// client_secret for the Apple REST API: an ES256 JWT signed with the .p8 key.
async function appleClientSecret(): Promise<string> {
  const key = await importPKCS8(config.applePrivateKey, "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.appleKeyId })
    .setIssuer(config.appleTeamId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setAudience("https://appleid.apple.com")
    .setSubject(config.appleBundleId)
    .sign(key);
}

// Exchanges the authorization code produced by the native Sign in with Apple
// sheet for a refresh_token, the only credential Apple accepts for revocation
// past the 5-minute lifetime of the code. Returns null on any failure.
export async function exchangeAppleAuthorizationCode(code: string): Promise<string | null> {
  if (!appleRestConfigured()) return null;
  try {
    const body = new URLSearchParams({
      client_id: config.appleBundleId,
      client_secret: await appleClientSecret(),
      code,
      grant_type: "authorization_code"
    });
    const response = await fetch(APPLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      // Awaited inside the sign-in request, whose client aborts at 15 s: a
      // degraded Apple endpoint must cost seconds, never the whole sign-in.
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      console.warn(`[around:apple] authorization code exchange failed (${response.status})`);
      return null;
    }
    const payload = (await response.json()) as { refresh_token?: unknown };
    return typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
      ? payload.refresh_token
      : null;
  } catch (error) {
    console.warn("[around:apple] authorization code exchange failed", error);
    return null;
  }
}

// Revokes an Apple token. `hint` mirrors Apple's token_type_hint: we store and
// revoke a refresh_token when the client supplied an authorization code, and
// fall back to whatever we hold otherwise.
export async function revokeAppleToken(
  token: string,
  hint: "refresh_token" | "access_token" = "refresh_token"
): Promise<boolean> {
  if (!token) return false;
  if (!appleRestConfigured()) {
    console.warn(
      "[around:apple] APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY are not configured: the Apple token could NOT be revoked (App Store 5.1.1(v)). Account deletion continues."
    );
    return false;
  }
  try {
    const body = new URLSearchParams({
      client_id: config.appleBundleId,
      client_secret: await appleClientSecret(),
      token,
      token_type_hint: hint
    });
    const response = await fetch(APPLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    if (!response.ok) {
      console.error(`[around:apple] token revocation refused by Apple (${response.status})`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[around:apple] token revocation failed", error);
    return false;
  }
}

export async function verifyGoogleIdToken(identityToken: string): Promise<VerifiedIdentity> {
  const audiences = [config.googleWebClientId, config.googleIosClientId].filter((value) => value.length > 0);
  if (audiences.length === 0) {
    // Misconfigured server: refusing every Google login is safer than
    // accepting an unverified audience.
    throw new OAuthVerificationError(503, "OAUTH_PROVIDER_UNAVAILABLE");
  }
  return verifyWith(googleJwks, identityToken, {
    issuer: ["accounts.google.com", "https://accounts.google.com"],
    audience: audiences
  });
}
