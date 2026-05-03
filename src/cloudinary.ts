import { v2 as cloudinary, type UploadApiOptions, type UploadApiResponse } from "cloudinary";
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
    secure: true
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
