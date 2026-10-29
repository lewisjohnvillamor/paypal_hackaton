// The refund agent: the merchant's plain-English rules become a checked structure, read back, and
// the agent refunds within them with no click, leaving everything else for the merchant.
// PayPal, Jev and the rule-reading AI are test doubles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFindings, fakeAssess, fakePayPal, testPhoto } from "./helpers.js";
import { purchaseAndClaim, setup } from "./harness.js";
import { AGENT_CEILING_CENTS, checkRules, decide, describeRules } from "../src/agent/rules.js";

let n = 0;
const uniqueEmails = (opts = {}) => fakePayPal({ payerEmail: () => `agent${++n}@example.com`, ...opts });
// A chip the photo check is sure of; the mug costs $20.
const chipped = { ...clearFindings, damage_kind: "crack_or_chip", signals: { damage_kind: { choice: "crack_or_chip", confidence: 0.9 } } };
const chippedMugs = (max = 2500, extra = {}) => ({ rules: [{ skus: ["MUG-CLASSIC"], damage: ["crack_or_chip"], maxRefundCents: max, action: "refund" }], dailyLimitCents: null, ...extra });
// The rule-reading AI double: records the text and answers with the given structure.
const fakeParser = (answer) => {
  const fn = async (input) => { fn.calls.push(input); return { model: "fake-rules (test double)", notUnderstood: "", ...(typeof answer === "function" ? answer(input) : answer) }; };
  fn.calls = [];
  return fn;
};
const ctx = (o = {}) => ({ route: "auto_refund", reasons: [], amountCents: 2000, sku: "MUG-CLASSIC", findings: chipped, options: 1, spentCents: 0, ...o });

test("rules are checked: known products and damage, a limit on every rule, a ceiling, a daily limit", () => {
  const ok = checkRules(chippedMugs());
  assert.equal(ok.dailyLimitCents, 10000); // unstated: $100, or the largest rule's limit if higher
  assert.equal(checkRules(chippedMugs(15000)).dailyLimitCents, 15000);
  const bad = (r, re) => assert.throws(() => checkRules(r), re);
  bad({ rules: [] }, /No rule/);
  bad({ rules: [{ skus: ["NOPE"], damage: [], maxRefundCents: 100 }] }, /does not sell/);
  bad({ rules: [{ skus: ["MUG-CLASSIC"], damage: ["stain"], maxRefundCents: 100 }] }, /cannot have/);
  bad({ rules: [{ skus: [], damage: [], maxRefundCents: 0 }] }, /refund limit/);
  bad({ rules: [{ skus: [], damage: [], maxRefundCents: 25.5 }] }, /refund limit/);
  bad({ rules: [{ skus: [], damage: [], maxRefundCents: AGENT_CEILING_CENTS + 1 }] }, /at most/);
  bad(chippedMugs(2500, { dailyLimitCents: 1000 }), /below a rule/);
  // A stain rule is fine for the T-shirt; any-product rules may name any product's damage.
  assert.ok(checkRules({ rules: [{ skus: ["TEE-ORGANIC"], damage: ["stain"], maxRefundCents: 2500 }] }));
});

test("the read-back is written from the structure, not the AI's words", () => {
  const lines = describeRules(checkRules({ rules: [
    { skus: ["MUG-CLASSIC"], damage: ["crack_or_chip"], maxRefundCents: 2500, action: "refund" },
    { skus: [], damage: [], maxRefundCents: 1000, action: "offer" },
  ], dailyLimitCents: 5000 }));
  assert.equal(lines[0], "Refund any classic white ceramic mug with a crack or chip, up to $25.00 a request.");
  assert.equal(lines[1], "Let the buyer choose from your remedies, or a full refund, for any product with damage, up to $10.00 a request.");
  assert.equal(lines[2], "Never more than $50.00 in a day without you.");
  assert.match(lines.at(-1), /anything else waits for you/);
});

test("the agent acts only on a clear proposal inside a rule, the limit and the day's total", () => {
  const m = checkRules(chippedMugs());
  assert.equal(decide(m, ctx()).act, "refund");
  assert.equal(decide(m, ctx()).rule, 0);
  const left = (o, code) => { const d = decide(m, ctx(o)); assert.equal(d.act, null); assert.equal(d.code, code, d.why); return d.why; };
  assert.match(left({ route: "manual_review", reasons: ["REPEAT_CLAIMANT"] }, "POLICY_FLAGGED"), /concern, so you decide. This buyer filed/);
  // Unusable photos: the agent asks the buyer for clearer ones (no money moves), on any rules.
  assert.equal(decide(m, ctx({ route: "request_info" })).act, "ask");
  assert.equal(decide(m, ctx({ route: "reject", askForPhotos: true, sku: "VASE-GLASS" })).code, "ASKING_FOR_PHOTOS");
  assert.match(left({ amountCents: 4000 }, "OVER_LIMIT"), /\$40.00 is above your \$25.00 limit/);
  assert.match(left({ sku: "VASE-GLASS" }, "NO_RULE"), /clear glass cylinder vase/);
  assert.match(left({ findings: { ...chipped, damage_kind: "shattered", signals: { damage_kind: { confidence: 0.9 } } } }, "NO_RULE"), /don't cover broken into pieces/);
  assert.match(left({ findings: { ...chipped, signals: { damage_kind: { confidence: 0.3 } } } }, "NO_RULE"), /wasn't sure/);
  assert.match(left({ spentCents: 9000 }, "DAILY_LIMIT"), /\$100.00 daily limit/);
  // An offer rule needs something to offer besides the refund.
  const offer = checkRules({ rules: [{ skus: [], damage: [], maxRefundCents: 2500, action: "offer" }] });
  assert.equal(decide(offer, ctx({ options: 3 })).act, "offer");
  assert.equal(decide(offer, ctx({ options: 0 })).code, "NOTHING_TO_OFFER");
  // A wider rule after a narrower one still applies when the first is over its limit.
  const two = checkRules({ rules: [{ skus: [], damage: [], maxRefundCents: 1000 }, { skus: ["MUG-CLASSIC"], damage: [], maxRefundCents: 3000 }] });
  assert.equal(decide(two, ctx()).rule, 1);
});

async function withRules(t, rules, text = "Refund chipped mugs under $25 on your own. Ask me about anything above that.") {
  await t.login();
  const preview = await t.merchant("POST", "/agent/preview", { text });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const on = await t.merchant("POST", "/agent", { text, rules: { rules: preview.body.rules, dailyLimitCents: preview.body.dailyLimitCents } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  return { preview: preview.body, mandate: on.body };
}

test("a chipped $20 mug inside the rule is refunded through PayPal with no click", async () => {
  const parser = fakeParser(chippedMugs());
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(chipped), parseRules: parser });
  try {
    const { preview, mandate } = await withRules(t);
    assert.equal(parser.calls[0].text, "Refund chipped mugs under $25 on your own. Ask me about anything above that.");
    assert.ok(parser.calls[0].products.length >= 4 && parser.calls[0].damage.some((d) => d.key === "crack_or_chip"));
    assert.equal(preview.readback[0], "Refund any classic white ceramic mug with a crack or chip, up to $25.00 a request.");
    assert.equal(mandate.text, preview.text);

    const c = await purchaseAndClaim(t);
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.claim.status, "refunded");
    assert.equal(t.pp.calls.refunds.length, 1);
    assert.equal(t.pp.calls.refunds[0].body.amount.value, "20.00");
    assert.match(t.pp.calls.refunds[0].body.note_to_payer, /refund rules/);
    assert.deepEqual(d.approvals.map((a) => [a.actor, a.amount_cents]), [["agent", 2000]]);
    const steps = d.timeline.map((s) => [s.actor, s.title]);
    assert.ok(steps.some(([a, x]) => a === "agent" && /approved the refund, on its own/.test(x)), JSON.stringify(steps));
    assert.ok(steps.some(([a]) => a === "paypal"));
    assert.ok(!steps.some(([, x]) => /^You approved/.test(x)));

    const status = (await t.call("GET", `/api/claims/${c.claimId}/status`, { headers: { "X-Claim-Token": c.statusToken } })).body;
    assert.equal(status.refund.state, "issued");

    const page = (await t.merchant("GET", "/agent")).body;
    assert.equal(page.spentCents, 2000);
    assert.equal(page.recent[0].acted, true);
    const row = (await t.merchant("GET", "/claims")).body[0];
    assert.equal(row.agent, "acted");
  } finally { t.close(); }
});

test("over the limit, flagged, or with no rules on: the case waits for the merchant and nothing is refunded", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(chipped), parseRules: fakeParser(chippedMugs(1500)) });
  try {
    // No rules yet: the agent stays silent.
    const before = await purchaseAndClaim(t);
    await t.login();
    let d = (await t.merchant("GET", `/claims/${before.claimId}`)).body;
    assert.equal(d.claim.status, "ready");
    assert.ok(!d.history.some((h) => h.actor === "agent"));

    await withRules(t, null, "Refund chipped mugs under $15.");
    const c = await purchaseAndClaim(t);
    d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.claim.status, "ready");
    assert.equal(t.pp.calls.refunds.length, 0);
    const note = d.timeline.find((s) => s.actor === "agent");
    assert.equal(note.title, "Your refund agent left this one for you");
    assert.match(note.detail, /\$20.00 is above your \$15.00 limit/);
    const row = (await t.merchant("GET", "/claims")).body.find((r) => r.id === c.claimId);
    assert.equal(row.agent, "left");
    assert.match(row.agent_why, /above your/);

    // The merchant can still approve it themselves, as before.
    const ok = await t.merchant("POST", `/claims/${c.claimId}/approve-refund`, { claimVersion: d.claim.version, proposalId: d.proposal.id, amountCents: 2000 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.claim.status, "refunded");

    // Turned off: silent again.
    await t.merchant("DELETE", "/agent");
    const after = await purchaseAndClaim(t);
    d = (await t.merchant("GET", `/claims/${after.claimId}`)).body;
    assert.ok(!d.history.some((h) => h.actor === "agent"));
  } finally { t.close(); }
});

test("a report the photo check is unsure of is never refunded by the agent", async () => {
  const unsure = { ...chipped, visible_breakage: "uncertain" };
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(unsure), parseRules: fakeParser(chippedMugs()) });
  try {
    await withRules(t);
    const c = await purchaseAndClaim(t);
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.claim.status, "ready");
    assert.equal(t.pp.calls.refunds.length, 0);
    assert.match(d.timeline.find((s) => s.actor === "agent").detail, /raised a concern, so you decide. The model is unsure whether damage is visible/);
  } finally { t.close(); }
});

test("the daily limit holds: the second refund that would pass it waits for the merchant", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(chipped), parseRules: fakeParser(chippedMugs(2500, { dailyLimitCents: 3000 })) });
  try {
    const { preview } = await withRules(t);
    assert.match(preview.readback.join(" "), /Never more than \$30.00 in a day/);
    const a = await purchaseAndClaim(t);
    const b = await purchaseAndClaim(t);
    const sa = (await t.merchant("GET", `/claims/${a.claimId}`)).body;
    const sb = (await t.merchant("GET", `/claims/${b.claimId}`)).body;
    assert.equal(sa.claim.status, "refunded");
    assert.equal(sb.claim.status, "ready");
    assert.match(sb.timeline.find((s) => s.actor === "agent").detail, /past your \$30.00 daily limit \(\$20.00 sent/);
    assert.equal(t.pp.calls.refunds.length, 1);
  } finally { t.close(); }
});

test("a refund PayPal shows that the app did not make stops the agent too", async () => {
  const pp = uniqueEmails({ ledger: () => ({ refunds: [{ id: "OUTSIDE-1", status: "COMPLETED", amount: { value: "5.00" } }] }) });
  const t = await setup({ pp, assess: fakeAssess(chipped), parseRules: fakeParser(chippedMugs()) });
  try {
    await withRules(t);
    const c = await purchaseAndClaim(t);
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.claim.status, "ready");
    assert.equal(pp.calls.refunds.length, 0);
    assert.match(d.timeline.find((s) => s.actor === "agent").detail, /did not make.*The agent did not refund/);
  } finally { t.close(); }
});

test("an offer rule sends the buyer the merchant's remedies, and the buyer's pick is the refund", async () => {
  const handleOff = { ...chipped, damage_kind: "handle_off", remedyFit: { kintsugi: 0.82, replacement: 0.9 } };
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(handleOff), parseRules: fakeParser({ rules: [{ skus: ["MUG-CLASSIC"], damage: [], maxRefundCents: 2500, action: "offer" }] }) });
  try {
    await withRules(t, null, "For any damaged mug up to $25, let the buyer pick one of my remedies.");
    const c = await purchaseAndClaim(t);
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.claim.status, "offer_sent");
    assert.equal(d.offer.sentBy, "agent");
    assert.equal(t.pp.calls.refunds.length, 0);
    assert.equal((await t.merchant("GET", "/agent")).body.spentCents, 2000); // an open offer counts at its largest option
    const s = (await t.call("GET", `/api/claims/${c.claimId}/status`, { headers: { "X-Claim-Token": c.statusToken } })).body;
    const r = await t.call("POST", `/api/claims/${c.claimId}/choose`, { body: { offerId: s.offer.id, optionId: "kintsugi" }, headers: { "X-Claim-Token": c.statusToken } });
    assert.equal(r.body.status, "refunded");
    assert.equal(t.pp.calls.refunds[0].body.amount.value, "12.00");
    assert.equal((await t.merchant("GET", "/agent")).body.spentCents, 1200);
  } finally { t.close(); }
});

test("preview: rules the AI could not make are refused with its note; no AI means no plain-English rules", async () => {
  const t = await setup({ parseRules: fakeParser({ rules: [], notUnderstood: "No amount was given." }) });
  try {
    await t.login();
    const r = await t.merchant("POST", "/agent/preview", { text: "Refund whatever seems fair." });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /No rule.*No amount was given/);
    // A structure sent straight to the save endpoint is checked the same way.
    const bad = await t.merchant("POST", "/agent", { text: "x", rules: { rules: [{ skus: [], damage: [], maxRefundCents: AGENT_CEILING_CENTS * 10 }] } });
    assert.equal(bad.status, 400);
    assert.equal((await t.merchant("GET", "/agent")).body.mandate, null);
  } finally { t.close(); }
  const off = await setup();
  try {
    await off.login();
    assert.equal((await off.merchant("GET", "/agent")).body.canWrite, false);
    assert.equal((await off.merchant("POST", "/agent/preview", { text: "Refund chipped mugs under $25." })).status, 503);
  } finally { off.close(); }
});

test("preview replays the rules over recent requests without acting on them", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(chipped), parseRules: fakeParser(chippedMugs()) });
  try {
    const c = await purchaseAndClaim(t);
    await t.login();
    const p = (await t.merchant("POST", "/agent/preview", { text: "Refund chipped mugs under $25." })).body;
    assert.deepEqual(p.replay.map((x) => [x.id, x.act]), [[c.claimId, "refund"]]);
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.claim.status, "ready");
    assert.equal(t.pp.calls.refunds.length, 0);
  } finally { t.close(); }
});

test("unusable photos: with rules on, the agent asks the buyer for clearer ones and the new photo is reviewed", async () => {
  const blurry = { ...chipped, evidence_usable: "no" };
  let findings = blurry;
  const t = await setup({ pp: uniqueEmails(), assess: async () => ({ model: "fake-jev (test double)", findings, answers: {}, usage: {}, latencyMs: 1 }), parseRules: fakeParser(chippedMugs()) });
  try {
    // No rules on: the case waits for the merchant, and the buyer is not told anything yet.
    const before = await purchaseAndClaim(t);
    await t.login();
    assert.equal((await t.merchant("GET", `/claims/${before.claimId}`)).body.claim.status, "ready");

    await withRules(t);
    const c = await purchaseAndClaim(t);
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.claim.status, "needs_info");
    assert.equal(t.pp.calls.refunds.length, 0);
    assert.ok(d.timeline.some((s) => s.actor === "agent" && /asked the buyer for clearer photos/.test(s.title)), JSON.stringify(d.timeline));
    const headers = { "X-Claim-Token": c.statusToken };
    const status = (await t.call("GET", `/api/claims/${c.claimId}/status`, { headers })).body;
    assert.equal(status.status, "needs_info");
    assert.match(status.infoRequest, /clear, well-lit photo/);

    // The buyer (or their assistant) sends a clear photo; the agent refunds it under the rule.
    findings = chipped;
    const form = new FormData();
    form.append("photos", new Blob([await testPhoto()], { type: "image/jpeg" }), "p.jpg");
    const more = await t.call("POST", `/api/claims/${c.claimId}/evidence`, { form, headers });
    assert.equal(more.status, 200, JSON.stringify(more.body));
    assert.equal((await t.merchant("GET", `/claims/${c.claimId}`)).body.claim.status, "refunded");
    assert.equal(t.pp.calls.refunds.length, 1);
  } finally { t.close(); }
});
