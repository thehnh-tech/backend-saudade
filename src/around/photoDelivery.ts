import { v2 as cloudinary } from "cloudinary";
// Importing ../cloudinary.js applies the cloudinary.config() side effect.
import { isCloudinaryConfigured } from "../cloudinary.js";
import { config } from "../config.js";

// Sole exit point for photo URLs (invariant #1). Assets are uploaded with
// type "authenticated": no public URL exists, we only ever store
// public_id + version, and every URL below is signed.

const DOWNLOAD_URL_TTL_S = 10 * 60;

// Lifetime of a delivery URL when token-based authentication is available.
const DELIVERY_URL_TTL_S = 15 * 60;

// EXPOSURE WINDOW — read this before changing anything here.
//
// A Cloudinary *delivery* signature (`sign_url`) has NO expiry: `expires_at`
// is silently ignored on cloudinary.url(), so adding it would be a no-op. The
// signed URL is a bearer credential: whoever holds it can fetch the image with
// no cookie, header or session, and neither a kick, a block, a leave nor an
// account deletion revokes it. Until the asset is destroyed (J+7 purge), a URL
// captured from a feed response keeps working.
//
// The only mechanism that actually bounds this is Cloudinary's token-based
// authentication add-on (Settings > Security). When CLOUDINARY_AUTH_TOKEN_KEY
// is set, the URLs below carry `__cld_token__=exp=...~hmac=...` and the CDN
// itself refuses them after DELIVERY_URL_TTL_S.
//
// RESIDUAL RISK when the key is NOT set (add-on not on the plan): delivery
// URLs stay valid until the asset is purged. What we do keep, unconditionally:
//   - the API responses that carry these URLs are sent with `Cache-Control:
//     no-store` so no proxy, CDN or shared cache retains them;
//   - the save/share path never uses them at all — it goes through
//     private_download_url() below, which DOES expire (10 min);
//   - the URLs are only ever emitted to a caller that passed requireMembership
//     at the moment of the request.
// This is a mitigation, not a fix. Provision the add-on and set the key.
function deliveryAuthToken() {
  return config.cloudinaryAuthTokenKey ? { auth_token: { duration: DELIVERY_URL_TTL_S } } : {};
}

if (isCloudinaryConfigured() && !config.cloudinaryAuthTokenKey) {
  console.warn(
    "[around:photoDelivery] CLOUDINARY_AUTH_TOKEN_KEY is not set: signed delivery URLs never expire " +
    "and stay valid until the asset is purged (see the exposure-window note above). " +
    "Provision Cloudinary token-based authentication."
  );
}

export function assertPhotoDeliveryReady() {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary is not configured: authenticated photo delivery is unavailable.");
  }
}

export function signedClearUrl(publicId: string, version: number) {
  return cloudinary.url(publicId, {
    resource_type: "image",
    type: "authenticated",
    secure: true,
    sign_url: true,
    version,
    ...deliveryAuthToken()
  });
}

// The signature covers the transformation: the blur cannot be stripped from
// the URL, and w_400 destroys the information anyway.
export function signedBlurUrl(publicId: string, version: number) {
  return cloudinary.url(publicId, {
    resource_type: "image",
    type: "authenticated",
    secure: true,
    sign_url: true,
    version,
    transformation: [{ effect: "blur:2000", width: 400, crop: "limit" }],
    ...deliveryAuthToken()
  });
}

export function downloadUrl(publicId: string, format: string) {
  return cloudinary.utils.private_download_url(publicId, format, {
    resource_type: "image",
    type: "authenticated",
    attachment: true,
    expires_at: Math.floor(Date.now() / 1000) + DOWNLOAD_URL_TTL_S
  });
}

export async function destroyAuthenticated(publicId: string) {
  const result = (await cloudinary.uploader.destroy(publicId, {
    resource_type: "image",
    type: "authenticated",
    invalidate: true
  })) as { result?: string };
  if (result.result !== "ok" && result.result !== "not found") {
    throw new Error(`Cloudinary destroy failed for ${publicId}: ${result.result ?? "unknown"}`);
  }
}
