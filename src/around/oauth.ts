import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTVerifyOptions } from "jose";
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
