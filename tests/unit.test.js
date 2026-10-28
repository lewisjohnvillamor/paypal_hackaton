import { test } from "node:test";
import assert from "node:assert/strict";
import { toCents, toDecimal } from "../src/money.js";
import { draftProposal, refundableBalance } from "../src/policy/refundPolicy.js";
import { normalize, normalizeLocation } from "../src/ai/jev.js";
import { mapProviderStatus } from "../src/refunds/execute.js";
import { clearFindings } from "./helpers.js";

test("money converts between decimal strings and integer cents without floats", () => {
  assert.equal(toCents("20.00"), 2000);
  assert.equal(toCents("0.1"), 10);
  assert.equal(toCents("80"), 8000);
  assert.equal(toDecimal(2000), "20.00");
  assert.equal(toDecimal(5), "0.05");
  for (const bad of ["-1", "1.234", "abc", "", "1e3"]) assert.throws(() => toCents(bad));
  assert.throws(() => toDecimal(-1));
  assert.throws(() => toDecimal(1.5));
});

const base = {
  line: { unit_cents: 2000, quantity: 4 },
  quantity: 1,
  findings: clearFindings,
  deliveredAt: "2026-10-01T00:00:00Z",
  claimedAt: "2026-10-03T00:00:00Z",
  refundableCents: 8000,
};

test("clear damage drafts one unit refund", () => {
  const p = draftProposal(base);
  assert.equal(p.route, "auto_refund");
  assert.equal(p.amountCents, 2000);
  assert.deepEqual(p.reasons, []);
});

test("a confident no-damage finding on clear photos drafts a decline the merchant confirms", () => {
  const p = draftProposal({ ...base, findings: { ...clearFindings, visible_breakage: "no", signals: { ...clearFindings.signals, visible_breakage: 0.05 } } });
  assert.equal(p.route, "reject");
  assert.equal(p.decidedBy, "NO_DAMAGE_SEEN");
  assert.equal(p.hardReject, false); // the agent never closes on the AI's word alone
});

test("unusable photos draft no refund and ask the buyer for clearer ones", () => {
  const p = draftProposal({ ...base, findings: { ...clearFindings, evidence_usable: "no" } });
  assert.equal(p.route, "reject");
  assert.equal(p.askForPhotos, true);
  assert.equal(p.amountCents, 0);
});

test("missing AI result means manual review, not a manufactured finding", () => {
  const p = draftProposal({ ...base, findings: null });
  assert.equal(p.route, "manual_review");
  assert.ok(p.reasons.includes("AI_UNAVAILABLE"));
});

test("uncertain item match, late claims and capped balances go to manual review", () => {
  assert.equal(draftProposal({ ...base, findings: { ...clearFindings, product_consistency: "uncertain" } }).route, "manual_review");
  assert.ok(draftProposal({ ...base, claimedAt: "2026-10-30T00:00:00Z" }).reasons.includes("OUTSIDE_CLAIM_WINDOW"));
  const capped = draftProposal({ ...base, quantity: 2, refundableCents: 3000 });
  assert.equal(capped.amountCents, 3000);
  assert.equal(capped.route, "manual_review");
});

test("refundable balance subtracts completed refunds and open reservations, not failures", () => {
  const ops = [
    { status: "COMPLETED", amount_cents: 2000 },
    { status: "UNKNOWN", amount_cents: 1000 },
    { status: "FAILED", amount_cents: 5000 },
  ];
  assert.equal(refundableBalance(8000, ops), 5000);
});

test("Jev answers normalize to yes/no/uncertain with two signals for item match", () => {
  const ans = (o) => ({
    evidence_usable: { noul: 0.95 }, visible_breakage: { noul: 0.5 }, same_kind_as_catalog: { noul: 0.9 },
    item_kind: { choice: "ordered_kind", confidence: 0.9 }, damage_kind: { choice: "shattered", confidence: 0.9 },
    same_design: { noul: 0.9 }, looks_like_stock_photo: { noul: 0.05 }, instructions_in_photo: { noul: 0.02 }, ...o,
  });
  const f = normalize(ans());
  assert.equal(f.evidence_usable, "yes");
  assert.equal(f.visible_breakage, "uncertain");
  assert.equal(f.product_consistency, "consistent");
  assert.equal(normalize(ans({ item_kind: { choice: "other_item", confidence: 1 } })).product_consistency, "inconsistent");
  assert.equal(normalize(ans({ item_kind: { choice: "mug_or_cup", confidence: 0.3 } })).product_consistency, "uncertain");
  assert.equal(normalize(ans({ same_kind_as_catalog: { noul: 0.6 } })).product_consistency, "consistent");
  assert.equal(normalize(ans({ same_design: { noul: 0.1 } })).design_match, "mismatch");
  assert.equal(normalize(ans({ same_design: { noul: 0.3 } })).design_match, "uncertain");
  assert.equal(normalize(ans({ instructions_in_photo: { noul: 0.6 } })).instructions_in_photo, true);
  assert.equal(normalize(ans({ same_kind_as_catalog: { noul: 0.05 } })).product_consistency, "inconsistent");
});

test("a damage box is kept only when the same call is confident the photo shows damage", () => {
  const area = { box: { top: 0.4, bottom: 0.6, left: 0.2, right: 0.5 } };
  assert.deepEqual(normalizeLocation({ damaged: { noul: 0.95 }, damage_area: area }), { damaged: 0.95, box: area.box });
  // Jev returns a box even for an intact mug; without confident damage nothing is drawn.
  assert.equal(normalizeLocation({ damaged: { noul: 0.55 }, damage_area: area }).box, null);
  assert.deepEqual(normalizeLocation({ damaged: { noul: 0.75 }, damage_area: area }).box, area.box);
  // A box around (almost) the whole photo points at nothing.
  assert.equal(normalizeLocation({ damaged: { noul: 0.99 }, damage_area: { box: { top: -0.1, bottom: 1.3, left: 0, right: 1 } } }).box, null);
  // A hairline box is widened about its centre and stays inside the photo.
  const thin = normalizeLocation({ damaged: { noul: 0.9 }, damage_area: { box: { top: 0.2, bottom: 0.6, left: 0.31, right: 0.32 } } }).box;
  assert.ok(Math.abs(thin.right - thin.left - 0.08) < 1e-9 && Math.abs((thin.left + thin.right) / 2 - 0.315) < 1e-9);
  assert.equal(normalizeLocation({ damaged: { noul: 0.9 }, damage_area: { box: { top: 0.1, bottom: 0.5, left: 0.98, right: 1 } } }).box.right, 1);
  assert.equal(normalizeLocation({ damaged: { noul: 0.9 }, damage_area: { box: { top: 0.5, bottom: 0.5, left: 0, right: 1 } } }), null);
  assert.equal(normalizeLocation({ damaged: { noul: 0.9 } }), null);
  assert.equal(normalizeLocation(undefined), null);
});

test("unknown provider statuses are reconciled, never treated as success", () => {
  assert.equal(mapProviderStatus("COMPLETED"), "COMPLETED");
  assert.equal(mapProviderStatus("PENDING"), "PENDING");
  assert.equal(mapProviderStatus("CANCELLED"), "FAILED");
  assert.equal(mapProviderStatus("SOMETHING_NEW"), "UNKNOWN");
  assert.equal(mapProviderStatus(undefined), "UNKNOWN");
});
