// Test doubles. These simulate PayPal and Jev for invariant tests; they are labelled as fakes and
// never used by the running app.
import sharp from "sharp";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESSION_SECRET ||= "test-secret-test-secret-test-secret-0000";
process.env.MERCHANT_PASSWORD ||= "test-password";
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "rr-uploads-"));
process.env.PAYPAL_MERCHANT_ID = "MERCHANT123";
process.env.LOG_REQUESTS ??= "0";

export function fakePayPal({ refundBehavior, ledger, payerEmail = () => "buyer@example.com" } = {}) {
  const calls = { refunds: [], orders: 0 };
  const refunds = new Map(); // requestId -> refund (PayPal idempotency)
  let seq = 0;
  const pp = {
    calls,
    async createOrder({ totalValue }) {
      return { status: 201, body: { id: `ORDER-${++seq}`, status: "CREATED", links: [{ rel: "approve", href: "https://example/approve" }], total: totalValue } };
    },
    async captureOrder(orderId) {
      return {
        status: 201,
        body: {
          id: orderId, status: "COMPLETED", payer: { email_address: payerEmail(orderId) },
          purchase_units: [{ payee: { merchant_id: "MERCHANT123" }, payments: { captures: [{ id: `CAP-${orderId}`, status: "COMPLETED", amount: { currency_code: "USD", value: "80.00" } }] } }],
        },
      };
    },
    async refundCapture(captureId, body, requestId) {
      calls.refunds.push({ captureId, body, requestId });
      if (refundBehavior) {
        const r = await refundBehavior({ captureId, body, requestId, refunds });
        if (r) return r;
      }
      if (!refunds.has(requestId)) refunds.set(requestId, { id: `REF-${refunds.size + 1}`, status: "COMPLETED", amount: body.amount });
      return { status: 201, body: refunds.get(requestId), debugId: "dbg" };
    },
    // Orders v2 GET: the capture plus every refund PayPal knows about. `ledger` lets a test add
    // refunds made outside the app or change the capture status (e.g. a chargeback reversal).
    async getOrder(orderId) {
      calls.orders++;
      const own = [...refunds.values()];
      const extra = ledger?.() ?? {};
      return {
        status: 200,
        body: {
          id: orderId,
          purchase_units: [{ payments: {
            captures: [{ id: `CAP-${orderId}`, status: extra.captureStatus ?? (own.length ? "PARTIALLY_REFUNDED" : "COMPLETED") }],
            refunds: [...own, ...(extra.refunds ?? [])],
          } }],
        },
      };
    },
    async getRefund(id) {
      const r = [...refunds.values()].find((x) => x.id === id);
      return r ? { status: 200, body: r } : { status: 404, body: {} };
    },
  };
  return pp;
}

export const clearFindings = {
  evidence_usable: "yes", visible_breakage: "yes", product_consistency: "consistent", damage_kind: "shattered",
  design_match: "match", stock_photo_suspected: false, instructions_in_photo: false,
};

export const fakeAssess = (findings = clearFindings) => async () => ({
  model: "fake-jev (test double)", findings, answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 1,
});

// Claude Haiku test double: records what it was sent and answers with the given suggestions.
export function fakeSuggest(suggestions = []) {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    return { model: "fake-haiku (test double)", latencyMs: 1, usage: {}, suggestions: typeof suggestions === "function" ? suggestions(input) : suggestions };
  };
  fn.calls = calls;
  return fn;
}

// A distinct photo per seed, so record-based duplicate checks only fire when a test means them to.
export function testPhoto(seed = Math.floor(Math.random() * 1e9)) {
  const w = 400, h = 300, px = Buffer.alloc(w * h * 3);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < 48; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const v = x & 255;
    const bx = (i % 8) * 50, by = Math.floor(i / 8) * 50;
    for (let yy = by; yy < by + 50; yy++) for (let xx = bx; xx < bx + 50; xx++) px.fill(v, (yy * w + xx) * 3, (yy * w + xx) * 3 + 3);
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
}
