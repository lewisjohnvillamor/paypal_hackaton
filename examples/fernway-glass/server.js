// Fernway Glass: a second sample store, built only from the four steps on the Refund Relay
// dashboard (/dashboard). It has its own PayPal app, sells through the PayPal button on its own
// page, and after each capture makes the documented POST /v1/orders call, then shows the buyer
// the relay.js button on its confirmation page.
//
//   REFUND_RELAY_URL=https://refund-relay.onrender.com REFUND_RELAY_KEY=rr_sk_test_... \
//   FERNWAY_PAYPAL_CLIENT_ID=... FERNWAY_PAYPAL_CLIENT_SECRET=... node examples/fernway-glass/server.js
//
// Dashboard step 1 is the PayPal app above (paste the same Client ID and Secret there), step 2 is
// REFUND_RELAY_KEY, step 3 is registerWithRefundRelay() below, step 4 is the confirmation page.
import express from "express";
import { readFileSync } from "node:fs";

const RELAY = (process.env.REFUND_RELAY_URL || "https://refund-relay.onrender.com").replace(/\/+$/, "");
const PAYPAL = "https://api-m.sandbox.paypal.com";
const CLIENT_ID = process.env.FERNWAY_PAYPAL_CLIENT_ID, CLIENT_SECRET = process.env.FERNWAY_PAYPAL_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET || !process.env.REFUND_RELAY_KEY) {
  console.error("Set FERNWAY_PAYPAL_CLIENT_ID, FERNWAY_PAYPAL_CLIENT_SECRET and REFUND_RELAY_KEY.");
  process.exit(1);
}

// The catalog, priced on the server. Prices are in cents so the totals add up exactly.
const PRODUCT = {
  sku: "FW-BUD-CLR", title: "Clear glass bud vase", unitCents: 3800, category: "glass-vase",
  image_url: process.env.FERNWAY_IMAGE_URL || "https://raw.githubusercontent.com/lewisjohnvillamor/paypal_hackaton/main/public/assets/catalog-vase.jpg",
};
const SHIPPING_CENTS = 650;       // flat rate per order
const TAX_RATE = 0.08;            // on the items, rounded to the cent
const usd = (c) => (c / 100).toFixed(2);
const totals = (quantity) => {
  const items = PRODUCT.unitCents * quantity, tax = Math.round(items * TAX_RATE);
  return { items, shipping: SHIPPING_CENTS, tax, total: items + SHIPPING_CENTS + tax };
};

async function paypal(method, path, body) {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const tok = await (await fetch(`${PAYPAL}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${auth}` }, body: new URLSearchParams({ grant_type: "client_credentials" }) })).json();
  const res = await fetch(PAYPAL + path, { method, headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

// Dashboard step 3, as written there: right after the capture, send the order and its items.
async function registerWithRefundRelay(order, quantity) {
  const t = totals(quantity);
  const res = await fetch(`${RELAY}/v1/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.REFUND_RELAY_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      paypal_order_id: order.id,
      items: [{
        sku: PRODUCT.sku,
        title: PRODUCT.title,
        quantity,
        unit_price: usd(PRODUCT.unitCents),
        category: PRODUCT.category,
        image_url: PRODUCT.image_url,
      }],
      shipping: usd(t.shipping),
      tax: usd(t.tax),
    }),
  });
  if (!res.ok) throw new Error((await res.json()).message);
  const { claim_url } = await res.json();
  return claim_url;
}

const orders = new Map(); // PayPal order ID -> { quantity, claimUrl }
const app = express();
app.use(express.json());

const store = readFileSync(new URL("./store.html", import.meta.url), "utf8")
  .replaceAll("{{CLIENT_ID}}", encodeURIComponent(CLIENT_ID))
  .replaceAll("{{PRICE}}", usd(PRODUCT.unitCents))
  .replaceAll("{{SHIPPING}}", usd(SHIPPING_CENTS))
  .replaceAll("{{IMAGE}}", PRODUCT.image_url);
app.get("/", (_req, res) => res.type("html").send(store));

// The store's own checkout: a PayPal order with an itemised breakdown, created on the server.
app.post("/api/orders", async (req, res) => {
  const quantity = Math.min(Math.max(Number.parseInt(req.body?.quantity, 10) || 1, 1), 5);
  const t = totals(quantity);
  const { status, body } = await paypal("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      description: "Fernway Glass",
      amount: { currency_code: "USD", value: usd(t.total), breakdown: {
        item_total: { currency_code: "USD", value: usd(t.items) },
        shipping: { currency_code: "USD", value: usd(t.shipping) },
        tax_total: { currency_code: "USD", value: usd(t.tax) },
      } },
      items: [{ name: PRODUCT.title, sku: PRODUCT.sku, quantity: String(quantity), unit_amount: { currency_code: "USD", value: usd(PRODUCT.unitCents) } }],
    }],
    // Only used when a script opens the approve link directly instead of the PayPal button.
    application_context: { return_url: `${req.protocol}://${req.get("host")}/return`, cancel_url: `${req.protocol}://${req.get("host")}/` },
  });
  if (status !== 201) return res.status(502).json({ message: "PayPal did not create the order.", paypal: body });
  orders.set(body.id, { quantity });
  res.json({ id: body.id, approveUrl: body.links.find((l) => l.rel === "approve")?.href });
});

app.post("/api/orders/:id/capture", async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ message: "Unknown order." });
  if (!o.claimUrl) {
    const cap = await paypal("POST", `/v2/checkout/orders/${req.params.id}/capture`);
    // A retried capture of an order PayPal already captured is fine; anything else is not.
    const already = cap.body?.details?.[0]?.issue === "ORDER_ALREADY_CAPTURED";
    if (cap.body.status !== "COMPLETED" && !already) return res.status(502).json({ message: "PayPal did not capture the payment.", paypal: cap.body });
    try {
      o.claimUrl = await registerWithRefundRelay({ id: req.params.id }, o.quantity);
    } catch (err) {
      // The payment went through; only the damage-report link is missing. Say so, do not fail the sale.
      console.error("[fernway] Refund Relay refused the order:", err.message);
      o.relayError = err.message;
    }
  }
  res.json({ confirmation: `/orders/${req.params.id}` });
});

// Dashboard step 4: the confirmation page shows the button.
app.get("/orders/:id", (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).type("html").send("<!doctype html><title>Not found</title><p>No such order.</p>");
  const t = totals(o.quantity);
  const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const button = o.claimUrl
    ? `<script src="${RELAY}/relay.js" defer></script>
      <div data-refund-relay data-claim-url="${attr(o.claimUrl)}"></div>`
    : `<p class="muted">Damage reports are unavailable for this order right now. Reply to your receipt email and we will help.</p>`;
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Order confirmed · Fernway Glass</title><link rel="stylesheet" href="/store.css"></head><body>
<header class="bar"><a class="logo" href="/">Fernway Glass</a></header>
<main class="confirm">
  <h1>Thank you. Your order is in.</h1>
  <p>${o.quantity} × ${PRODUCT.title}, paid with PayPal. It ships from our studio in two days.</p>
  <dl class="sum">
    <dt>Items</dt><dd>$${usd(t.items)}</dd><dt>Shipping</dt><dd>$${usd(t.shipping)}</dd><dt>Tax</dt><dd>$${usd(t.tax)}</dd>
    <dt>Paid</dt><dd><b>$${usd(t.total)}</b></dd>
  </dl>
  <p class="muted">PayPal order ${req.params.id}</p>
  <h2>Did something arrive broken?</h2>
  <p>Glass travels badly now and then. Show us a photo and we will put it right.</p>
  ${button}
</main></body></html>`);
});

app.get("/store.css", (_req, res) => res.type("css").send(readFileSync(new URL("./store.css", import.meta.url))));
app.get("/return", (_req, res) => res.type("html").send("<!doctype html><title>Returning</title><p>Payment approved. You can close this tab.</p>"));

const port = Number(process.env.FERNWAY_PORT || 8898);
app.listen(port, () => console.log(`Fernway Glass on http://localhost:${port}, using Refund Relay at ${RELAY}`));
