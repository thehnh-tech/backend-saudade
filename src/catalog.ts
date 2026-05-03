export type CatalogProduct = {
  id: string;
  title: string;
  unitAmount: number;
  currency: "eur";
};

export const catalogProducts: Record<string, CatalogProduct> = {
  "tee-0024-white-red": {
    id: "tee-0024-white-red",
    title: "SAUDADE Night Access Oversized T-Shirt - White / Red",
    unitAmount: 6900,
    currency: "eur"
  },
  "tee-0024-black-red": {
    id: "tee-0024-black-red",
    title: "SAUDADE Night Access Oversized T-Shirt - Black / Red",
    unitAmount: 6900,
    currency: "eur"
  },
  "tee-0024-black-violet": {
    id: "tee-0024-black-violet",
    title: "SAUDADE Night Access Oversized T-Shirt - Black / Violet",
    unitAmount: 6900,
    currency: "eur"
  },
  "tee-0024-white-blue": {
    id: "tee-0024-white-blue",
    title: "SAUDADE Night Access Oversized T-Shirt - White / Blue",
    unitAmount: 6900,
    currency: "eur"
  }
};

export function getCatalogProduct(productId: string) {
  return catalogProducts[productId];
}
