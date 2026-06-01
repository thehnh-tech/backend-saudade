import { Resend } from "resend";
import { config } from "./config.js";
import type { Order } from "./db.js";

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

function formatAmount(totalCents: number, currency: string) {
  const amount = totalCents / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function escape(value: string) {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char)
  );
}

function renderOrderEmail(order: Order) {
  const orderRef = `SAUDADE-${order.numericId.toString().padStart(4, "0")}`;
  const total = formatAmount(order.amountTotal, order.currency);
  const lineRows = order.lineItems
    .map((item) => `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid #e9e3da;color:#0a0908;">
          <strong style="display:block;font-size:14px;letter-spacing:-0.01em;">${escape(item.title)}</strong>
          <span style="font-size:12px;color:#8a857e;letter-spacing:0.12em;text-transform:uppercase;">${escape(item.variant)} - Size ${escape(item.size)} - x${item.quantity}</span>
        </td>
        <td style="padding:14px 0;border-bottom:1px solid #e9e3da;text-align:right;color:#0a0908;font-weight:600;">
          ${formatAmount(item.unitAmount * item.quantity, order.currency)}
        </td>
      </tr>`)
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escape(orderRef)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:Inter,Helvetica,Arial,sans-serif;color:#0a0908;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1ec;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fbf8f2;border:1px solid rgba(215,25,32,0.18);border-radius:24px;overflow:hidden;">
        <tr><td style="padding:28px 28px 0;">
          <p style="margin:0;font-family:'Courier New',monospace;font-size:11px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#d71920;">SAUDADE 0024 - Night Access</p>
          <h1 style="margin:18px 0 0;font-size:32px;line-height:1;letter-spacing:-0.04em;text-transform:uppercase;font-weight:700;">Order received.</h1>
          <p style="margin:14px 0 0;font-size:15px;line-height:1.6;color:#1f1c1a;">Thanks for joining the drop. Your piece is now logged in the SAUDADE archive.</p>
        </td></tr>
        <tr><td style="padding:24px 28px 0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            ${lineRows}
            <tr>
              <td style="padding:18px 0 4px;font-family:'Courier New',monospace;font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#8a857e;">Total</td>
              <td style="padding:18px 0 4px;text-align:right;font-size:18px;font-weight:700;">${total}</td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:8px 28px 0;">
          <p style="margin:24px 0 0;font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#8a857e;">Order ref - ${escape(orderRef)}</p>
        </td></tr>
        <tr><td style="padding:24px 28px 28px;">
          <div style="background:#0a0908;color:#f4f1ec;border-radius:18px;padding:20px;">
            <p style="margin:0;font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.28em;text-transform:uppercase;color:#d71920;">What's next</p>
            <p style="margin:10px 0 0;font-size:14px;line-height:1.7;color:rgba(244,241,236,0.78);">
              Your tee ships from Switzerland in 3 to 5 business days, then 2 to 12 days transit depending on your country. You will receive tracking when the parcel leaves the warehouse.
            </p>
            <p style="margin:14px 0 0;font-size:14px;line-height:1.7;color:rgba(244,241,236,0.78);">
              Each garment ships with a unique Night Access QR. Anyone who scans it can send a live photo straight into your private SAUDADE feed.
            </p>
          </div>
          <p style="margin:22px 0 0;font-size:12px;line-height:1.6;color:#8a857e;">
            Need help? Reply to this email or write to <a href="mailto:${escape(config.mailReplyTo)}" style="color:#d71920;text-decoration:none;">${escape(config.mailReplyTo)}</a>.
          </p>
          <p style="margin:14px 0 0;font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.28em;text-transform:uppercase;color:#8a857e;">Built by thehnh.tech</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    "SAUDADE 0024 - Night Access",
    `Order received: ${orderRef}`,
    "",
    ...order.lineItems.map((item) => `- ${item.title} (${item.variant}, Size ${item.size}) x${item.quantity} - ${formatAmount(item.unitAmount * item.quantity, order.currency)}`),
    "",
    `Total: ${total}`,
    "",
    "Ships from Switzerland in 3 to 5 business days, then 2 to 12 days transit.",
    "Each garment ships with a unique Night Access QR.",
    "",
    `Questions: ${config.mailReplyTo}`,
    "Built by thehnh.tech"
  ].join("\n");

  return { subject: `${orderRef} - Order received - SAUDADE 0024`, html, text };
}

export async function sendOrderConfirmation(order: Order) {
  if (!resend) {
    console.warn("[mailer] Resend not configured. Skipping confirmation email.");
    return;
  }
  if (!order.customerEmail) {
    console.warn(`[mailer] Order ${order.numericId} has no customer email. Skipping.`);
    return;
  }

  const { subject, html, text } = renderOrderEmail(order);
  const bcc = config.mailAdminBcc ? [config.mailAdminBcc] : undefined;

  const { error } = await resend.emails.send({
    from: config.mailFrom,
    to: order.customerEmail,
    bcc,
    replyTo: config.mailReplyTo,
    subject,
    html,
    text,
    headers: { "X-Entity-Ref-ID": `order-${order.numericId}` }
  });

  if (error) {
    throw new Error(`Resend failed for order ${order.numericId}: ${error.message}`);
  }
}

type PublicCaptureEmail = {
  recipientEmail: string;
  photoId: number;
  primaryImageUrl: string;
  secondaryImageUrl?: string | null;
  createdAt: string;
};

function renderPublicCaptureEmail(capture: PublicCaptureEmail) {
  const photoRef = `PICTURE-ME-${capture.photoId.toString().padStart(4, "0")}`;
  const marketplaceUrl = config.marketplacePublicUrl || "https://saudade.thehnh.tech";
  const secondaryBlock = capture.secondaryImageUrl
    ? `<td style="padding:0 0 0 8px;width:50%;">
        <img src="${escape(capture.secondaryImageUrl)}" alt="Front capture" width="248" style="display:block;width:100%;border-radius:18px;border:1px solid rgba(215,25,32,0.18);" />
        <p style="margin:8px 0 0;font-family:'Courier New',monospace;font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#8a857e;">Front</p>
      </td>`
    : "";
  const primaryWidth = capture.secondaryImageUrl ? "50%" : "100%";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${escape(photoRef)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:Inter,Helvetica,Arial,sans-serif;color:#0a0908;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1ec;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fbf8f2;border:1px solid rgba(215,25,32,0.18);border-radius:24px;overflow:hidden;">
        <tr><td style="padding:28px 28px 0;">
          <p style="margin:0;font-family:'Courier New',monospace;font-size:11px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#d71920;">Picture me by SAUDADE</p>
          <h1 style="margin:18px 0 0;font-size:34px;line-height:1;letter-spacing:0;text-transform:uppercase;font-weight:800;">Your capture is live.</h1>
          <p style="margin:14px 0 0;font-size:15px;line-height:1.6;color:#1f1c1a;">Thanks for scanning the sticker. Your photo copy is below and may appear on the SAUDADE homepage feed after moderation.</p>
        </td></tr>
        <tr><td style="padding:24px 28px 0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td style="padding:0;width:${primaryWidth};">
                <img src="${escape(capture.primaryImageUrl)}" alt="Rear capture" width="520" style="display:block;width:100%;border-radius:18px;border:1px solid rgba(215,25,32,0.18);" />
                <p style="margin:8px 0 0;font-family:'Courier New',monospace;font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#8a857e;">Rear</p>
              </td>
              ${secondaryBlock}
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:26px 28px 0;">
          <a href="${escape(marketplaceUrl)}" style="display:inline-block;border-radius:999px;background:#d71920;color:#fff8f6;padding:14px 22px;font-size:12px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;text-decoration:none;">Open SAUDADE</a>
          <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#8a857e;">You consented to receive this photo copy plus promotional emails and product updates related to Picture me by SAUDADE.</p>
          <p style="margin:14px 0 0;font-family:'Courier New',monospace;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#8a857e;">${escape(photoRef)} - ${escape(capture.createdAt)}</p>
        </td></tr>
        <tr><td style="padding:24px 28px 28px;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#8a857e;">Need help? Reply to this email or write to <a href="mailto:${escape(config.mailReplyTo)}" style="color:#d71920;text-decoration:none;">${escape(config.mailReplyTo)}</a>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    "Picture me by SAUDADE",
    `Your capture is live: ${photoRef}`,
    "",
    `Rear: ${capture.primaryImageUrl}`,
    capture.secondaryImageUrl ? `Front: ${capture.secondaryImageUrl}` : "",
    "",
    `Open SAUDADE: ${marketplaceUrl}`,
    "",
    "You consented to receive this photo copy plus promotional emails and product updates related to Picture me by SAUDADE.",
    `Captured at: ${capture.createdAt}`,
    `Questions: ${config.mailReplyTo}`
  ].filter(Boolean).join("\n");

  return { subject: `${photoRef} - Picture me by SAUDADE`, html, text };
}

export async function sendPublicCaptureEmail(capture: PublicCaptureEmail) {
  if (!resend) {
    console.warn("[mailer] Resend not configured. Skipping public capture email.");
    return;
  }

  const { subject, html, text } = renderPublicCaptureEmail(capture);
  const bcc = config.mailAdminBcc ? [config.mailAdminBcc] : undefined;

  const { error } = await resend.emails.send({
    from: config.mailFrom,
    to: capture.recipientEmail,
    bcc,
    replyTo: config.mailReplyTo,
    subject,
    html,
    text,
    headers: { "X-Entity-Ref-ID": `public-capture-${capture.photoId}` }
  });

  if (error) {
    throw new Error(`Resend failed for public capture ${capture.photoId}: ${error.message}`);
  }
}
