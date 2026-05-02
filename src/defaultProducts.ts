import type { Product } from "./db.js";
import { nowIso } from "./utils.js";

type SeedProduct = Omit<Product, "createdAt" | "updatedAt">;

const baseProduct = {
  productId: "tee-0024-white-red",
  slug: "night-access-oversized-tee",
  title: "SAUDADE Night Access Oversized T-Shirt - White / Red",
  shortTitle: "Night Access Tee",
  price: 69,
  unitAmount: 6900,
  currency: "eur",
  collection: "SAUDADE 0024 - Night Access",
  category: "T-shirts",
  colorway: "White / Red",
  status: "available",
  description: "A heavy oversized tee made for late nights, blurry memories, and people who do not want the same uniform as everyone else.",
  vibe: "White cotton. Red signal. Scan-ready energy.",
  cardImage: "/assets/tee-white-red-card.png",
  details: [
    "Oversized boxy fit with dropped shoulders",
    "260 GSM heavyweight cotton",
    "White textile with deep red print",
    "Large back QR artwork",
    "Small front print",
    "Inner neck and outer neck markings",
    "Limited SAUDADE 0024 release"
  ],
  tags: [
    "saudade",
    "streetwear",
    "oversized t-shirt",
    "graphic tee",
    "luxury streetwear",
    "underground fashion",
    "nightlife",
    "clubwear",
    "rave fashion",
    "gothic streetwear",
    "QR code t-shirt",
    "premium cotton",
    "boxy fit",
    "limited edition",
    "techno fashion"
  ],
  images: [
    { label: "Product card", src: "/assets/tee-white-red-card.png", kind: "card" },
    { label: "Front print", src: "/assets/front.png", kind: "front" },
    { label: "Inner neck", src: "/assets/inner.png", kind: "detail" },
    { label: "Outer neck", src: "/assets/outer.png", kind: "detail" },
    { label: "Front artwork", src: "/assets/bgfront.png", kind: "detail" }
  ],
  variants: [
    { name: "White / Red", textile: "#F4F1EC", print: "#D71920", accent: "#D71920" },
    { name: "Black / Red", textile: "#0A0908", print: "#D71920", accent: "#D71920" },
    { name: "Black / Violet", textile: "#0A0908", print: "#8C5BFF", accent: "#8C5BFF" },
    { name: "White / Blue", textile: "#F4F1EC", print: "#156BFF", accent: "#156BFF" }
  ],
  sizes: ["XS", "S", "M", "L", "XL", "XXL"]
} satisfies SeedProduct;

const seedProducts: SeedProduct[] = [
  baseProduct,
  {
    ...baseProduct,
    productId: "tee-0024-black-red",
    slug: "night-access-tee-black-red",
    title: "SAUDADE Night Access Oversized T-Shirt - Black / Red",
    colorway: "Black / Red",
    vibe: "Black base. Red print. Club shadow version.",
    cardImage: "/assets/tee-black-red-card.png",
    images: [{ label: "Product card", src: "/assets/tee-black-red-card.png", kind: "card" }, ...baseProduct.images.slice(1)],
    status: "coming-soon"
  },
  {
    ...baseProduct,
    productId: "tee-0024-black-violet",
    slug: "night-access-tee-black-violet",
    title: "SAUDADE Night Access Oversized T-Shirt - Black / Violet",
    colorway: "Black / Violet",
    vibe: "Black base. Violet scan glow. After-hours version.",
    cardImage: "/assets/tee-black-violet-card.png",
    images: [{ label: "Product card", src: "/assets/tee-black-violet-card.png", kind: "card" }, ...baseProduct.images.slice(1)],
    status: "coming-soon"
  },
  {
    ...baseProduct,
    productId: "tee-0024-white-blue",
    slug: "night-access-tee-white-blue",
    title: "SAUDADE Night Access Oversized T-Shirt - White / Blue",
    colorway: "White / Blue",
    vibe: "White base. Ice blue code. Cleaner, colder, still private.",
    cardImage: "/assets/tee-white-blue-card.png",
    images: [{ label: "Product card", src: "/assets/tee-white-blue-card.png", kind: "card" }, ...baseProduct.images.slice(1)],
    status: "coming-soon"
  }
];

export const defaultProducts: Product[] = seedProducts.map((product) => {
  const now = nowIso();
  return { ...product, createdAt: now, updatedAt: now };
});
