import crypto from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function safeRandomId(prefix: string, size = 10) {
  const value = crypto.randomBytes(size).toString("base64url");
  return `${prefix}_${value}`;
}

export function publicUrlForLocalPath(localPath: string) {
  return localPath.replaceAll("\\", "/");
}

export function isSupportedImage(buffer: Buffer) {
  const jpg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = buffer.length > 12 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
  return jpg || png || webp;
}
