import { v2 as cloudinary } from "cloudinary";
// Importing ../cloudinary.js applies the cloudinary.config() side effect.
import { isCloudinaryConfigured } from "../cloudinary.js";

// Sole exit point for photo URLs (invariant #1). Assets are uploaded with
// type "authenticated": no public URL exists, we only ever store
// public_id + version, and every URL below is signed.

const DOWNLOAD_URL_TTL_S = 10 * 60;

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
    version
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
    transformation: [{ effect: "blur:2000", width: 400, crop: "limit" }]
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
