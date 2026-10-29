// POST /v1/orders: a connected store tells Refund Relay about an order its own checkout captured.
// Nothing the store sends about money is trusted on its own: the order is looked up in the
// merchant's own PayPal account, and the capture, amount, currency and payee must all agree.
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { audit, now, tx } from "../db.js";
import { hashToken, newToken } from "../auth.js";
import { toCents, toDecimal } from "../money.js";
import { KINDS } from "../kinds.js";
import { normalizeImage } from "../images.js";
import { uploadDir } from "../claims.js";
import { expectedPayee, learnPayee } from "./accounts.js";

export const CLAIM_LINK_DAYS = 14;
const MAX_LINES = 50;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const CATEGORIES = Object.keys(KINDS);

export class RegisterError extends Error {
  constructor(code, message, status = 400, debugId = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.debugId = debugId;
  }
}

// Shape and limits of the request body. Amounts are decimal strings, as in PayPal's own API.
export function checkOrderBody(body) {
  const paypalOrderId = String(body?.paypal_order_id ?? "").trim();
  if (!/^[A-Z0-9]{8,40}$/i.test(paypalOrderId)) throw new RegisterError("INVALID", "paypal_order_id must be the PayPal order ID your checkout captured.");
  const items = body?.items;
  if (!Array.isArray(items) || !items.length || items.length > MAX_LINES) throw new RegisterError("INVALID", `items must list 1 to ${MAX_LINES} products.`);
  const lines = items.map((it, i) => {
    const at = `items[${i}]`;
    const sku = String(it?.sku ?? "").trim(), title = String(it?.title ?? "").trim();
    if (!sku || sku.length > 64) throw new RegisterError("INVALID", `${at}.sku must be 1 to 64 characters.`);
    if (title.length < 2 || title.length > 127) throw new RegisterError("INVALID", `${at}.title must be 2 to 127 characters.`);
    if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 100) throw new RegisterError("INVALID", `${at}.quantity must be a whole number from 1 to 100.`);
    let unitCents;
    try { unitCents = toCents(it.unit_price); } catch { unitCents = 0; }
    if (!(unitCents > 0)) throw new RegisterError("INVALID", `${at}.unit_price must be a USD amount such as "20.00".`);
    if (!CATEGORIES.includes(it.category)) throw new RegisterError("INVALID", `${at}.category must be one of: ${CATEGORIES.join(", ")}.`);
    let url;
    try { url = new URL(String(it.image_url ?? "")); } catch { url = null; }
    if (!url || url.protocol !== "https:") throw new RegisterError("INVALID", `${at}.image_url must be an https link to the product's catalog photo.`);
    return { sku, title, quantity: it.quantity, unitCents, category: it.category, imageUrl: url.href };
  });
  const buyerEmail = body?.buyer_email ? String(body.buyer_email).trim().toLowerCase().slice(0, 254) : null;
  return { paypalOrderId, lines, buyerEmail };
}

// Private, loopback and link-local addresses are never fetched (the URL comes from a merchant).
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:/i];

export async function fetchCatalogImage(href) {
  const url = new URL(href);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => PRIVATE.some((re) => re.test(a.address)))) throw new Error("host not allowed");
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") || 0) > MAX_IMAGE_BYTES) throw new Error("too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("too large");
  return buf;
}

// The catalog photo, stored once per distinct image and served at /assets/m/<sha>.jpg like the
// demo store's own catalog photos.
async function storeCatalogPhoto(buf) {
  // WebP and AVIF are common on store CDNs; Jev and the evidence code take JPEG.
  const jpeg = await sharp(buf, { limitInputPixels: 70_000_000 }).rotate().jpeg({ quality: 90 }).toBuffer();
  const img = await normalizeImage(jpeg);
  const dir = join(uploadDir(), "catalog");
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, `${img.sha256}.jpg`), img.data, { mode: 0o600 });
  return `m/${img.sha256}.jpg`;
}

export const catalogPhotoPath = (file) => join(uploadDir(), "catalog", file);

// client: the merchant's own PayPal client. Returns { order, claimToken, alreadyRegistered }.
export async function registerOrder(db, { merchantId, client, body, fetchImage = fetchCatalogImage }) {
  const { paypalOrderId, lines, buyerEmail } = checkOrderBody(body);
  if (!client) throw new RegisterError("PAYPAL_NOT_CONNECTED", "Connect your PayPal account on the dashboard first.", 409);

  const existing = db.prepare("SELECT * FROM orders WHERE paypal_order_id = ?").get(paypalOrderId);
  if (existing && existing.merchant_id !== merchantId) throw new RegisterError("ORDER_TAKEN", "Another store already registered this PayPal order.", 409);

  let res;
  try {
    res = await client.getOrder(paypalOrderId);
  } catch {
    throw new RegisterError("PAYPAL_UNAVAILABLE", "Could not reach PayPal to check the order. Try again.", 503);
  }
  if (res.status === 404 || res.status === 403) throw new RegisterError("ORDER_NOT_FOUND", "PayPal does not show this order on your connected account.", 404, res.debugId);
  if (res.status !== 200) throw new RegisterError("PAYPAL_UNAVAILABLE", "PayPal did not return the order. Try again.", 502, res.debugId);

  const unit = res.body.purchase_units?.[0] ?? {};
  const cap = unit.payments?.captures?.[0];
  const totalCents = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  const problems = [];
  if (res.body.purchase_units?.length !== 1) problems.push("the order must have exactly one purchase unit");
  if (!cap) problems.push("the order has no capture yet: capture the payment before registering it");
  else {
    if (!["COMPLETED", "PARTIALLY_REFUNDED"].includes(cap.status)) problems.push(`the capture is ${cap.status}`);
    if (cap.amount?.currency_code !== "USD") problems.push(`currency is ${cap.amount?.currency_code}; only USD is supported`);
    else if (toCents(cap.amount.value) !== totalCents) problems.push(`PayPal captured ${cap.amount.value} USD but the items add up to ${toDecimal(totalCents)}`);
  }
  const payee = unit.payee?.merchant_id ?? null;
  const expected = expectedPayee(db, merchantId);
  if (expected && payee !== expected) problems.push("the order was paid to a different PayPal account than the one you connected");
  if (problems.length) throw new RegisterError("ORDER_NOT_VERIFIED", `Refund Relay could not verify this order: ${problems.join("; ")}.`, 422);

  // Registering the same order again (a retried request) returns it with a fresh claim link.
  if (existing && existing.capture_id !== cap.id) throw new RegisterError("ORDER_TAKEN", "This PayPal order was registered with a different capture.", 409);

  let refs;
  if (!existing) {
    try {
      refs = await Promise.all(lines.map(async (l) => storeCatalogPhoto(await fetchImage(l.imageUrl))));
    } catch (err) {
      throw new RegisterError("IMAGE_UNAVAILABLE", `Could not load a catalog photo (${String(err.message).slice(0, 80)}). Each image_url must be a public https JPEG, PNG or WebP of at least 280 px.`, 422);
    }
  }

  const token = newToken();
  const id = existing?.id ?? randomUUID();
  tx(db, () => {
    if (!existing) {
      db.prepare(`INSERT INTO orders (id, merchant_id, paypal_order_id, capture_id, amount_cents, currency, payee_merchant_id, capture_status,
        buyer_email, delivered_at, delivery_source, created_at) VALUES (?, ?, ?, ?, ?, 'USD', ?, 'COMPLETED', ?, ?, ?, ?)`)
        .run(id, merchantId, paypalOrderId, cap.id, totalCents, payee, buyerEmail ?? res.body.payer?.email_address ?? null,
          cap.create_time ?? now(), "capture time (the store sent no delivery date)", now());
      const insert = db.prepare("INSERT INTO order_lines (id, order_id, sku, title, quantity, unit_cents, ref_image, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      lines.forEach((l, i) => insert.run(randomUUID(), id, l.sku, l.title, l.quantity, l.unitCents, refs[i], l.category));
      learnPayee(db, merchantId, payee);
    }
    db.prepare("INSERT OR REPLACE INTO claim_links (order_id, token_hash, expires_at) VALUES (?, ?, ?)")
      .run(id, hashToken(token), new Date(Date.now() + CLAIM_LINK_DAYS * 86400e3).toISOString());
    audit(db, { actor: merchantId, type: existing ? "order.link_reissued" : "order.registered", payload: { orderId: id, paypalOrderId, captureId: cap.id } });
  });
  return { order: db.prepare("SELECT * FROM orders WHERE id = ?").get(id), claimToken: token, alreadyRegistered: !!existing };
}
