// Refund policy v3: every request lands in exactly one of auto_refund, manual_review or reject,
// from fixed rules over the photo check's signals, the shop's records and the merchant's settings.
// One test per branch, then the agent and the API end to end. PayPal and the photo check are doubles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFindings, fakeAssess, fakePayPal } from "./helpers.js";
import { fileClaim, purchase, setup } from "./harness.js";
import { AI_REJECTS, HARD_REJECTS, ROUTES, draftProposal, resolutionOptions, severityAmount } from "../src/policy/refundPolicy.js";
import { DEFAULT_POLICY, SEVERITY, checkPolicy } from "../src/policy/settings.js";
import { checkRules, decide } from "../src/agent/rules.js";

const sure = (kind, extra = {}) => ({
  ...clearFindings, damage_kind: kind,
  signals: { evidence_usable: 0.95, visible_breakage: 0.95, damage_kind: { choice: kind, confidence: 0.9 } }, ...extra,
});
const mug = {
  line: { unit_cents: 2000, quantity: 4 }, quantity: 1, findings: sure("shattered"),
  deliveredAt: "2026-10-01T00:00:00Z", claimedAt: "2026-10-03T00:00:00Z", refundableCents: 8000,
};
const headphones = { ...mug, line: { unit_cents: 12000, quantity: 1 }, refundableCents: 12000 };
const draft = (o = {}) => draftProposal({ ...mug, ...o });
const withSignal = (key, value) => ({ ...sure("shattered"), signals: { ...sure("shattered").signals, [key]: value } });

function expectRoute(p, route, decidedBy) {
  assert.equal(p.route, route, JSON.stringify(p));
  if (decidedBy) assert.equal(p.decidedBy, decidedBy, JSON.stringify(p.reasons));
  if (route === "reject") assert.equal(p.amountCents, 0);
  return p;
}

// ---- Auto-refund ---------------------------------------------------------------------------------

test("auto-refund: clear photos of the product, a confident damage type, no flags, within limits", () => {
  const p = expectRoute(draft(), "auto_refund", "ALL_CHECKS_PASSED");
  assert.equal(p.amountCents, 2000);
  assert.deepEqual(p.reasons, []);
  assert.deepEqual([p.calculation.severity, p.calculation.percent], ["total", 100]);
});

test("minor damage gets a partial refund: scuffed $120 headphones draft $24.00, not $120", () => {
  const p = expectRoute(draftProposal({ ...headphones, findings: sure("cosmetic") }), "auto_refund");
  assert.equal(p.amountCents, 2400);
  assert.deepEqual([p.calculation.severity, p.calculation.percent, p.calculation.grossCents], ["minor", 20, 12000]);
});

test("the severity table prices every damage type, rounding down to the cent", () => {
  for (const [kind, percent] of Object.entries(DEFAULT_POLICY.refundPercent)) {
    const w = severityAmount({ unitCents: 2000, quantity: 1, damageKind: kind });
    assert.equal(w.cents, 20 * percent, kind);
    assert.equal(w.severity, SEVERITY[kind]);
  }
  assert.equal(severityAmount({ unitCents: 1999, quantity: 1, damageKind: "stain" }).cents, 599); // 599.7 -> 599
  assert.equal(severityAmount({ unitCents: 2000, quantity: 1, damageKind: "none_visible" }), null);
  // The merchant's own percentages are used, not the defaults.
  const custom = checkPolicy({ refundPercent: { cosmetic: 35 } });
  assert.equal(draftProposal({ ...headphones, findings: sure("cosmetic"), settings: custom }).amountCents, 4200);
});

test("the daily limit is inclusive: exactly at the limit still refunds automatically", () => {
  expectRoute(draft({ agentSpentCents: 13000 }), "auto_refund"); // 130 + 20 = 150
  expectRoute(draft({ agentSpentCents: 13001 }), "manual_review", "DAILY_AUTO_LIMIT_REACHED");
});

// ---- Reject: the shop's own records --------------------------------------------------------------

test("reject from the records: late report, too many units, nothing left to refund, the shop's own photo", () => {
  const cases = [
    [{ claimedAt: "2026-10-16T00:00:01Z" }, "OUTSIDE_CLAIM_WINDOW"],
    [{ quantity: 5 }, "QUANTITY_EXCEEDS_PURCHASED"],
    [{ refundableCents: 0 }, "NOTHING_REFUNDABLE"],
    [{ flags: ["PHOTO_MATCHES_CATALOG"] }, "PHOTO_MATCHES_CATALOG"],
  ];
  for (const [o, code] of cases) {
    const p = expectRoute(draft(o), "reject", code);
    assert.equal(p.hardReject, true, code);
    assert.equal(p.askForPhotos, false, code);
  }
  assert.deepEqual(cases.map((c) => c[1]).sort(), [...HARD_REJECTS].sort());
  // Exactly 14 days is inside the window; the merchant can widen it.
  expectRoute(draft({ claimedAt: "2026-10-15T00:00:00Z" }), "auto_refund");
  expectRoute(draft({ claimedAt: "2026-10-20T00:00:00Z", settings: checkPolicy({ claimWindowDays: 30 }) }), "auto_refund");
});

test("a record-based reject outranks everything the photos say", () => {
  const p = expectRoute(draft({ claimedAt: "2026-11-30T00:00:00Z", findings: { ...clearFindings, evidence_usable: "no" } }), "reject", "OUTSIDE_CLAIM_WINDOW");
  assert.equal(p.askForPhotos, false); // better photos can't fix a late report
  expectRoute(draft({ refundableCents: 0, findings: null }), "reject", "NOTHING_REFUNDABLE");
});

// ---- Reject: clear photo-check answers -----------------------------------------------------------

test("reject from the photos: unusable photos ask for clearer ones, with no amount", () => {
  const p = expectRoute(draft({ findings: { ...clearFindings, evidence_usable: "no" } }), "reject", "EVIDENCE_NOT_USABLE");
  assert.equal(p.askForPhotos, true);
  assert.equal(p.hardReject, false);
});

test("reject from the photos: clear photos the check is confident show no damage", () => {
  const p = expectRoute(draft({ findings: withSignal("visible_breakage", 0.1) }), "reject", "NO_DAMAGE_SEEN");
  assert.equal(p.hardReject, false);
  // On borderline photos the same answer is only a doubt.
  expectRoute(draft({ findings: { ...withSignal("visible_breakage", 0.1), evidence_usable: "uncertain" } }), "manual_review", "EVIDENCE_QUALITY_UNCERTAIN");
  // The merchant can make "no damage" stricter: 0.15 is no longer low enough.
  expectRoute(draft({ findings: withSignal("visible_breakage", 0.15), settings: checkPolicy({ noDamageBelow: 0.1 }) }), "manual_review", "BREAKAGE_UNCERTAIN");
});

test("reject from the photos: a different product only when two independent checks agree", () => {
  const other = { ...sure("shattered"), product_consistency: "inconsistent" };
  expectRoute(draft({ findings: { ...other, design_match: "mismatch" } }), "reject", "DIFFERENT_PRODUCT");
  expectRoute(draft({ findings: { ...other, second_check: { same: "no" } } }), "reject", "DIFFERENT_PRODUCT");
  // One check alone is a doubt for a person, not a decline.
  expectRoute(draft({ findings: other }), "manual_review", "ITEM_MAY_NOT_MATCH_ORDER");
  expectRoute(draft({ findings: { ...sure("shattered"), design_match: "mismatch" } }), "manual_review", "DESIGN_MISMATCH");
  expectRoute(draft({ findings: { ...sure("shattered"), second_check: { same: "no" } } }), "manual_review", "SECOND_CHECK_DIFFERENT_ITEM");
});

test("reject from the photos: damage the merchant's table pays 0% for", () => {
  const settings = checkPolicy({ refundPercent: { cosmetic: 0 } });
  expectRoute(draftProposal({ ...headphones, findings: sure("cosmetic"), settings }), "reject", "NO_REFUND_FOR_DAMAGE_TYPE");
  // ...but only when the check is sure that is the damage.
  const unsure = { ...sure("cosmetic"), signals: { ...sure("cosmetic").signals, damage_kind: { choice: "cosmetic", confidence: 0.4 } } };
  expectRoute(draftProposal({ ...headphones, findings: unsure, settings }), "manual_review", "DAMAGE_TYPE_UNSURE");
});

test("every reject code is covered above", () => {
  assert.deepEqual([...AI_REJECTS].sort(), ["DIFFERENT_PRODUCT", "EVIDENCE_NOT_USABLE", "NO_DAMAGE_SEEN", "NO_REFUND_FOR_DAMAGE_TYPE"]);
});

// ---- Manual review -------------------------------------------------------------------------------

test("manual review: each doubt, risk flag or limit sends the case to a person", () => {
  const cases = [
    [{ findings: null }, "AI_UNAVAILABLE"],
    [{ findings: { ...sure("shattered"), evidence_usable: "uncertain" } }, "EVIDENCE_QUALITY_UNCERTAIN"],
    [{ findings: withSignal("visible_breakage", 0.6) }, "BREAKAGE_UNCERTAIN"],
    [{ findings: withSignal("visible_breakage", 0.9), settings: checkPolicy({ minDamageSeen: 0.95 }) }, "BREAKAGE_UNCERTAIN"],
    [{ findings: { ...sure("shattered"), product_consistency: "uncertain" } }, "ITEM_MATCH_UNCERTAIN"],
    [{ findings: { ...sure("shattered"), stock_photo_suspected: true } }, "STOCK_PHOTO_SUSPECTED"],
    [{ findings: { ...sure("shattered"), instructions_in_photo: true } }, "INSTRUCTIONS_IN_PHOTO"],
    [{ findings: withSignal("damage_kind", { choice: "shattered", confidence: 0.55 }) }, "DAMAGE_TYPE_UNSURE"],
    [{ findings: sure("none_visible") }, "DAMAGE_TYPE_UNCLEAR"],
    [{ flags: ["PHOTO_REUSED_FROM_OTHER_CLAIM"] }, "PHOTO_REUSED_FROM_OTHER_CLAIM"],
    [{ flags: ["PRIOR_CLAIM_ON_ORDER"] }, "PRIOR_CLAIM_ON_ORDER"],
    [{ flags: ["REPEAT_CLAIMANT"] }, "REPEAT_CLAIMANT"],
    [{ flags: ["MULTI_UNIT_CLAIM"], quantity: 2 }, "MULTI_UNIT_CLAIM"],
    [{ refundableCents: 1500 }, "CAPPED_AT_REFUNDABLE_BALANCE"],
    [{ agentSpentCents: 14000 }, "DAILY_AUTO_LIMIT_REACHED"],
  ];
  for (const [o, code] of cases) {
    const p = expectRoute(draft(o), "manual_review", code);
    assert.ok(p.reasons.includes(code), code);
  }
  // Over the per-request automatic limit: snapped $120 headphones are worth the full $120.
  const p = expectRoute(draftProposal({ ...headphones, findings: sure("snapped") }), "manual_review", "OVER_AUTO_REFUND_LIMIT");
  assert.equal(p.amountCents, 12000); // the starting point the merchant sees
  // A capped amount is what is left on the payment.
  assert.equal(draft({ refundableCents: 1500 }).amountCents, 1500);
});

test("on manual review the drafted amount is still the severity amount, not the price", () => {
  const p = draftProposal({ ...headphones, findings: sure("cosmetic"), flags: ["REPEAT_CLAIMANT"] });
  assert.equal(p.route, "manual_review");
  assert.equal(p.amountCents, 2400);
});

// ---- Determinism and invariants ------------------------------------------------------------------

test("the same inputs always give the same outcome, amount and reasons", () => {
  const inputs = { ...headphones, findings: sure("cosmetic"), flags: ["REPEAT_CLAIMANT"], agentSpentCents: 500 };
  const first = JSON.stringify(draftProposal(inputs));
  for (let i = 0; i < 200; i++) assert.equal(JSON.stringify(draftProposal(structuredClone(inputs))), first);
});

test("over a grid of inputs: one of three outcomes, never an auto-refund past a limit or with a concern", () => {
  const kinds = [...Object.keys(SEVERITY), "none_visible"];
  const tri = ["yes", "no", "uncertain"];
  let n = 0;
  for (const kind of kinds) for (const usable of tri) for (const seen of [0.05, 0.5, 0.85, 0.99]) for (const conf of [0.3, 0.7])
    for (const consistency of ["consistent", "inconsistent", "uncertain"]) for (const flags of [[], ["REPEAT_CLAIMANT"]])
      for (const spent of [0, 14500]) for (const unit of [1999, 12000]) {
        const settings = DEFAULT_POLICY;
        const p = draftProposal({
          ...mug, line: { unit_cents: unit, quantity: 1 }, refundableCents: unit, flags, agentSpentCents: spent, settings,
          findings: { ...clearFindings, evidence_usable: usable, damage_kind: kind, product_consistency: consistency,
            signals: { visible_breakage: seen, damage_kind: { choice: kind, confidence: conf } } },
        });
        n++;
        assert.ok(ROUTES.includes(p.route));
        assert.ok(Number.isSafeInteger(p.amountCents) && p.amountCents >= 0);
        if (p.route === "reject") assert.equal(p.amountCents, 0);
        if (p.route === "auto_refund") {
          assert.deepEqual(p.reasons, []);
          assert.ok(p.amountCents > 0 && p.amountCents <= settings.autoRefundMaxCents && p.amountCents <= unit);
          assert.ok(spent + p.amountCents <= settings.dailyAutoRefundCents);
          assert.equal(p.amountCents, Math.floor((unit * settings.refundPercent[kind]) / 100));
          assert.ok(usable === "yes" && seen >= 0.8 && conf >= 0.6 && consistency === "consistent" && !flags.length);
        }
      }
  assert.ok(n > 5000);
});

// ---- Settings ------------------------------------------------------------------------------------

test("settings are checked: whole percentages, sane limits, never looser than the photo check", () => {
  assert.deepEqual(checkPolicy(), checkPolicy({}));
  assert.equal(checkPolicy({ refundPercent: { stain: 45 } }).refundPercent.stain, 45);
  assert.equal(checkPolicy({ refundPercent: { stain: 45 } }).refundPercent.cosmetic, 20);
  const bad = (o, re) => assert.throws(() => checkPolicy(o), re);
  bad({ refundPercent: { stain: 101 } }, /0 to 100/);
  bad({ refundPercent: { stain: 12.5 } }, /0 to 100/);
  bad({ refundPercent: { nope: 10 } }, /Unknown kind/);
  bad({ autoRefundMaxCents: 0 }, /automatic refund limit/);
  bad({ autoRefundMaxCents: 999999 }, /automatic refund limit/);
  bad({ autoRefundMaxCents: 5000, dailyAutoRefundCents: 4000 }, /daily limit/);
  bad({ claimWindowDays: 0 }, /window/);
  bad({ minDamageSeen: 0.7 }, /80% to 99%/);
  bad({ noDamageBelow: 0.3 }, /no-damage/);
  bad({ minDamageTypeSure: 0.4 }, /kind of damage/);
  bad({ agentDeclines: "yes" }, /true or false/);
});

// ---- The agent follows the policy ----------------------------------------------------------------

const anyDamage = checkRules({ rules: [{ skus: [], damage: [], maxRefundCents: 20000, action: "refund" }], dailyLimitCents: 50000 });
const ctx = (o = {}) => ({ route: "auto_refund", reasons: [], amountCents: 2000, sku: "MUG-CLASSIC", findings: sure("shattered"), options: 1, spentCents: 0, policy: checkPolicy(), ...o });

test("the agent refunds only auto-refund outcomes, under the policy's limits as they are now", () => {
  assert.equal(decide(anyDamage, ctx()).act, "refund");
  assert.equal(decide(anyDamage, ctx({ route: "manual_review", decidedBy: "REPEAT_CLAIMANT" })).code, "POLICY_FLAGGED");
  // Tightened after the case was drafted: the current limits win.
  assert.equal(decide(anyDamage, ctx({ policy: checkPolicy({ autoRefundMaxCents: 1500 }) })).code, "OVER_LIMIT");
  // The lower of the policy's daily limit and the rules' daily limit applies.
  const d = decide(anyDamage, ctx({ spentCents: 14000 }));
  assert.equal(d.code, "DAILY_LIMIT");
  assert.match(d.why, /\$150.00 daily limit/);
});

test("the agent declines only what the records rule out, and only when the merchant allows it", () => {
  const hard = ctx({ route: "reject", decidedBy: "OUTSIDE_CLAIM_WINDOW", hardReject: true, amountCents: 0 });
  assert.equal(decide(anyDamage, hard).act, "decline");
  assert.equal(decide(anyDamage, { ...hard, policy: checkPolicy({ agentDeclines: false }) }).code, "POLICY_REJECTED");
  // A decline on the photo check's word waits for the merchant's click.
  assert.equal(decide(anyDamage, ctx({ route: "reject", decidedBy: "NO_DAMAGE_SEEN", hardReject: false })).code, "POLICY_REJECTED");
  assert.equal(decide(anyDamage, ctx({ route: "reject", decidedBy: "EVIDENCE_NOT_USABLE", askForPhotos: true })).code, "ASKING_FOR_PHOTOS");
});

// ---- End to end ----------------------------------------------------------------------------------

let n = 0;
const pp = () => fakePayPal({ payerEmail: () => `policy${++n}@example.com` });
const rulesOn = async (t, rules = anyDamage) => {
  await t.login();
  const on = await t.merchant("POST", "/agent", { text: "Refund any damage up to $200.", rules });
  assert.equal(on.status, 200, JSON.stringify(on.body));
};
async function buy(t, sku) {
  const order = await t.call("POST", "/api/demo/orders", { body: { items: [{ sku, quantity: 1 }] } });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const cap = await t.call("POST", `/api/demo/orders/${order.body.paypalOrderId}/capture`);
  assert.equal(cap.status, 200, JSON.stringify(cap.body));
  return { orderId: order.body.id, token: cap.body.claimUrl.split("#t=")[1] };
}
const claim = async (t, o) => {
  const r = await fileClaim(t, o, { statement: "Arrived damaged." });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { claimId: r.body.claimId, statusToken: r.body.statusUrl.split("#t=")[1] };
};

test("scuffed $120 headphones: the agent refunds $24.00 through PayPal, not $120", async () => {
  const t = await setup({ pp: pp(), assess: fakeAssess(sure("cosmetic")) });
  try {
    await rulesOn(t);
    const c = await claim(t, await buy(t, "HEADPHONES-OVER"));
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.proposal.route, "auto_refund");
    assert.equal(d.proposal.amountCents, 2400);
    assert.equal(d.claim.status, "refunded");
    assert.deepEqual(t.pp.calls.refunds.map((r) => r.body.amount.value), ["24.00"]);
    // The decision records the settings version and every input, and replays to the same answer.
    const row = t.db.prepare("SELECT calc_json FROM proposals WHERE claim_id = ?").get(c.claimId);
    const calc = JSON.parse(row.calc_json);
    assert.equal(calc.decidedBy, "ALL_CHECKS_PASSED");
    assert.equal(calc.inputs.quantity, 1);
    const again = draftProposal({ line: { unit_cents: 12000, quantity: 1 }, findings: sure("cosmetic"), settings: checkPolicy(), ...calc.inputs });
    assert.deepEqual([again.route, again.amountCents, again.reasons], ["auto_refund", 2400, []]);
  } finally { t.close(); }
});

test("a late report is closed by the agent with no PayPal call, and the buyer is told why", async () => {
  const t = await setup({ pp: pp() });
  try {
    await rulesOn(t);
    const o = await buy(t, "MUG-CLASSIC");
    t.db.prepare("UPDATE orders SET delivered_at = ? WHERE id = ?").run(new Date(Date.now() - 30 * 86400e3).toISOString(), o.orderId);
    const c = await claim(t, o);
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.proposal.route, "reject");
    assert.equal(d.proposal.decidedBy, "OUTSIDE_CLAIM_WINDOW");
    assert.equal(d.claim.status, "closed");
    assert.equal(t.pp.calls.refunds.length, 0);
    const status = (await t.call("GET", `/api/claims/${c.claimId}/status`, { headers: { "X-Claim-Token": c.statusToken } })).body;
    assert.match(status.closeReason, /reporting window/);
  } finally { t.close(); }
});

test("a decline on the photo check's word waits for the merchant, even with the agent on", async () => {
  const t = await setup({ pp: pp(), assess: fakeAssess(withSignal("visible_breakage", 0.05)) });
  try {
    await rulesOn(t);
    const c = await claim(t, await buy(t, "MUG-CLASSIC"));
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.proposal.route, "reject");
    assert.equal(d.claim.status, "ready");
    assert.equal(t.pp.calls.refunds.length, 0);
    // Refunding against a reject recommendation needs the merchant's written reason.
    const noReason = await t.merchant("POST", `/claims/${c.claimId}/approve-refund`, { claimVersion: d.claim.version, proposalId: d.proposal.id, amountCents: 2000 });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error, "REASON_REQUIRED");
  } finally { t.close(); }
});

test("the daily limit stops the agent across requests; the merchant's settings change it", async () => {
  const t = await setup({ pp: pp() });
  try {
    await rulesOn(t);
    const saved = await t.merchant("PUT", "/policy", { autoRefundMaxCents: 2000, dailyAutoRefundCents: 3000 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.policy.dailyAutoRefundCents, 3000);
    const first = await claim(t, await buy(t, "MUG-CLASSIC"));
    const second = await claim(t, await buy(t, "MUG-CLASSIC"));
    assert.equal((await t.merchant("GET", `/claims/${first.claimId}`)).body.claim.status, "refunded");
    const d = (await t.merchant("GET", `/claims/${second.claimId}`)).body;
    assert.equal(d.proposal.route, "manual_review");
    assert.equal(d.proposal.decidedBy, "DAILY_AUTO_LIMIT_REACHED");
    assert.equal(d.claim.status, "ready");
    assert.equal(t.pp.calls.refunds.length, 1);
    const page = (await t.merchant("GET", "/policy")).body;
    assert.equal(page.spentCents, 2000);
    assert.equal(page.severity.find((r) => r.kind === "cosmetic").percent, 20);
    // Bad settings are refused and the old ones stay.
    const bad = await t.merchant("PUT", "/policy", { refundPercent: { cosmetic: 150 } });
    assert.equal(bad.status, 400);
    assert.equal((await t.merchant("GET", "/policy")).body.policy.dailyAutoRefundCents, 3000);
  } finally { t.close(); }
});

test("a free replacement is only offered when the damage earns a full refund", async () => {
  // A stain pays 30%: a new T-shirt would be worth more than the policy allows, so it is held back.
  let t = await setup({ pp: pp(), assess: fakeAssess({ ...sure("stain"), remedyFit: { tee_replacement: 0.9 } }) });
  try {
    await t.login();
    const c = await claim(t, await buy(t, "TEE-ORGANIC"));
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal(d.proposal.amountCents, 750); // 30% of $25
    assert.deepEqual(d.proposal.options, []);
  } finally { t.close(); }
  // A hole pays 100%: the buyer may choose the replacement instead of the money.
  t = await setup({ pp: pp(), assess: fakeAssess({ ...sure("tear_or_hole"), remedyFit: { tee_replacement: 0.9 } }) });
  try {
    await t.login();
    const c = await claim(t, await buy(t, "TEE-ORGANIC"));
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.deepEqual(d.proposal.options.map((o) => [o.title, o.refundCents]), [["Full refund", 2500], ["Get a new one, shipped free", 0]]);
  } finally { t.close(); }
});

test("a partial refund is labelled as one in the buyer's choices", () => {
  const findings = { visible_breakage: "yes", evidence_usable: "yes", remedyFit: { kit: 0.9, swap: 0.9 } };
  const remedies = [
    { id: "kit", kind: "repair_kit", title: "Keep it with a kit", item: "a kit", refundUnitCents: 300 },
    { id: "swap", kind: "replacement", title: "Get a new one", item: "a new one", refundUnitCents: 0 },
  ];
  const options = resolutionOptions({ remedies, quantity: 1, findings, amountCents: 750, fullRefund: false });
  assert.deepEqual(options.map((o) => [o.title, o.refundCents]), [["Partial refund", 750], ["Keep it with a kit", 300]]);
});
