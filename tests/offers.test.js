// Remedy offers: Jev ranks the merchant's remedy library against the photos, the merchant approves
// the list, and the buyer's pick becomes the refund (or no refund, for a replacement).
// PayPal and Jev are test doubles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFindings, fakeAssess, fakePayPal } from "./helpers.js";
import { purchaseAndClaim, setup } from "./harness.js";
import { resolutionOptions } from "../src/policy/refundPolicy.js";
import { PRODUCTS } from "../src/catalog.js";

const remedyFit = { kintsugi: 0.82, kintsugi_gold: 0.7, replacement: 0.9 };
const handleOff = { ...clearFindings, damage_kind: "handle_off", remedyFit };
const remedies = PRODUCTS["MUG-CLASSIC"].remedies;
let n = 0;
const uniqueEmails = () => fakePayPal({ payerEmail: () => `offer${++n}@example.com` });

test("only remedies Jev judged to fit are offered, best fit first, next to the full refund", () => {
  const ids = (o) => o.map((x) => [x.id, x.refundCents]);
  const opts = resolutionOptions({ remedies, quantity: 1, findings: handleOff, amountCents: 2000 });
  assert.deepEqual(ids(opts), [["refund", 2000], ["replacement", 0], ["kintsugi", 1200], ["kintsugi_gold", 300]]);
  assert.equal(opts[1].fit, 0.9);
  const some = resolutionOptions({ remedies, quantity: 1, findings: { ...handleOff, remedyFit: { kintsugi: 0.3, replacement: 0.6 } }, amountCents: 2000 });
  assert.deepEqual(ids(some), [["refund", 2000], ["replacement", 0]]);
  const none = (f) => resolutionOptions({ remedies, quantity: 1, findings: { ...handleOff, ...f }, amountCents: 2000 });
  assert.deepEqual(none({ remedyFit: { kintsugi: 0.2 } }), []);
  assert.deepEqual(none({ remedyFit: undefined }), []); // the ranking call failed: plain refund only
  assert.deepEqual(none({ visible_breakage: "uncertain" }), []);
  assert.deepEqual(none({ evidence_usable: "no" }), []);
  assert.deepEqual(resolutionOptions({ remedies: [], quantity: 1, findings: handleOff, amountCents: 2000 }), []);
  assert.deepEqual(resolutionOptions({ remedies, quantity: 1, findings: null, amountCents: 2000 }), []);
  // Two units: amounts scale. A refund capped at or below a remedy's amount drops that remedy.
  assert.deepEqual(ids(resolutionOptions({ remedies, quantity: 2, findings: handleOff, amountCents: 4000 })).map((x) => x[1]), [4000, 0, 2400, 600]);
  assert.deepEqual(ids(resolutionOptions({ remedies, quantity: 1, findings: handleOff, amountCents: 1000 })), [["refund", 1000], ["replacement", 0], ["kintsugi_gold", 300]]);
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
    assert.deepEqual(s.offer.options.map((x) => x.id), ["refund", "replacement", "kintsugi", "kintsugi_gold"]);
    assert.equal(s.findings, undefined); // the buyer never sees model output

    const r = await o.choose({ offerId: s.offer.id, optionId: "kintsugi_gold" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "refunded");
    assert.equal(r.body.offer.chosen, "kintsugi_gold");
    assert.equal(t.pp.calls.refunds.length, 1);
    assert.deepEqual(t.pp.calls.refunds[0].body.amount, { currency_code: "USD", value: "3.00" });
    assert.match(t.pp.calls.refunds[0].body.note_to_payer, /gold-leaf kintsugi kit .*ships separately/);

    const again = await o.choose({ offerId: s.offer.id, optionId: "refund" });
    assert.equal(again.status, 200);
    assert.equal(again.body.offer.chosen, "kintsugi_gold");
    assert.equal(t.pp.calls.refunds.length, 1);

    const d = (await t.merchant("GET", `/claims/${o.claimId}`)).body;
    assert.equal(d.offer.chosen, "kintsugi_gold");
    assert.equal(d.payment.refundableCents, 7700);
    assert.ok(d.history.some((h) => h.type === "offer.accepted" && h.actor === "buyer"));
    // The agent timeline tells the whole story in order, naming who acted at each step.
    const who = d.timeline.map((x) => x.actor);
    assert.deepEqual([...new Set(who)], ["buyer", "jev", "policy", "merchant", "paypal"]);
    assert.ok(d.timeline.some((x) => x.title === "Buyer chose: Mend it in 24k gold leaf ($9 kit)"));
    assert.equal(d.timeline.at(-1).title, "PayPal completed the refund");
    // The inbox grid row carries the headline finding and how the case ended.
    const row = (await t.merchant("GET", "/claims")).body.find((r) => r.id === o.claimId);
    assert.equal(row.damage_kind, "handle_off");
    assert.equal(row.remedies, 3);
    assert.equal(row.ai_suggestions, 0);
    assert.equal(row.chosen_title, "Mend it in 24k gold leaf ($9 kit)");
    assert.equal(row.chosen_option, "kintsugi_gold");
    assert.equal(row.refunded_cents, 300);
    assert.equal(row.concerns, 0);
    assert.ok(who.indexOf("jev") < who.indexOf("policy") && who.indexOf("policy") < who.indexOf("merchant"));
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

test("damage no remedy fits gets no offer, and a stale case cannot be offered", async () => {
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

test("a replacement settles the case with no PayPal call, and the order cannot be claimed again for it", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(handleOff) });
  try {
    const o = await offered(t);
    const s = await o.status();
    const r = await o.choose({ offerId: s.offer.id, optionId: "replacement" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "resolved");
    assert.equal(t.pp.calls.refunds.length, 0);
    assert.equal((await o.choose({ offerId: s.offer.id, optionId: "refund" })).body.offer.chosen, "replacement");
    assert.equal(t.pp.calls.refunds.length, 0);
    const d = (await t.merchant("GET", `/claims/${o.claimId}`)).body;
    assert.equal(d.claim.status, "resolved");
    assert.ok(d.timeline.some((x) => x.title === "Sorted without a refund" && /new Classic white ceramic mug/.test(x.detail)));
    assert.equal(d.payment.refundableCents, 8000);
  } finally { t.close(); }
});

test("the merchant edits the remedy library, and Jev is only asked about active remedies", async () => {
  const seen = [];
  const t = await setup({ pp: uniqueEmails(), assess: async (input) => { seen.push(input.remedies.map((r) => r.id)); return fakeAssess(handleOff)(input); } });
  try {
    await t.login();
    const lib = (await t.merchant("GET", "/remedies")).body;
    const mug = lib.find((p) => p.sku === "MUG-CLASSIC");
    assert.deepEqual(mug.remedies.map((r) => r.id), ["kintsugi", "kintsugi_gold", "replacement"]);
    const bad = (body) => t.merchant("POST", "/remedies", { sku: "MUG-CLASSIC", kind: "spare_part", title: "Spare lid", item: "a matching lid", fits: "The lid is cracked.", refundUnitCents: 500, ...body });
    assert.equal((await bad({ refundUnitCents: 2000 })).status, 400); // a remedy can never refund the full price
    assert.equal((await bad({ refundUnitCents: -1 })).status, 400);
    assert.equal((await bad({ kind: "voucher" })).status, 400);
    assert.equal((await bad({ title: "x" })).status, 400);
    assert.equal((await bad({ sku: "NOPE" })).status, 400);
    const made = await bad({});
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await t.merchant("PATCH", "/remedies/kintsugi", { active: false })).body.active, false);
    assert.equal((await t.merchant("PATCH", "/remedies/missing", { active: false })).status, 404);
    await purchaseAndClaim(t);
    assert.deepEqual(seen.at(-1), ["kintsugi_gold", "replacement", made.body.id]);
  } finally { t.close(); }
});

test("the merchant can take back unanswered choices; the old offer can no longer be picked", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(handleOff) });
  try {
    const o = await offered(t);
    const s = await o.status();
    const w = await t.merchant("POST", `/claims/${o.claimId}/withdraw-offer`);
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.body.claim.status, "ready");
    assert.equal(w.body.proposal.current, false, "the merchant reviews again before deciding");
    assert.ok(w.body.timeline.some((x) => x.title === "You took back the choices"));
    assert.equal((await o.status()).offer, null, "the buyer no longer sees the choices");
    const late = await o.choose({ offerId: s.offer.id, optionId: "refund" });
    assert.equal(late.status, 409);
    assert.equal(t.pp.calls.refunds.length, 0);
    assert.equal((await t.merchant("POST", `/claims/${o.claimId}/withdraw-offer`)).status, 409);
    await t.merchant("POST", `/claims/${o.claimId}/assess`);
    const d = (await t.merchant("GET", `/claims/${o.claimId}`)).body;
    assert.equal(d.proposal.current, true);
    const r = await t.merchant("POST", `/claims/${o.claimId}/approve-refund`, { claimVersion: d.claim.version, proposalId: d.proposal.id, amountCents: d.proposal.amountCents });
    assert.equal(r.body.claim.status, "refunded");
  } finally { t.close(); }
});

test("the buyer's choices carry no AI scores, and a replacement pick needs no PayPal lookup", async () => {
  const pp = uniqueEmails();
  const t = await setup({ pp, assess: fakeAssess(handleOff) });
  try {
    const o = await offered(t);
    const s = await o.status();
    assert.ok(s.offer.options.every((x) => !("fit" in x) && !("source" in x)));
    pp.getOrder = async () => { throw new Error("PayPal is down"); };
    const r = await o.choose({ offerId: s.offer.id, optionId: "replacement" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "resolved");
  } finally { t.close(); }
});

test("a buyer whose pick the refund gate stops reads what it means for them, not the merchant's to-do", async () => {
  let external = false;
  const pp = fakePayPal({ payerEmail: () => `gate${++n}@example.com`, ledger: () => (external ? { refunds: [{ id: "DASHBOARD-1", status: "COMPLETED", amount: { value: "5.00" } }] } : {}) });
  const t = await setup({ pp, assess: fakeAssess(handleOff) });
  try {
    const o = await offered(t);
    const s = await o.status();
    external = true; // the shop refunded something from the PayPal dashboard meanwhile
    const r = await o.choose({ offerId: s.offer.id, optionId: "refund" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "EXTERNAL_REFUND_DETECTED");
    assert.doesNotMatch(r.body.message, /Reconcile|Refund Relay/);
    assert.match(r.body.message, /Nothing was refunded/);
    assert.equal(t.pp.calls.refunds.length, 0);
    assert.equal((await o.status()).status, "offer_sent", "the choice stays open");
  } finally { t.close(); }
});
