// POST /v1/orders: a connected store tells Refund Relay about an order its own checkout captured.
// Nothing the store sends about money is trusted on its own: the order is looked up in the
// merchant's own PayPal account, and the capture, amount, currency and payee must all agree.
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
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
import { DEMO, expectedPayee, learnPayee, payeeOwner } from "./accounts.js";

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
  // Shipping and tax the checkout charged on top of the items: part of what PayPal captured, so part
  // of what can be refunded, but never part of an item's worth under the refund policy.
  const extra = (field) => {
    if (body?.[field] == null || body[field] === "") return 0;
    try { return toCents(body[field]); } catch { throw new RegisterError("INVALID", `${field} must be a USD amount such as "4.95", or left out.`); }
  };
  const shippingCents = extra("shipping"), taxCents = extra("tax");
  const buyerEmail = body?.buyer_email ? String(body.buyer_email).trim().toLowerCase().slice(0, 254) : null;
  return { paypalOrderId, lines, shippingCents, taxCents, buyerEmail };
}

// Private, loopback, link-local and other non-public addresses are never fetched (the URL comes
// from a merchant). The check runs inside the connection's own DNS lookup, so the address checked
// is the address connected to: a host cannot pass the check and then resolve somewhere private.
// Two lists: a BlockList also matches IPv4 addresses against IPv6 rules (as ::a.b.c.d).
const BLOCKED_V4 = new BlockList(), BLOCKED_V6 = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) BLOCKED_V4.addSubnet(net, bits, "ipv4");
// ::/96 also covers :: and ::1; ::ffff:0:0/96 is IPv4-mapped, 64:ff9b::/96 NAT64.
for (const [net, bits] of [["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) {
  BLOCKED_V6.addSubnet(net, bits, "ipv6");
}
export const publicAddress = (address) => {
  const v = isIP(address);
  return v === 4 ? !BLOCKED_V4.check(address, "ipv4") : v === 6 && !BLOCKED_V6.check(address, "ipv6");
};
const notAllowed = () => Object.assign(new Error("host not allowed"), { code: "EHOSTBLOCKED" });

function publicLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs.length || !addrs.every((a) => publicAddress(a.address))) return callback(notAllowed());
    if (options.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
}

export function fetchCatalogImage(href) {
  const url = new URL(href);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || (isIP(host) && !publicAddress(host))) return Promise.reject(notAllowed());
  return new Promise((resolve, reject) => {
    // Redirects are not followed (any answer but 200 fails), as with fetch's redirect: "error".
    const req = httpsRequest(url, { lookup: publicLookup, headers: { Accept: "image/*" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      if (Number(res.headers["content-length"] || 0) > MAX_IMAGE_BYTES) { res.destroy(); return reject(new Error("too large")); }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_IMAGE_BYTES) { res.destroy(); reject(new Error("too large")); } else chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new Error("timed out")), 10_000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
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
  const { paypalOrderId, lines, shippingCents, taxCents, buyerEmail } = checkOrderBody(body);
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
  const itemsCents = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  const totalCents = itemsCents + shippingCents + taxCents;
  const problems = [];
  if (res.body.purchase_units?.length !== 1) problems.push("the order must have exactly one purchase unit");
  if (!cap) problems.push("the order has no capture yet: capture the payment before registering it");
  else {
    const refunded = (unit.payments?.refunds ?? []).some((r) => !["FAILED", "CANCELLED"].includes(r.status));
    if (!["COMPLETED", "PARTIALLY_REFUNDED"].includes(cap.status)) problems.push(`the capture is ${cap.status}`);
    // A refund made before Refund Relay knew the order would block every refund here (the ledger
    // check stops at refunds it did not make), so a new order must arrive unrefunded.
    else if (!existing && (cap.status !== "COMPLETED" || refunded)) problems.push("the payment was already partly refunded in PayPal");
    if (cap.amount?.currency_code !== "USD") problems.push(`currency is ${cap.amount?.currency_code}; only USD is supported`);
    else if (toCents(cap.amount.value) !== totalCents) problems.push(`PayPal captured ${cap.amount.value} USD but the items${shippingCents || taxCents
      ? ` (${toDecimal(itemsCents)}) plus shipping (${toDecimal(shippingCents)}) and tax (${toDecimal(taxCents)})` : ""} add up to ${toDecimal(totalCents)}`);
  }
  const payee = unit.payee?.merchant_id ?? null;
  const expected = expectedPayee(db, merchantId);
  if (expected && payee !== expected) problems.push("the order was paid to a different PayPal account than the one you connected");
  else if (payee && merchantId !== DEMO && payeeOwner(db, payee, merchantId)) problems.push("the order was paid to a PayPal account another Refund Relay store has connected");
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
  const { id, again } = tx(db, () => {
    // Read again inside the transaction: a retry of the same request may have stored the order
    // while this one waited on PayPal and the photo fetch.
    const prior = db.prepare("SELECT * FROM orders WHERE paypal_order_id = ?").get(paypalOrderId);
    if (prior && prior.merchant_id !== merchantId) throw new RegisterError("ORDER_TAKEN", "Another store already registered this PayPal order.", 409);
    if (prior && prior.capture_id !== cap.id) throw new RegisterError("ORDER_TAKEN", "This PayPal order was registered with a different capture.", 409);
    // And the payee: another store's first order may have claimed this PayPal account meanwhile.
    if (!prior && payee && merchantId !== DEMO && payeeOwner(db, payee, merchantId)) {
      throw new RegisterError("ORDER_NOT_VERIFIED", "Refund Relay could not verify this order: the order was paid to a PayPal account another Refund Relay store has connected.", 422);
    }
    const id = prior?.id ?? randomUUID();
    if (!prior) {
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
    audit(db, { actor: merchantId, type: prior ? "order.link_reissued" : "order.registered", payload: { orderId: id, paypalOrderId, captureId: cap.id } });
    return { id, again: !!prior };
  });
  return { order: db.prepare("SELECT * FROM orders WHERE id = ?").get(id), claimToken: token, alreadyRegistered: again };
}
