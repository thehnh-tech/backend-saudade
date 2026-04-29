import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import path from "node:path";
import { config } from "./config.js";
import { connectDb, GarmentModel } from "./db.js";
import { ensureInside, nowIso, safeRandomId } from "./utils.js";

await connectDb();

const publicToken = safeRandomId("qr", 18);
const clientId = safeRandomId("client", 9);
const clientPassword = "demo2026+";
const clientPasswordHash = await bcrypt.hash(clientPassword, 10);
const qrCodePath = `storage/qrcodes/${publicToken}.png`;
const captureUrl = `${config.webPublicUrl}/capture/${publicToken}`;

await QRCode.toFile(ensureInside(config.qrDir, path.join(config.qrDir, `${publicToken}.png`)), captureUrl, { margin: 2, width: 900 });

await GarmentModel.create({
  type: "tshirt",
  publicToken,
  clientId,
  clientPasswordHash,
  qrCodePath,
  createdAt: nowIso()
});

console.log(JSON.stringify({ publicToken, captureUrl, clientId, clientPassword }, null, 2));
process.exit(0);
