// A second store, with its own PayPal app and its own checkout, that uses Refund Relay as a
// service: after each capture it sends the order to POST /v1/orders and shows the buyer the
// relay.js button on its confirmation page. About 60 lines is the whole integration.
//
//   REFUND_RELAY_URL=http://localhost:8888 REFUND_RELAY_KEY=rr_sk_test_... \
//   ACME_PAYPAL_CLIENT_ID=... ACME_PAYPAL_CLIENT_SECRET=... node examples/acme-store/server.js
import express from "express";

const RELAY = (process.env.REFUND_RELAY_URL || "http://localhost:8888").replace(/\/+$/, "");
const PAYPAL = "https://api-m.sandbox.paypal.com";
const PRODUCT = {
  sku: "ACME-MUG-W", title: "Everyday white mug", unit_price: "24.00", category: "ceramic-mug",
  image_url: process.env.ACME_IMAGE_URL || "https://raw.githubusercontent.com/lewisjohnvillamor/paypal_hackaton/main/public/assets/catalog-mug.jpg",
};
const SHIPPING = "4.95"; // flat rate per order, captured with the items and sent to Refund Relay too

async function paypal(method, path, body) {
  const auth = Buffer.from(`${process.env.ACME_PAYPAL_CLIENT_ID}:${process.env.ACME_PAYPAL_CLIENT_SECRET}`).toString("base64");
  const { access_token } = await (await fetch(`${PAYPAL}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${auth}` }, body: new URLSearchParams({ grant_type: "client_credentials" }) })).json();
  const res = await fetch(PAYPAL + path, { method, headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  return res.json();
}

const orders = new Map(); // PayPal order ID -> { quantity, claimUrl }
const app = express();
app.use(express.json());
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 Georgia,serif;max-width:560px;margin:48px auto;padding:0 20px;color:#2b2118;background:#fbf7f1}h1{font-weight:400}img{width:100%;border-radius:8px}</style>
<p style="letter-spacing:.2em;text-transform:uppercase;font-size:12px">Acme Ceramics</p>${body}`;

app.get("/", (_req, res) => res.send(page("Acme Ceramics", `<h1>${PRODUCT.title}</h1><img src="${PRODUCT.image_url}" alt=""><p>$${PRODUCT.unit_price}</p>`)));

// Checkout: the store's own PayPal order, priced on its own server.
app.post("/api/checkout", async (req, res) => {
  const quantity = Math.min(Math.max(Number(req.body?.quantity) || 1, 1), 10);
  const value = (Number(PRODUCT.unit_price) * quantity + Number(SHIPPING)).toFixed(2);
  const order = await paypal("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value } }] });
  orders.set(order.id, { quantity });
  res.json({ id: order.id, approveUrl: order.links.find((l) => l.rel === "approve").href });
});

app.post("/api/checkout/:id/capture", async (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: "unknown order" });
  const cap = await paypal("POST", `/v2/checkout/orders/${req.params.id}/capture`);
  if (cap.status !== "COMPLETED") return res.status(502).json(cap);
  // The Refund Relay integration: one call after the capture.
  const r = await fetch(`${RELAY}/v1/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.REFUND_RELAY_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ paypal_order_id: req.params.id, items: [{ ...PRODUCT, quantity: o.quantity }], shipping: SHIPPING }),
  });
  const registered = await r.json();
  if (!r.ok) return res.status(502).json(registered);
  o.claimUrl = registered.claim_url;
  res.json({ confirmation: `/orders/${req.params.id}` });
});

// The confirmation page, with the Report a problem button.
app.get("/orders/:id", (req, res) => {
  const o = orders.get(req.params.id);
  if (!o?.claimUrl) return res.status(404).send(page("Not found", "<h1>No such order</h1>"));
  res.send(page("Thank you", `<h1>Thank you for your order</h1><p>${o.quantity} × ${PRODUCT.title}, paid with PayPal. Shipping $${SHIPPING}. It ships tomorrow.</p>
<p>If anything arrives broken, tell us here:</p>
<script src="${RELAY}/relay.js" defer></script>
<div data-refund-relay data-claim-url="${o.claimUrl.replace(/"/g, "&quot;")}"></div>`));
});

const port = Number(process.env.ACME_PORT || 8899);
app.listen(port, () => console.log(`Acme Ceramics on http://localhost:${port}`));
