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

export function fakePayPal({ refundBehavior } = {}) {
  const calls = { refunds: [] };
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
          id: orderId, status: "COMPLETED", payer: { email_address: "buyer@example.com" },
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
    async getRefund(id) {
      const r = [...refunds.values()].find((x) => x.id === id);
      return r ? { status: 200, body: r } : { status: 404, body: {} };
    },
  };
  return pp;
}

export const clearFindings = { evidence_usable: "yes", visible_breakage: "yes", product_consistency: "consistent", damage_kind: "shattered" };

export const fakeAssess = (findings = clearFindings) => async () => ({
  model: "fake-jev (test double)", findings, answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 1,
});

export const testPhoto = () => sharp({ create: { width: 400, height: 300, channels: 3, background: "#c33" } }).jpeg().toBuffer();
