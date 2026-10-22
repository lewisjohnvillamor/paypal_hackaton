// PayPal REST client, sandbox only: OAuth, Orders v2, Payments v2 captures and refunds.
const SANDBOX = "https://api-m.sandbox.paypal.com";

if ((process.env.PAYPAL_MODE || "sandbox") !== "sandbox") {
  throw new Error("Refund Relay is a hackathon build and only runs against the PayPal sandbox.");
}

let cached = null; // { token, expiresAt }

export async function accessToken() {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env");
  const res = await fetch(`${SANDBOX}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64") },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error("PayPal OAuth failed"), { status: res.status, debugId: res.headers.get("paypal-debug-id") });
  // Refresh a minute early so a token never expires mid-request.
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.token;
}

// Returns { status, body, debugId }. Network failures throw; callers decide what an exception means.
async function call(method, path, payload, extraHeaders = {}) {
  const res = await fetch(SANDBOX + path, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extraHeaders,
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, debugId: res.headers.get("paypal-debug-id") };
}

export function createOrder({ lines, totalValue, customId }) {
  return call("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      custom_id: customId,
      amount: {
        currency_code: "USD",
        value: totalValue,
        breakdown: { item_total: { currency_code: "USD", value: totalValue } },
      },
      items: lines.map((l) => ({
        name: l.title,
        sku: l.sku,
        quantity: String(l.quantity),
        unit_amount: { currency_code: "USD", value: l.unitValue },
      })),
    }],
  });
}

export const captureOrder = (orderId, requestId) =>
  call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, null, { "PayPal-Request-Id": requestId });

export const getOrder = (orderId) => call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);

export const getCapture = (captureId) => call("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`);

export const refundCapture = (captureId, body, requestId) =>
  call("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, body, { "PayPal-Request-Id": requestId });

export const getRefund = (refundId) => call("GET", `/v2/payments/refunds/${encodeURIComponent(refundId)}`);
