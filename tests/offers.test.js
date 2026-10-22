// Repair offers: the merchant approves a list of options, the buyer's pick becomes the refund.
// PayPal and Jev are test doubles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFindings, fakeAssess, fakePayPal } from "./helpers.js";
import { purchaseAndClaim, setup } from "./harness.js";
import { resolutionOptions } from "../src/policy/refundPolicy.js";
import { PRODUCTS } from "../src/catalog.js";

const handleOff = { ...clearFindings, damage_kind: "handle_off", signals: { damage_kind: { choice: "handle_off", confidence: 0.9 } } };
const repair = PRODUCTS["MUG-CLASSIC"].repair;
let n = 0;
const uniqueEmails = () => fakePayPal({ payerEmail: () => `offer${++n}@example.com` });

test("only repairable damage the model is sure about gets repair options", () => {
  const opts = resolutionOptions({ repair, quantity: 1, findings: handleOff, amountCents: 2000 });
  assert.deepEqual(opts.map((o) => [o.id, o.refundCents]), [["refund", 2000], ["repair", 1200], ["repair_gold", 300]]);
  assert.equal(opts[2].kitPriceCents, 900);
  const none = (f) => resolutionOptions({ repair, quantity: 1, findings: { ...handleOff, ...f }, amountCents: 2000 });
  assert.deepEqual(none({ damage_kind: "shattered" }), []);
  assert.deepEqual(none({ visible_breakage: "uncertain" }), []);
  assert.deepEqual(none({ signals: { damage_kind: { choice: "handle_off", confidence: 0.3 } } }), []);
  assert.deepEqual(resolutionOptions({ repair: undefined, quantity: 1, findings: handleOff, amountCents: 2000 }), []);
  assert.deepEqual(resolutionOptions({ repair, quantity: 1, findings: null, amountCents: 2000 }), []);
  // Two units: amounts scale; a refund capped below the repair amount leaves only the plain refund.
  assert.deepEqual(resolutionOptions({ repair, quantity: 2, findings: handleOff, amountCents: 4000 }).map((o) => o.refundCents), [4000, 2400, 600]);
  assert.deepEqual(resolutionOptions({ repair, quantity: 1, findings: handleOff, amountCents: 1000 }), []);
});

async function offered(t) {
  const c = await purchaseAndClaim(t);
  await t.login();
  const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
  const sent = await t.merchant("POST", `/claims/${c.claimId}/send-offer`, { claimVersion: d.claim.version, proposalId: d.proposal.id });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const choose = (body) => t.call("POST", `/api/claims/${c.claimId}/choose`, { body, headers: { "X-Claim-Token": c.statusToken } });
  const status = async () => (await t.call("GET", `/api/claims/${c.claimId}/status`, { headers: { "X-Claim-Token": c.statusToken } })).body;
  return { ...c, sent: sent.body, choose, status };
}

test("buyer picks the gold kit: one PayPal refund for the net amount, and a retry refunds nothing more", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(handleOff) });
  try {
    const o = await offered(t);
    assert.equal(o.sent.claim.status, "offer_sent");
    const s = await o.status();
    assert.equal(s.status, "offer_sent");
    assert.deepEqual(s.offer.options.map((x) => x.id), ["refund", "repair", "repair_gold"]);
    assert.equal(s.findings, undefined); // the buyer never sees model output

    const r = await o.choose({ offerId: s.offer.id, optionId: "repair_gold" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "refunded");
    assert.equal(r.body.offer.chosen, "repair_gold");
    assert.equal(t.pp.calls.refunds.length, 1);
    assert.deepEqual(t.pp.calls.refunds[0].body.amount, { currency_code: "USD", value: "3.00" });
    assert.match(t.pp.calls.refunds[0].body.note_to_payer, /gold-leaf kintsugi kit ships separately/);

    const again = await o.choose({ offerId: s.offer.id, optionId: "refund" });
    assert.equal(again.status, 200);
    assert.equal(again.body.offer.chosen, "repair_gold");
    assert.equal(t.pp.calls.refunds.length, 1);

    const d = (await t.merchant("GET", `/claims/${o.claimId}`)).body;
    assert.equal(d.offer.chosen, "repair_gold");
    assert.equal(d.payment.refundableCents, 7700);
    assert.ok(d.history.some((h) => h.type === "offer.accepted" && h.actor === "buyer"));
  } finally { t.close(); }
});

test("the full refund is always one of the choices", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(handleOff) });
  try {
    const o = await offered(t);
    const s = await o.status();
    const r = await o.choose({ offerId: s.offer.id, optionId: "refund" });
    assert.equal(r.body.status, "refunded");
    assert.deepEqual(t.pp.calls.refunds[0].body.amount, { currency_code: "USD", value: "20.00" });
  } finally { t.close(); }
});

test("a buyer cannot invent an option, pick before an offer, or use another claim's link", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(handleOff) });
  try {
    const before = await purchaseAndClaim(t);
    const early = await t.call("POST", `/api/claims/${before.claimId}/choose`, { body: { offerId: "x", optionId: "refund" }, headers: { "X-Claim-Token": before.statusToken } });
    assert.equal(early.status, 404);

    const o = await offered(t);
    const s = await o.status();
    assert.equal((await o.choose({ offerId: s.offer.id, optionId: "refund_double" })).status, 400);
    const wrongLink = await t.call("POST", `/api/claims/${o.claimId}/choose`, { body: { offerId: s.offer.id, optionId: "refund" }, headers: { "X-Claim-Token": before.statusToken } });
    assert.equal(wrongLink.status, 403);
    assert.equal(t.pp.calls.refunds.length, 0);
  } finally { t.close(); }
});

test("shattered mugs get no offer, and a stale case cannot be offered", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(clearFindings) });
  try {
    const c = await purchaseAndClaim(t);
    await t.login();
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.deepEqual(d.proposal.options, []);
    const r = await t.merchant("POST", `/claims/${c.claimId}/send-offer`, { claimVersion: d.claim.version, proposalId: d.proposal.id });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "NO_OPTIONS");
    const stale = await t.merchant("POST", `/claims/${c.claimId}/send-offer`, { claimVersion: d.claim.version - 1, proposalId: d.proposal.id });
    assert.equal(stale.body.error, "STALE_CASE");
  } finally { t.close(); }
});

test("a case the policy did not propose needs the merchant's reason before options go out", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess({ ...handleOff, product_consistency: "uncertain" }) });
  try {
    const c = await purchaseAndClaim(t);
    await t.login();
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.proposal.route, "manual_review");
    const body = { claimVersion: d.claim.version, proposalId: d.proposal.id };
    assert.equal((await t.merchant("POST", `/claims/${c.claimId}/send-offer`, body)).body.error, "REASON_REQUIRED");
    assert.equal((await t.merchant("POST", `/claims/${c.claimId}/send-offer`, { ...body, reason: "Photo 1 shows our mug" })).status, 200);
  } finally { t.close(); }
});
