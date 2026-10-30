// Demo purchase: server-priced PayPal order, server-side capture, verified and persisted.
import { randomUUID } from "node:crypto";
import { audit, now, tx } from "./db.js";
import { DEMO_CART, PRODUCTS } from "./catalog.js";
import { toCents, toDecimal } from "./money.js";
import { hashToken, newToken } from "./auth.js";

const CLAIM_LINK_DAYS = 14;

export class OrderError extends Error {
  constructor(code, message, status = 502, debugId = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.debugId = debugId;
  }
}

// The buyer's cart: known SKUs and whole quantities only. Prices always come from the catalog.
export const MAX_PER_LINE = 10;
export function cartLines(items) {
  const cart = Array.isArray(items) && items.length ? items : DEMO_CART;
  const qty = new Map();
  for (const { sku, quantity } of cart) {
    if (!PRODUCTS[sku]) throw new OrderError("INVALID_CART", "That product isn't in the store.", 400);
    if (!Number.isInteger(quantity) || quantity < 0) throw new OrderError("INVALID_CART", "Quantities must be whole numbers.", 400);
    qty.set(sku, (qty.get(sku) ?? 0) + quantity);
  }
  const lines = [...qty].filter(([, q]) => q > 0).map(([sku, quantity]) => ({ ...PRODUCTS[sku], quantity }));
  if (!lines.length) throw new OrderError("INVALID_CART", "Your bag is empty.", 400);
  if (lines.some((l) => l.quantity > MAX_PER_LINE)) throw new OrderError("INVALID_CART", `Up to ${MAX_PER_LINE} of each item.`, 400);
  return lines;
}

export async function startOrder(db, paypal, items) {
  const lines = cartLines(items);
  const totalCents = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  const id = randomUUID();
  const res = await paypal.createOrder({
    customId: id,
    totalValue: toDecimal(totalCents),
    lines: lines.map((l) => ({ sku: l.sku, title: l.title, quantity: l.quantity, unitValue: toDecimal(l.unitCents) })),
  });
  if (res.status !== 201) throw new OrderError("PAYPAL_ORDER_FAILED", "PayPal did not create the order.", 502, res.debugId);

  tx(db, () => {
    db.prepare(`INSERT INTO orders (id, paypal_order_id, amount_cents, currency, capture_status, created_at)
      VALUES (?, ?, ?, 'USD', 'CREATED', ?)`).run(id, res.body.id, totalCents, now());
    for (const l of lines) {
      db.prepare("INSERT INTO order_lines (id, order_id, sku, title, quantity, unit_cents, ref_image) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), id, l.sku, l.title, l.quantity, l.unitCents, l.refImage);
    }
  });
  return { id, paypalOrderId: res.body.id, approveUrl: res.body.links?.find((l) => l.rel === "approve")?.href };
}

export async function captureOrder(db, paypal, paypalOrderId) {
  const order = db.prepare("SELECT * FROM orders WHERE paypal_order_id = ?").get(paypalOrderId);
  if (!order) throw new OrderError("NOT_FOUND", "Unknown order.", 404);
  if (order.capture_status === "COMPLETED") return { order, claimToken: null, alreadyCaptured: true };

  // Request ID tied to the order so a retried capture cannot capture twice.
  const res = await paypal.captureOrder(paypalOrderId, `capture-${order.id}`);
  const cap = res.body?.purchase_units?.[0]?.payments?.captures?.[0];
  if (res.status >= 300 || !cap) throw new OrderError("PAYPAL_CAPTURE_FAILED", "PayPal did not capture the payment.", 502, res.debugId);

  // Verify what PayPal says actually happened before we trust it.
  const problems = [];
  if (cap.status !== "COMPLETED") problems.push(`capture status ${cap.status}`);
  if (cap.amount?.currency_code !== "USD") problems.push(`currency ${cap.amount?.currency_code}`);
  if (toCents(cap.amount?.value ?? "0") !== order.amount_cents) problems.push(`amount ${cap.amount?.value}`);
  const payee = res.body.purchase_units[0].payee?.merchant_id ?? null;
  const expectedPayee = process.env.PAYPAL_MERCHANT_ID;
  if (expectedPayee && payee !== expectedPayee) problems.push("payee does not match configured merchant");

  const token = newToken();
  const ts = now();
  // Two capture calls for one order (a retried approval, a second tab) both get PayPal's same
  // answer; only the first stores a claim link, so the link it handed out keeps working.
  const raced = tx(db, () => {
    if (db.prepare("SELECT capture_status FROM orders WHERE id = ?").get(order.id).capture_status === "COMPLETED") return true;
    db.prepare(`UPDATE orders SET capture_id = ?, capture_status = ?, payee_merchant_id = ?, buyer_email = ?,
      delivered_at = ?, delivery_source = 'synthetic demo fixture (delivered at capture time)' WHERE id = ?`)
      .run(cap.id, problems.length ? `MISMATCH: ${problems.join("; ")}` : "COMPLETED", payee,
        res.body.payer?.email_address ?? null, ts, order.id);
    if (!problems.length) {
      db.prepare("INSERT OR REPLACE INTO claim_links (order_id, token_hash, expires_at) VALUES (?, ?, ?)")
        .run(order.id, hashToken(token), new Date(Date.now() + CLAIM_LINK_DAYS * 86400e3).toISOString());
    }
    audit(db, { actor: "buyer", type: "order.captured", payload: { orderId: order.id, captureId: cap.id, problems } });
    return false;
  });
  if (raced) return { order: db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id), claimToken: null, alreadyCaptured: true };
  if (problems.length) throw new OrderError("CAPTURE_NOT_VERIFIED", `Capture failed verification: ${problems.join("; ")}`, 502);
  return { order: db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id), claimToken: token, alreadyCaptured: false };
}
