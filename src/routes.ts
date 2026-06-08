import bcrypt from "bcryptjs";
import type { Express, Request, Response } from "express";
import multer from "multer";
import QRCode from "qrcode";
import { z } from "zod";
import { requireRole, signAuth } from "./auth.js";
import { cloudinaryUrl, uploadImageBuffer } from "./cloudinary.js";
import { config } from "./config.js";
import { GarmentModel, PhotoModel, ProductModel, type Garment, type Photo, type Product } from "./db.js";
import { countryFromLocale, lookupGeo } from "./geo.js";
import { sendPublicCaptureEmail } from "./mailer.js";
import { uploadRateLimit } from "./rateLimit.js";
import type { AuthedRequest } from "./types.js";
import { isSupportedImage, nowIso, publicUrlForLocalPath, safeRandomId } from "./utils.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    if (["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported image type"));
  }
});

const PUBLIC_FEED_PURPOSE = "public-feed" as const;
const CLIENT_FEED_PURPOSE = "client-feed" as const;
const PUBLIC_FEED_GARMENT_TYPE = "picture-me-sticker";

const createGarmentSchema = z.object({
  type: z.string().trim().min(2).max(40).default("tshirt")
});

const adminLoginSchema = z.object({
  login: z.string().trim().min(1),
  password: z.string().trim().min(1)
});

const clientLoginSchema = z.object({
  clientId: z.string().min(6),
  password: z.string().min(6)
});

const createProductSchema = z.object({
  title: z.string().trim().min(3).max(140),
  shortTitle: z.string().trim().min(2).max(60).optional(),
  colorway: z.string().trim().min(3).max(60),
  price: z.number().positive().max(10000),
  status: z.enum(["available", "coming-soon", "draft"]).default("draft"),
  category: z.string().trim().min(2).max(60).default("T-shirts"),
  collection: z.string().trim().min(2).max(100).default("SAUDADE 0024 - Night Access"),
  description: z.string().trim().min(8).max(800).optional(),
  vibe: z.string().trim().min(3).max(160).optional(),
  cardImage: z.string().trim().min(1).default("/assets/tee-white-red-card.png"),
  tags: z.array(z.string().trim().min(1).max(40)).default([]),
  sizes: z.array(z.string().trim().min(1).max(8)).default(["XS", "S", "M", "L", "XL", "XXL"])
});

const updateProductSchema = z.object({
  title: z.string().trim().min(3).max(140).optional(),
  shortTitle: z.string().trim().min(2).max(60).optional(),
  colorway: z.string().trim().min(3).max(60).optional(),
  price: z.number().positive().max(10000).optional(),
  status: z.enum(["available", "coming-soon", "draft"]).optional(),
  category: z.string().trim().min(2).max(60).optional(),
  collection: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().min(8).max(800).optional(),
  vibe: z.string().trim().min(3).max(160).optional(),
  cardImage: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).optional(),
  sizes: z.array(z.string().trim().min(1).max(8)).optional()
}).refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field to update." });

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function bodyString(value: unknown) {
  if (Array.isArray(value)) return bodyString(value[0]);
  return typeof value === "string" ? value.trim() : "";
}

function bodyFlag(value: unknown) {
  return ["true", "1", "yes", "on"].includes(bodyString(value).toLowerCase());
}

function garmentPurpose(garment: Garment) {
  return garment.purpose ?? CLIENT_FEED_PURPOSE;
}

function isPublicFeedGarment(garment: Garment) {
  return garmentPurpose(garment) === PUBLIC_FEED_PURPOSE;
}

async function createGarmentKit(type: string, purpose: typeof CLIENT_FEED_PURPOSE | typeof PUBLIC_FEED_PURPOSE) {
  const publicToken = safeRandomId("qr", 18);
  const clientId = safeRandomId("client", 9);
  const clientPassword = safeRandomId("pass", 9);
  const clientPasswordHash = await bcrypt.hash(clientPassword, 10);
  const createdAt = nowIso();
  const captureUrl = `${config.webPublicUrl}/capture/${publicToken}`;
  const qrBuffer = await QRCode.toBuffer(captureUrl, { margin: 2, width: 900, type: "png" });
  const qrUpload = await uploadImageBuffer(qrBuffer, {
    folder: `${config.cloudinaryUploadFolder}/qrcodes`,
    public_id: publicToken,
    format: "png"
  });

  const garment = await GarmentModel.create({
    type,
    purpose,
    publicToken,
    clientId,
    clientPasswordHash,
    clientPasswordPlain: clientPassword,
    qrCodePath: qrUpload.secure_url,
    createdAt
  });

  return { garment: garment.toObject() as Garment, clientPassword };
}

async function ensurePublicFeedGarment() {
  const existing = await GarmentModel.findOne({ purpose: PUBLIC_FEED_PURPOSE }).sort({ createdAt: -1 }).lean<Garment>();
  if (existing) return existing;
  const created = await createGarmentKit(PUBLIC_FEED_GARMENT_TYPE, PUBLIC_FEED_PURPOSE);
  return created.garment;
}

function garmentResponse(garment: Garment, options: { includePassword?: boolean } = {}) {
  const qrCodeUrl = cloudinaryUrl(garment.qrCodePath)
    ? garment.qrCodePath
    : `${config.apiPublicUrl}/${publicUrlForLocalPath(garment.qrCodePath)}`;
  const purpose = garmentPurpose(garment);

  return {
    id: garment.numericId,
    type: garment.type,
    purpose,
    captureKind: purpose === PUBLIC_FEED_PURPOSE ? "public-feed" : "client-feed",
    publicToken: garment.publicToken,
    clientId: garment.clientId,
    qrCodeUrl,
    captureUrl: `${config.webPublicUrl}/capture/${garment.publicToken}`,
    createdAt: garment.createdAt,
    ...(options.includePassword ? { clientPassword: garment.clientPasswordPlain ?? null } : {})
  };
}

function photoResponse(photo: Photo) {
  const resolveImageUrl = (path: string) => (
    cloudinaryUrl(path) ? path : `${config.apiPublicUrl}/${publicUrlForLocalPath(path)}`
  );

  const imageUrl = resolveImageUrl(photo.imagePath);
  const secondaryImageUrl = photo.secondaryImagePath ? resolveImageUrl(photo.secondaryImagePath) : null;

  return {
    id: photo.numericId,
    garmentId: photo.garmentId,
    imageUrl,
    secondaryImageUrl,
    createdAt: photo.createdAt,
    metadata: photo.metadata ?? null
  };
}

function publicFeedPhotoResponse(photo: Photo) {
  const base = photoResponse(photo);
  const metadata = photo.metadata ?? {};
  const captureMode = typeof metadata.captureMode === "string" ? metadata.captureMode : "double";
  const country = typeof metadata.country === "string" ? metadata.country : null;
  const countryCode = typeof metadata.countryCode === "string" ? metadata.countryCode : null;
  const city = typeof metadata.city === "string" ? metadata.city : null;
  const region = typeof metadata.region === "string" ? metadata.region : null;
  return {
    id: base.id,
    garmentId: base.garmentId,
    imageUrl: base.imageUrl,
    secondaryImageUrl: base.secondaryImageUrl,
    createdAt: base.createdAt,
    captureMode,
    primaryLabel: captureMode === "front" ? "Front" : captureMode === "back" ? "Back" : "Rear",
    secondaryLabel: base.secondaryImageUrl ? "Front" : null,
    country,
    countryCode,
    city,
    region,
    metadata: { country, countryCode, city, region, captureMode }
  };
}

function adminPublicFeedPhotoResponse(photo: Photo) {
  const metadata = photo.metadata ?? {};
  return {
    ...publicFeedPhotoResponse(photo),
    uploaderIp: photo.uploaderIp,
    email: typeof metadata.email === "string" ? metadata.email : null,
    marketingConsent: Boolean(metadata.marketingConsent),
    moderationStatus: typeof metadata.moderationStatus === "string" ? metadata.moderationStatus : "visible",
    userAgent: typeof metadata.userAgent === "string" ? metadata.userAgent : null
  };
}

function productResponse(product: Product) {
  const images = product.images.filter((image) => !["/assets/back.png", "/assets/poster-back-transparent.png"].includes(image.src));
  return {
    id: product.productId,
    slug: product.slug,
    title: product.title,
    shortTitle: product.shortTitle,
    price: product.price,
    unitAmount: product.unitAmount,
    currency: product.currency,
    collection: product.collection,
    category: product.category,
    tags: product.tags,
    colorway: product.colorway,
    description: product.description,
    vibe: product.vibe,
    cardImage: product.cardImage,
    details: product.details,
    images,
    variants: product.variants,
    sizes: product.sizes,
    status: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt
  };
}

export function registerRoutes(app: Express) {
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/public-feed/photos", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const requestedLimit = Number(req.query.limit ?? 30);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 60) : 30;
    const photos = await PhotoModel.find({ "metadata.publicFeed": true })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<Photo[]>();
    return res.json({ photos: photos.map(publicFeedPhotoResponse), updatedAt: nowIso() });
  });

  app.get("/api/products", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const products = await ProductModel.find({ status: { $ne: "draft" } }).sort({ createdAt: 1 }).lean<Product[]>();
    return res.json({ products: products.map(productResponse) });
  });

  app.get("/api/products/:id", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const product = await ProductModel.findOne({
      productId: req.params.id,
      status: { $ne: "draft" }
    }).lean<Product>();
    if (!product) return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    return res.json({ product: productResponse(product) });
  });

  app.post("/api/admin/login", (req, res) => {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
    const primaryAdmin = parsed.data.login === config.adminLogin && parsed.data.password === config.adminPassword;
    const demoAdmin = config.demoAdminEnabled
      && parsed.data.login === config.demoAdminLogin
      && parsed.data.password === config.demoAdminPassword;
    if (!primaryAdmin && !demoAdmin) {
      return res.status(401).json({ error: "INVALID_CREDENTIALS" });
    }
    return res.json({ token: signAuth({ role: "admin" }), role: "admin" });
  });

  app.post("/api/admin/garments", requireRole("admin"), async (req: Request, res: Response) => {
    const parsed = createGarmentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });

    const { garment, clientPassword } = await createGarmentKit(parsed.data.type, CLIENT_FEED_PURPOSE);
    return res.status(201).json({ ...garmentResponse(garment, { includePassword: true }), clientPassword });
  });

  app.get("/api/admin/garments", requireRole("admin"), async (_req, res) => {
    const garments = await GarmentModel.find({
      $or: [{ purpose: { $exists: false } }, { purpose: CLIENT_FEED_PURPOSE }]
    }).sort({ createdAt: -1 }).lean<Garment[]>();
    return res.json({ garments: garments.map((garment) => garmentResponse(garment, { includePassword: true })) });
  });

  app.delete("/api/admin/garments/:id", requireRole("admin"), async (req, res) => {
    const numericId = Number(req.params.id);
    if (!Number.isFinite(numericId)) return res.status(400).json({ error: "INVALID_ID" });
    const removed = await GarmentModel.findOneAndDelete({
      numericId,
      $or: [{ purpose: { $exists: false } }, { purpose: CLIENT_FEED_PURPOSE }]
    });
    if (!removed) return res.status(404).json({ error: "GARMENT_NOT_FOUND" });
    return res.json({ ok: true });
  });

  app.get("/api/admin/public-feed/qr", requireRole("admin"), async (_req, res) => {
    const garment = await ensurePublicFeedGarment();
    return res.json({ qr: garmentResponse(garment, { includePassword: false }) });
  });

  app.get("/api/admin/public-feed/photos", requireRole("admin"), async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const photos = await PhotoModel.find({ "metadata.publicFeed": true })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean<Photo[]>();
    return res.json({ photos: photos.map(adminPublicFeedPhotoResponse) });
  });

  app.delete("/api/admin/public-feed/photos/:id", requireRole("admin"), async (req, res) => {
    const numericId = Number(req.params.id);
    if (!Number.isFinite(numericId)) return res.status(400).json({ error: "INVALID_PHOTO_ID" });
    const removed = await PhotoModel.findOneAndDelete({ numericId, "metadata.publicFeed": true });
    if (!removed) return res.status(404).json({ error: "PHOTO_NOT_FOUND" });
    return res.json({ ok: true });
  });

  app.post("/api/admin/products", requireRole("admin"), async (req: Request, res: Response) => {
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });

    const now = nowIso();
    const randomSuffix = safeRandomId("p", 5);
    const productId = `${slugify(parsed.data.title)}-${randomSuffix}`;
    const slug = slugify(`${parsed.data.title}-${parsed.data.colorway}-${randomSuffix}`);
    const unitAmount = Math.round(parsed.data.price * 100);

    const product = await ProductModel.create({
      productId,
      slug,
      title: parsed.data.title,
      shortTitle: parsed.data.shortTitle ?? parsed.data.title,
      price: parsed.data.price,
      unitAmount,
      currency: "eur",
      collection: parsed.data.collection,
      category: parsed.data.category,
      colorway: parsed.data.colorway,
      status: parsed.data.status,
      description: parsed.data.description ?? "A SAUDADE piece built for night access, memory, and luxury underground energy.",
      vibe: parsed.data.vibe ?? `${parsed.data.colorway}. Private archive energy.`,
      cardImage: parsed.data.cardImage,
      details: [
        "Oversized boxy fit",
        "Heavyweight cotton",
        `${parsed.data.colorway} colorway`,
        "SAUDADE QR memory concept"
      ],
      tags: parsed.data.tags,
      images: [{ label: "Product card", src: parsed.data.cardImage, kind: "card" }],
      variants: [{ name: parsed.data.colorway, textile: "#F4F1EC", print: "#D71920", accent: "#D71920" }],
      sizes: parsed.data.sizes,
      createdAt: now,
      updatedAt: now
    });

    return res.status(201).json({ product: productResponse(product.toObject() as Product) });
  });

  app.get("/api/admin/products", requireRole("admin"), async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const products = await ProductModel.find().sort({ createdAt: -1 }).lean<Product[]>();
    return res.json({ products: products.map(productResponse) });
  });

  app.patch("/api/admin/products/:id", requireRole("admin"), async (req: Request, res: Response) => {
    const parsed = updateProductSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });

    const product = await ProductModel.findOne({ productId: req.params.id });
    if (!product) return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });

    const data = parsed.data;
    if (data.title !== undefined) {
      product.title = data.title;
      if (data.shortTitle === undefined) product.shortTitle = data.title;
    }
    if (data.shortTitle !== undefined) product.shortTitle = data.shortTitle;
    if (data.colorway !== undefined) product.colorway = data.colorway;
    if (data.price !== undefined) {
      product.price = data.price;
      product.unitAmount = Math.round(data.price * 100);
    }
    if (data.status !== undefined) product.status = data.status;
    if (data.category !== undefined) product.category = data.category;
    if (data.collection !== undefined) product.set("collection", data.collection);
    if (data.description !== undefined) product.description = data.description;
    if (data.vibe !== undefined) product.vibe = data.vibe;
    if (data.cardImage !== undefined) {
      product.cardImage = data.cardImage;
      const nonCardImages = product.images.filter((image) => image.kind !== "card");
      product.images = [{ label: "Product card", src: data.cardImage, kind: "card" }, ...nonCardImages];
    }
    if (data.tags !== undefined) product.tags = data.tags;
    if (data.sizes !== undefined) product.sizes = data.sizes;
    product.updatedAt = nowIso();

    await product.save();
    return res.json({ product: productResponse(product.toObject() as Product) });
  });

  app.delete("/api/admin/products/:id", requireRole("admin"), async (req, res) => {
    const removed = await ProductModel.findOneAndDelete({ productId: req.params.id });
    if (!removed) return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });
    return res.json({ ok: true });
  });

  app.get("/api/qr/:publicToken", async (req, res) => {
    const garment = await GarmentModel.findOne({ publicToken: req.params.publicToken }).lean<Garment>();
    if (!garment) return res.status(404).json({ error: "QR_NOT_FOUND" });
    const purpose = garmentPurpose(garment);
    return res.json({
      id: garment.numericId,
      type: garment.type,
      purpose,
      captureKind: purpose === PUBLIC_FEED_PURPOSE ? "public-feed" : "client-feed",
      publicToken: garment.publicToken,
      createdAt: garment.createdAt
    });
  });

  app.post(
    "/api/capture/:publicToken/upload",
    uploadRateLimit,
    upload.any(),
    async (req, res) => {
      const garment = await GarmentModel.findOne({ publicToken: req.params.publicToken }).lean<Garment>();
      if (!garment) return res.status(404).json({ error: "QR_NOT_FOUND" });
      const publicFeedUpload = isPublicFeedGarment(garment);

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const captureMode = String(req.body.captureMode ?? "double");
      const captureSide = String(req.body.captureSide ?? "");
      const captureSource = String(req.body.captureSource ?? "");
      if (captureSource !== "camera-canvas") {
        return res.status(400).json({
          error: "CAMERA_CAPTURE_REQUIRED",
          message: "Upload must come from the web app camera stream."
        });
      }
      const emailValue = bodyString(req.body.email).toLowerCase();
      const marketingConsent = bodyFlag(req.body.marketingConsent);

      let publicFeedEmail: string | null = null;
      if (publicFeedUpload && emailValue) {
        const parsedEmail = z.string().email().safeParse(emailValue);
        if (!parsedEmail.success) {
          return res.status(400).json({
            error: "INVALID_EMAIL",
            message: "Enter a valid email or leave the email field empty."
          });
        }
        if (!marketingConsent) {
          return res.status(400).json({
            error: "CONSENT_REQUIRED",
            message: "Consent is required only if you want to receive your photos and offers by email."
          });
        }
        publicFeedEmail = parsedEmail.data;
      }

      const firstFile = (names: string[]) => files.find((file) => names.includes(file.fieldname)) ?? null;
      const rearFile = firstFile(["photoRear", "photoBack", "rear"]);
      const frontFile = firstFile(["photoFront", "front"]);
      const singleFile = firstFile(["photo", "single"]);

      let primaryFile: Express.Multer.File | null = null;
      let secondaryFile: Express.Multer.File | null = null;

      if (captureMode === "double") {
        primaryFile = rearFile;
        secondaryFile = frontFile;
        if (!primaryFile || !secondaryFile) {
          return res.status(400).json({ error: "PHOTO_REQUIRED", message: "Both rear and front photos are required." });
        }
      } else if (captureMode === "front") {
        primaryFile = singleFile ?? frontFile;
      } else if (captureMode === "back") {
        primaryFile = singleFile ?? rearFile;
      } else {
        primaryFile = singleFile ?? frontFile ?? rearFile;
      }

      if (!primaryFile) return res.status(400).json({ error: "PHOTO_REQUIRED" });
      if (!isSupportedImage(primaryFile.buffer)) return res.status(400).json({ error: "INVALID_IMAGE" });
      if (secondaryFile && !isSupportedImage(secondaryFile.buffer)) return res.status(400).json({ error: "INVALID_IMAGE" });

      const createdAt = nowIso();
      const publicId = `${garment.numericId}-${Date.now()}-${safeRandomId("photo", 8)}`;
      const uploadedPhoto = await uploadImageBuffer(primaryFile.buffer, {
        folder: `${config.cloudinaryUploadFolder}/uploads/${garment.numericId}`,
        public_id: publicId
      });
      const uploadedSecondaryPhoto = secondaryFile
        ? await uploadImageBuffer(secondaryFile.buffer, {
            folder: `${config.cloudinaryUploadFolder}/uploads/${garment.numericId}`,
            public_id: `${publicId}-secondary`
          })
        : null;

      const forwarded = req.headers["x-forwarded-for"];
      const uploaderIp = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim() || req.ip || null;
      const geo = lookupGeo(uploaderIp);
      const captureLocale = bodyString(req.body.captureLocale).slice(0, 40) || null;
      const localeCountry = countryFromLocale(captureLocale);
      const resolvedCountry = geo.country ?? localeCountry ?? null;
      const metadata = {
        mimetype: primaryFile.mimetype,
        size: primaryFile.size,
        secondaryMimetype: secondaryFile?.mimetype ?? null,
        secondarySize: secondaryFile?.size ?? null,
        captureSource,
        captureMode,
        captureSide: captureSide || null,
        captureLocale,
        country: resolvedCountry,
        countryCode: geo.countryCode,
        city: geo.city,
        region: geo.region,
        timezone: geo.timezone,
        geoSource: geo.country ? "ip" : localeCountry ? "locale" : null,
        publicFeed: publicFeedUpload,
        publicFeedSource: publicFeedUpload ? "picture-me-sticker" : null,
        email: publicFeedEmail,
        marketingConsent: publicFeedUpload ? marketingConsent : null,
        moderationStatus: publicFeedUpload ? "visible" : null,
        userAgent: req.headers["user-agent"] ?? null
      };

      const photo = await PhotoModel.create({
        garmentId: garment.numericId,
        imagePath: uploadedPhoto.secure_url,
        secondaryImagePath: uploadedSecondaryPhoto?.secure_url ?? null,
        createdAt,
        uploaderIp,
        metadata
      });

      const responsePhoto = photoResponse(photo.toObject() as Photo);
      if (publicFeedUpload && publicFeedEmail) {
        try {
          await sendPublicCaptureEmail({
            recipientEmail: publicFeedEmail,
            photoId: responsePhoto.id,
            primaryImageUrl: responsePhoto.imageUrl,
            secondaryImageUrl: responsePhoto.secondaryImageUrl,
            createdAt
          });
        } catch (error) {
          console.error("[public-feed] sendPublicCaptureEmail failed", error);
        }
      }

      return res.status(201).json({ photo: responsePhoto, publicFeed: publicFeedUpload });
    });

  app.post("/api/client/login", async (req, res) => {
    const parsed = clientLoginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
    const garment = await GarmentModel.findOne({ clientId: parsed.data.clientId }).lean<Garment>();
    if (!garment) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
    const valid = await bcrypt.compare(parsed.data.password, garment.clientPasswordHash);
    if (!valid) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
    return res.json({
      token: signAuth({ role: "client", garmentId: garment.numericId, clientId: garment.clientId }, {}),
      role: "client",
      garment: garmentResponse(garment)
    });
  });

  app.get("/api/client/feed", requireRole("client"), async (req: AuthedRequest, res) => {
    const photos = await PhotoModel.find({ garmentId: req.auth?.garmentId }).sort({ createdAt: -1 }).lean<Photo[]>();
    return res.json({ photos: photos.map(photoResponse) });
  });

  app.get("/api/client/photos/:id", requireRole("client"), async (req: AuthedRequest, res) => {
    const photoId = Number(req.params.id);
    if (!Number.isFinite(photoId)) return res.status(400).json({ error: "INVALID_PHOTO_ID" });
    const photo = await PhotoModel.findOne({ numericId: photoId, garmentId: req.auth?.garmentId }).lean<Photo>();
    if (!photo) return res.status(404).json({ error: "PHOTO_NOT_FOUND" });
    return res.json({ photo: photoResponse(photo) });
  });
}
