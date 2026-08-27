import { v2 as cloudinary, type ConfigOptions, type UploadApiOptions, type UploadApiResponse } from "cloudinary";
import { config } from "./config.js";

const cloudinaryConfigured = Boolean(
  config.cloudinaryCloudName &&
  config.cloudinaryApiKey &&
  config.cloudinaryApiSecret
);

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: config.cloudinaryCloudName,
    api_key: config.cloudinaryApiKey,
    api_secret: config.cloudinaryApiSecret,
    secure: true,
    // Only set when the token-based authentication add-on is provisioned; the
    // SDK ignores auth_token options entirely without this key. The typings
    // model auth_token as the per-URL shape (which requires acl/url); at the
    // global config level only `key` is meaningful, hence the cast.
    ...(config.cloudinaryAuthTokenKey
      ? { auth_token: { key: config.cloudinaryAuthTokenKey } as unknown as ConfigOptions["auth_token"] }
      : {})
  });
}

export function isCloudinaryConfigured() {
  return cloudinaryConfigured;
}

export function cloudinaryUrl(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function uploadImageBuffer(buffer: Buffer, options: UploadApiOptions) {
  if (!cloudinaryConfigured) {
    throw new Error("Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.");
  }

  return new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "image",
        folder: config.cloudinaryUploadFolder,
        overwrite: false,
        ...options
      },
      (error, result) => {
        if (error) reject(error);
        else if (!result) reject(new Error("Cloudinary upload failed"));
        else resolve(result);
      }
    );

    stream.end(buffer);
  });
}
