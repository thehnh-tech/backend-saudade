import mongoose, { Schema } from "mongoose";
import { config } from "./config.js";
import { defaultProducts } from "./defaultProducts.js";

const counterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, required: true, default: 0 }
});

const garmentSchema = new Schema({
  numericId: { type: Number, required: true, unique: true, index: true },
  type: { type: String, required: true, trim: true },
  publicToken: { type: String, required: true, unique: true, index: true },
  clientId: { type: String, required: true, unique: true, index: true },
  clientPasswordHash: { type: String, required: true },
  clientPasswordPlain: { type: String, default: null },
  qrCodePath: { type: String, required: true },
  createdAt: { type: String, required: true }
});

const photoSchema = new Schema({
  numericId: { type: Number, required: true, unique: true, index: true },
  garmentId: { type: Number, required: true, index: true },
  imagePath: { type: String, required: true },
  createdAt: { type: String, required: true, index: true },
  uploaderIp: { type: String, default: null },
  metadata: { type: Schema.Types.Mixed, default: null }
});

const orderLineItemSchema = new Schema({
  productId: { type: String, required: true },
  title: { type: String, required: true },
  variant: { type: String, required: true },
  size: { type: String, required: true },
  quantity: { type: Number, required: true },
  unitAmount: { type: Number, required: true }
}, { _id: false });

const orderSchema = new Schema({
  numericId: { type: Number, required: true, unique: true, index: true },
  stripeSessionId: { type: String, required: true, unique: true, index: true },
  stripePaymentIntentId: { type: String, default: null },
  customerEmail: { type: String, default: null },
  amountTotal: { type: Number, required: true },
  currency: { type: String, required: true, default: "eur" },
  status: { type: String, required: true, default: "pending" },
  lineItems: { type: [orderLineItemSchema], required: true },
  qrGarmentIds: { type: [Number], default: [] },
  createdAt: { type: String, required: true },
  updatedAt: { type: String, required: true }
});

const productImageSchema = new Schema({
  label: { type: String, required: true },
  src: { type: String, required: true },
  kind: { type: String, required: true }
}, { _id: false });

const productVariantSchema = new Schema({
  name: { type: String, required: true },
  textile: { type: String, required: true },
  print: { type: String, required: true },
  accent: { type: String, required: true }
}, { _id: false });

const productSchema = new Schema({
  productId: { type: String, required: true, unique: true, index: true },
  slug: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  shortTitle: { type: String, required: true },
  price: { type: Number, required: true },
  unitAmount: { type: Number, required: true },
  currency: { type: String, required: true, default: "eur" },
  collection: { type: String, required: true },
  category: { type: String, required: true },
  tags: { type: [String], default: [] },
  colorway: { type: String, required: true },
  description: { type: String, required: true },
  vibe: { type: String, required: true },
  cardImage: { type: String, required: true },
  details: { type: [String], default: [] },
  images: { type: [productImageSchema], default: [] },
  variants: { type: [productVariantSchema], default: [] },
  sizes: { type: [String], default: ["XS", "S", "M", "L", "XL", "XXL"] },
  status: { type: String, required: true, default: "draft" },
  createdAt: { type: String, required: true },
  updatedAt: { type: String, required: true }
}, { suppressReservedKeysWarning: true });

type Counter = {
  _id: string;
  seq: number;
};

export type Garment = {
  numericId: number;
  type: string;
  publicToken: string;
  clientId: string;
  clientPasswordHash: string;
  clientPasswordPlain: string | null;
  qrCodePath: string;
  createdAt: string;
};

export type Photo = {
  numericId: number;
  garmentId: number;
  imagePath: string;
  createdAt: string;
  uploaderIp: string | null;
  metadata: Record<string, unknown> | null;
};

export type OrderLineItem = {
  productId: string;
  title: string;
  variant: string;
  size: string;
  quantity: number;
  unitAmount: number;
};

export type Order = {
  numericId: number;
  stripeSessionId: string;
  stripePaymentIntentId: string | null;
  customerEmail: string | null;
  amountTotal: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded" | "fulfilled";
  lineItems: OrderLineItem[];
  qrGarmentIds: number[];
  createdAt: string;
  updatedAt: string;
};

export type Product = {
  productId: string;
  slug: string;
  title: string;
  shortTitle: string;
  price: number;
  unitAmount: number;
  currency: "eur";
  collection: string;
  category: string;
  tags: string[];
  colorway: string;
  description: string;
  vibe: string;
  cardImage: string;
  details: string[];
  images: Array<{ label: string; src: string; kind: "front" | "back" | "detail" | "card" }>;
  variants: Array<{ name: string; textile: string; print: string; accent: string }>;
  sizes: string[];
  status: "available" | "coming-soon" | "draft";
  createdAt: string;
  updatedAt: string;
};

async function nextSeq(name: "garments" | "photos" | "orders") {
  const counter = await CounterModel.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true }
  ).lean();
  return counter.seq;
}

garmentSchema.pre("validate", async function assignGarmentId() {
  if (!this.numericId) this.numericId = await nextSeq("garments");
});

photoSchema.pre("validate", async function assignPhotoId() {
  if (!this.numericId) this.numericId = await nextSeq("photos");
});

orderSchema.pre("validate", async function assignOrderId() {
  if (!this.numericId) this.numericId = await nextSeq("orders");
});

const CounterModel = mongoose.model<Counter>("Counter", counterSchema);
export const GarmentModel = mongoose.model<Garment>("Garment", garmentSchema);
export const PhotoModel = mongoose.model<Photo>("Photo", photoSchema);
export const OrderModel = mongoose.model<Order>("Order", orderSchema);
export const ProductModel = mongoose.model<Product>("Product", productSchema);

export async function connectDb() {
  await mongoose.connect(config.mongoUri);
  await Promise.all([
    GarmentModel.syncIndexes(),
    PhotoModel.syncIndexes(),
    OrderModel.syncIndexes(),
    ProductModel.syncIndexes()
  ]);
  if (await ProductModel.countDocuments() === 0) {
    await ProductModel.insertMany(defaultProducts);
  }
}
