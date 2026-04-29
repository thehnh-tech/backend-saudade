import express, { type Express } from "express";
import Stripe from "stripe";
import { z } from "zod";
import { requireRole } from "./auth.js";
import { config } from "./config.js";
import { OrderModel, ProductModel, type Product } from "./db.js";
import { stripe } from "./stripe.js";
import { nowIso } from "./utils.js";

const checkoutSchema = z.object({
  productId: z.string().min(1),
  variant: z.string().min(1),
  size: z.string().min(1),
  quantity: z.number().int().min(1).max(10).default(1)
});

function orderResponse(order: {
  numericId: number;
  stripeSessionId: string;
  stripePaymentIntentId: string | null;
  customerEmail: string | null;
  amountTotal: number;
  currency: string;
  status: string;
  lineItems: unknown[];
  qrGarmentIds: number[];
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: order.numericId,
    stripeSessionId: order.stripeSessionId,
    stripePaymentIntentId: order.stripePaymentIntentId,
    customerEmail: order.customerEmail,
    amountTotal: order.amountTotal,
    currency: order.currency,
    status: order.status,
    lineItems: order.lineItems,
    qrGarmentIds: order.qrGarmentIds,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

export function registerStripeWebhook(app: Express) {
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    if (!stripe || !config.stripeWebhookSecret) {
      return res.status(503).json({ error: "STRIPE_NOT_CONFIGURED" });
    }

    const signature = req.headers["stripe-signature"];
    if (!signature) return res.status(400).json({ error: "MISSING_STRIPE_SIGNATURE" });

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid webhook signature";
      return res.status(400).json({ error: "INVALID_WEBHOOK_SIGNATURE", message });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const now = nowIso();
      const orderPayload = {
        stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
        customerEmail: session.customer_details?.email ?? session.customer_email ?? null,
        amountTotal: session.amount_total ?? 0,
        currency: session.currency ?? "eur",
        status: "paid",
        lineItems: [{
          productId: session.metadata?.productId ?? "unknown",
          title: session.metadata?.title ?? "SAUDADE item",
          variant: session.metadata?.variant ?? "unknown",
          size: session.metadata?.size ?? "unknown",
          quantity: Number(session.metadata?.quantity ?? 1),
          unitAmount: Number(session.metadata?.unitAmount ?? 0)
        }],
        updatedAt: now
      };

      const existingOrder = await OrderModel.findOne({ stripeSessionId: session.id });
      if (existingOrder) {
        existingOrder.set(orderPayload);
        await existingOrder.save();
      } else {
        await OrderModel.create({
          stripeSessionId: session.id,
          ...orderPayload,
          createdAt: now,
          qrGarmentIds: []
        });
      }
    }

    return res.json({ received: true });
  });
}

export function registerCheckoutRoutes(app: Express) {
  app.post("/api/checkout/create-session", async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "STRIPE_NOT_CONFIGURED" });

    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });

    const product = await ProductModel.findOne({ productId: parsed.data.productId, status: "available" }).lean<Product>();
    if (!product) return res.status(404).json({ error: "PRODUCT_NOT_FOUND" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        quantity: parsed.data.quantity,
        price_data: {
          currency: product.currency,
          unit_amount: product.unitAmount,
          product_data: {
            name: product.title,
            description: `${parsed.data.variant} - Size ${parsed.data.size}`
          }
        }
      }],
      metadata: {
        productId: product.productId,
        title: product.title,
        variant: parsed.data.variant,
        size: parsed.data.size,
        quantity: String(parsed.data.quantity),
        unitAmount: String(product.unitAmount)
      },
      success_url: `${config.marketplacePublicUrl}/cart?checkout=success`,
      cancel_url: `${config.marketplacePublicUrl}/cart?checkout=cancelled`
    });

    return res.json({ url: session.url, sessionId: session.id });
  });

  app.get("/api/admin/orders", requireRole("admin"), async (_req, res) => {
    const orders = await OrderModel.find().sort({ createdAt: -1 }).limit(100).lean();
    return res.json({ orders: orders.map((order) => orderResponse(order)) });
  });
}
