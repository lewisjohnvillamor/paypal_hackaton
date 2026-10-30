// The inbox's impact strip: numbers from the store's own claims and PayPal refund records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFindings, fakeAssess, fakePayPal } from "./helpers.js";
import { approve, purchaseAndClaim, setup } from "./harness.js";

let n = 0;
const pp = () => fakePayPal({ payerEmail: () => `stats${++n}@example.com` });

test("stats count requests, refunds, the wait for PayPal and what a partial refund kept", async () => {
  const t = await setup({ pp: pp(), assess: fakeAssess({ ...clearFindings, damage_kind: "cosmetic", signals: { damage_kind: { confidence: 0.9 } } }) });
  try {
    await t.login();
    assert.deepEqual((await t.merchant("GET", "/stats")).body.requests, 0);
    const a = await purchaseAndClaim(t);
    const d = (await t.merchant("GET", `/claims/${a.claimId}`)).body;
    assert.equal(d.proposal.amountCents, 400); // scratches: 20% of a $20 mug
    assert.equal((await approve(t, d)).status, 200);
    const b = await purchaseAndClaim(t);
    await t.merchant("POST", `/claims/${b.claimId}/close`, { reason: "Outside our policy" });
    await purchaseAndClaim(t); // still open
    const s = (await t.merchant("GET", "/stats")).body;
    assert.equal(s.requests, 3);
    assert.equal(s.settled, 2);
    assert.equal(s.open, 1);
    assert.equal(s.settledByAgent, 0);
    assert.equal(s.refundedCents, 400);
    assert.equal(s.keptCents, 1600); // a declined request keeps nothing: only the partial refund counts
    assert.ok(s.medianRefundMs >= 0);
  } finally { t.close(); }
});

test("stats are per store and need the merchant's sign-in", async () => {
  const t = await setup({ pp: pp() });
  try {
    assert.equal((await t.call("GET", "/api/merchant/stats")).status, 401);
    await purchaseAndClaim(t);
    await t.call("POST", "/api/dashboard/signup", { body: { name: "Other shop", email: `o${Date.now()}@example.com`, password: "long-enough-pass" } });
    assert.equal((await t.call("GET", "/api/merchant/stats", { headers: { "X-Refund-Relay": "1" } })).body.requests, 0);
  } finally { t.close(); }
});
