import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { config } from "./config.js";
import { uploadImageBuffer } from "./cloudinary.js";
import { connectDb, GarmentModel } from "./db.js";
import { nowIso, safeRandomId } from "./utils.js";

await connectDb();

const publicToken = safeRandomId("qr", 18);
const clientId = safeRandomId("client", 9);
const clientPassword = "demo2026+";
const clientPasswordHash = await bcrypt.hash(clientPassword, 10);
const captureUrl = `${config.webPublicUrl}/capture/${publicToken}`;
const qrBuffer = await QRCode.toBuffer(captureUrl, { margin: 2, width: 900, type: "png" });
const qrUpload = await uploadImageBuffer(qrBuffer, {
  folder: `${config.cloudinaryUploadFolder}/qrcodes`,
  public_id: publicToken,
  format: "png"
});

await GarmentModel.create({
  type: "tshirt",
  publicToken,
  clientId,
  clientPasswordHash,
  qrCodePath: qrUpload.secure_url,
  createdAt: nowIso()
});

console.log(JSON.stringify({ publicToken, captureUrl, clientId, clientPassword }, null, 2));
process.exit(0);
