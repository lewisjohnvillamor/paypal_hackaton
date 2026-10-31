// PayPal disputes on a payment: shown on the case, and the refund agent leaves a disputed payment
// to the merchant so a buyer is not paid twice. PayPal and the AI are test doubles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFindings, fakeAssess, fakePayPal } from "./helpers.js";
import { purchaseAndClaim, setup } from "./harness.js";

let n = 0;
const chipped = { ...clearFindings, damage_kind: "crack_or_chip", signals: { damage_kind: { choice: "crack_or_chip", confidence: 0.9 } } };
const rules = { rules: [{ skus: ["MUG-CLASSIC"], damage: ["crack_or_chip"], maxRefundCents: 2500, action: "refund" }], dailyLimitCents: null };
const parseRules = async () => ({ model: "fake-rules (test double)", notUnderstood: "", ...rules });
const dispute = (status) => [{ dispute_id: "PP-D-1", reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", status, dispute_life_cycle_stage: "INQUIRY",
  dispute_amount: { currency_code: "USD", value: "20.00" }, create_time: "2026-10-30T09:00:00Z" }];

async function agentOn(t) {
  await t.login();
  const text = "Refund chipped mugs under $25 on your own.";
  const p = await t.merchant("POST", "/agent/preview", { text });
  assert.equal((await t.merchant("POST", "/agent", { text, rules: { rules: p.body.rules, dailyLimitCents: p.body.dailyLimitCents } })).status, 200);
}

test("the case shows PayPal's disputes on the payment, and says so when PayPal cannot be asked", async () => {
  let answer = [];
  const t = await setup({ pp: fakePayPal({ payerEmail: () => `d${++n}@example.com`, disputes: () => answer }) });
  try {
    const c = await purchaseAndClaim(t);
    await t.login();
    assert.deepEqual((await t.merchant("GET", `/claims/${c.claimId}/disputes`)).body.disputes, []);
    answer = dispute("WAITING_FOR_SELLER_RESPONSE");
    const [d] = (await t.merchant("GET", `/claims/${c.claimId}/disputes`)).body.disputes;
    assert.deepEqual([d.id, d.reason, d.open, d.stage, d.amount], ["PP-D-1", "item not as described", true, "inquiry", "20.00"]);
    answer = null; // PayPal refuses (an app without the disputes permission)
    const r = (await t.merchant("GET", `/claims/${c.claimId}/disputes`)).body;
    assert.equal(r.disputes, null);
    assert.match(r.error, /did not answer/);
    // Another store's request is not readable.
    await t.call("POST", "/api/dashboard/signup", { body: { name: "Other shop", email: `x${Date.now()}@example.com`, password: "long-enough-pass" } });
    assert.equal((await t.call("GET", `/api/merchant/claims/${c.claimId}/disputes`)).status, 404);
  } finally { t.close(); }
});

test("an open PayPal dispute keeps the refund agent's hands off; a closed one does not", async () => {
  let open = true;
  const pp = fakePayPal({ payerEmail: () => `d${++n}@example.com`, disputes: () => dispute(open ? "OPEN" : "RESOLVED") });
  const t = await setup({ pp, assess: fakeAssess(chipped), parseRules });
  try {
    await agentOn(t);
    const a = await purchaseAndClaim(t);
    const d = (await t.merchant("GET", `/claims/${a.claimId}`)).body;
    assert.equal(d.claim.status, "ready");
    assert.equal(pp.calls.refunds.length, 0);
    const left = d.history.find((h) => h.type === "agent.left_for_merchant");
    assert.equal(left.payload.code, "PAYPAL_DISPUTE_OPEN");
    assert.match(left.payload.why, /open PayPal dispute on this payment \(item not as described\)/);

    open = false;
    const b = await purchaseAndClaim(t);
    assert.equal((await t.merchant("GET", `/claims/${b.claimId}`)).body.claim.status, "refunded");
  } finally { t.close(); }
});

test("when PayPal will not list disputes the agent still refunds through the usual gate", async () => {
  const pp = fakePayPal({ payerEmail: () => `d${++n}@example.com`, disputes: () => null });
  const t = await setup({ pp, assess: fakeAssess(chipped), parseRules });
  try {
    await agentOn(t);
    const a = await purchaseAndClaim(t);
    assert.equal((await t.merchant("GET", `/claims/${a.claimId}`)).body.claim.status, "refunded");
  } finally { t.close(); }
});

test("a hosted demo starts with the agent's starter rules on, once", async () => {
  const { seedDemoMandate, activeMandate, stopMandate, DEMO_RULES_TEXT } = await import("../src/agent/autopilot.js");
  const t = await setup();
  try {
    assert.equal(seedDemoMandate(t.db).text, DEMO_RULES_TEXT);
    assert.match(activeMandate(t.db).readback[0], /^Refund any classic white ceramic mug with a crack or chip or with a snapped-off handle, up to \$25.00/);
    stopMandate(t.db, "merchant");
    assert.equal(seedDemoMandate(t.db), null, "a judge who turned the rules off finds them off after a restart");
    assert.equal(activeMandate(t.db), null);
  } finally { t.close(); }
});
