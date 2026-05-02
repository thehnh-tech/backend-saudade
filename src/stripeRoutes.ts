import express, { type Express } from "express";
import { z } from "zod";
import { requireRole } from "./auth.js";
import { config, stripeIsLive } from "./config.js";
import { OrderModel, ProductModel, type Order, type Product } from "./db.js";
import { sendOrderConfirmation } from "./mailer.js";
import { stripe } from "./stripe.js";
import { nowIso } from "./utils.js";

const checkoutSchema = z.object({
  productId: z.string().min(1),
  variant: z.string().min(1),
  size: z.string().min(1),
  quantity: z.number().int().min(1).max(10).default(1),
  customerEmail: z.string().email().optional()
});

function orderResponse(order: Order) {
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

    type StripeEvent = ReturnType<NonNullable<typeof stripe>["webhooks"]["constructEvent"]>;
    let event: StripeEvent;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid webhook signature";
      console.warn(`[stripe] Webhook signature failed: ${message}`);
      return res.status(400).json({ error: "INVALID_WEBHOOK_SIGNATURE", message });
    }

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object as Extract<StripeEvent, { type: "checkout.session.completed" }>["data"]["object"];
      const now = nowIso();
      const orderPayload = {
        stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
        customerEmail: session.customer_details?.email ?? session.customer_email ?? null,
        amountTotal: session.amount_total ?? 0,
        currency: session.currency ?? "eur",
        status: "paid" as const,
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

      let saved: Order | null = null;
      const existing = await OrderModel.findOne({ stripeSessionId: session.id });
      if (existing) {
        const wasPaid = existing.status === "paid";
        existing.set(orderPayload);
        await existing.save();
        if (!wasPaid) saved = existing.toObject() as Order;
      } else {
        const created = await OrderModel.create({
          stripeSessionId: session.id,
          ...orderPayload,
          createdAt: now,
          qrGarmentIds: []
        });
        saved = created.toObject() as Order;
      }

      if (saved) {
        sendOrderConfirmation(saved).catch((err) => console.error("[stripe] sendOrderConfirmation failed", err));
      }
    } else if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object as Extract<StripeEvent, { type: "checkout.session.async_payment_failed" }>["data"]["object"];
      await OrderModel.findOneAndUpdate(
        { stripeSessionId: session.id },
        { status: "failed", updatedAt: nowIso() }
      );
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object as Extract<StripeEvent, { type: "charge.refunded" }>["data"]["object"];
      if (charge.payment_intent) {
        await OrderModel.findOneAndUpdate(
          { stripePaymentIntentId: typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id },
          { status: "refunded", updatedAt: nowIso() }
        );
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
      submit_type: "pay",
      customer_email: parsed.data.customerEmail,
      billing_address_collection: "required",
      shipping_address_collection: {
        allowed_countries: ["CH", "FR", "DE", "BE", "NL", "ES", "IT", "AT", "PT", "LU", "GB", "IE", "DK", "SE", "NO", "FI", "PL", "CZ", "US", "CA", "AU", "JP", "KR", "SG", "AE"]
      },
      phone_number_collection: { enabled: true },
      allow_promotion_codes: true,
      locale: "auto",
      line_items: [{
        quantity: parsed.data.quantity,
        price_data: {
          currency: product.currency,
          unit_amount: product.unitAmount,
          tax_behavior: "inclusive",
          product_data: {
            name: product.title,
            description: `${parsed.data.variant} - Size ${parsed.data.size}`,
            images: product.cardImage.startsWith("http")
              ? [product.cardImage]
              : [`${config.marketplacePublicUrl}${product.cardImage}`],
            metadata: {
              productId: product.productId,
              colorway: product.colorway
            }
          }
        }
      }],
      metadata: {
        productId: product.productId,
        title: product.title,
        variant: parsed.data.variant,
        size: parsed.data.size,
        quantity: String(parsed.data.quantity),
        unitAmount: String(product.unitAmount),
        environment: stripeIsLive ? "live" : "test"
      },
      payment_intent_data: {
        description: `SAUDADE 0024 - ${product.shortTitle} - ${parsed.data.variant} - ${parsed.data.size}`,
        metadata: {
          productId: product.productId,
          variant: parsed.data.variant,
          size: parsed.data.size
        }
      },
      success_url: `${config.marketplacePublicUrl}/cart?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.marketplacePublicUrl}/cart?checkout=cancelled`
    });

    return res.json({ url: session.url, sessionId: session.id, mode: stripeIsLive ? "live" : "test" });
  });

  app.get("/api/checkout/session/:id", async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "STRIPE_NOT_CONFIGURED" });
    try {
      const session = await stripe.checkout.sessions.retrieve(req.params.id);
      return res.json({
        id: session.id,
        status: session.status,
        paymentStatus: session.payment_status,
        customerEmail: session.customer_details?.email ?? null,
        amountTotal: session.amount_total
      });
    } catch {
      return res.status(404).json({ error: "SESSION_NOT_FOUND" });
    }
  });

  app.get("/api/admin/orders", requireRole("admin"), async (_req, res) => {
    const orders = await OrderModel.find().sort({ createdAt: -1 }).limit(200).lean<Order[]>();
    return res.json({ orders: orders.map((order) => orderResponse(order)) });
  });

  app.post("/api/admin/orders/:id/resend-email", requireRole("admin"), async (req, res) => {
    const numericId = Number(req.params.id);
    if (!Number.isFinite(numericId)) return res.status(400).json({ error: "INVALID_ORDER_ID" });
    const order = await OrderModel.findOne({ numericId }).lean<Order>();
    if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
    await sendOrderConfirmation(order);
    return res.json({ ok: true });
  });
}
