import Stripe from "stripe";
import { config } from "./config.js";

export const stripe = config.stripeSecretKey
  ? new Stripe(config.stripeSecretKey, {
      maxNetworkRetries: 2,
      timeout: 20000,
      appInfo: { name: "saudade-marketplace", version: "0.1.0", url: "https://saudade.thehnh.tech" }
    })
  : null;
