import { test } from "node:test";
import assert from "node:assert/strict";
import { toCents, toDecimal } from "../src/money.js";
import { draftProposal, refundableBalance } from "../src/policy/refundPolicy.js";
import { normalize, normalizeMark } from "../src/ai/jev.js";
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
  assert.equal(p.route, "propose");
  assert.equal(p.amountCents, 2000);
  assert.deepEqual(p.reasons, []);
});

test("negative AI finding never auto-denies; it routes to a person", () => {
  const p = draftProposal({ ...base, findings: { ...clearFindings, visible_breakage: "no" } });
  assert.equal(p.route, "manual_review");
  assert.ok(p.reasons.includes("NO_BREAKAGE_SEEN"));
});

test("unusable photos ask for more information with no amount", () => {
  const p = draftProposal({ ...base, findings: { ...clearFindings, evidence_usable: "no" } });
  assert.equal(p.route, "request_info");
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
    item_kind: { choice: "mug_or_cup", confidence: 0.9 }, damage_kind: { choice: "shattered", confidence: 0.9 },
    same_design: { noul: 0.9 }, looks_like_stock_photo: { noul: 0.05 }, instructions_in_photo: { noul: 0.02 }, ...o,
  });
  const f = normalize(ans());
  assert.equal(f.evidence_usable, "yes");
  assert.equal(f.visible_breakage, "uncertain");
  assert.equal(f.product_consistency, "consistent");
  assert.equal(normalize(ans({ item_kind: { choice: "other_tableware", confidence: 1 } })).product_consistency, "inconsistent");
  assert.equal(normalize(ans({ item_kind: { choice: "mug_or_cup", confidence: 0.3 } })).product_consistency, "uncertain");
  assert.equal(normalize(ans({ same_kind_as_catalog: { noul: 0.6 } })).product_consistency, "consistent");
  assert.equal(normalize(ans({ same_design: { noul: 0.1 } })).design_match, "mismatch");
  assert.equal(normalize(ans({ same_design: { noul: 0.3 } })).design_match, "uncertain");
  assert.equal(normalize(ans({ instructions_in_photo: { noul: 0.6 } })).instructions_in_photo, true);
  assert.equal(normalize(ans({ same_kind_as_catalog: { noul: 0.05 } })).product_consistency, "inconsistent");
});

test("unknown provider statuses are reconciled, never treated as success", () => {
  assert.equal(mapProviderStatus("COMPLETED"), "COMPLETED");
  assert.equal(mapProviderStatus("PENDING"), "PENDING");
  assert.equal(mapProviderStatus("CANCELLED"), "FAILED");
  assert.equal(mapProviderStatus("SOMETHING_NEW"), "UNKNOWN");
  assert.equal(mapProviderStatus(undefined), "UNKNOWN");
});

test("damage boxes become marks only when Jev is confident and the box points somewhere", () => {
  const a = (noul, box, confidence = 0.4) => ({ damage_shown: { noul }, damage_area: { box, confidence } });
  const chip = { top: 0.46, bottom: 0.56, left: 0.46, right: 0.63 };
  assert.deepEqual(normalizeMark(a(0.9, chip)), { box: chip, damageShown: 0.9, confidence: 0.4 });
  assert.equal(normalizeMark(a(0.6, chip)), null, "unsure the photo shows damage");
  assert.equal(normalizeMark(a(0.99, { top: 0, bottom: 1, left: 0.02, right: 0.98 })), null, "box covers the whole photo");
  assert.equal(normalizeMark(a(0.99, { top: NaN, bottom: 1, left: 0, right: 1 })), null);
  assert.equal(normalizeMark({ damage_shown: { noul: 0.9 } }), null);
  // Swapped edges are put in order; a hairline box is widened so it can be seen, staying in the photo.
  const thin = normalizeMark(a(0.9, { top: 0.9, bottom: 0.1, left: 0.31, right: 0.32 }));
  assert.deepEqual(thin.box, { top: 0.1, bottom: 0.9, left: 0.275, right: 0.355 });
  const edge = normalizeMark(a(0.9, { top: 0.98, bottom: 1.2, left: -0.1, right: 0.01 }));
  assert.deepEqual(edge.box, { top: 0.92, bottom: 1, left: 0, right: 0.08 });
});
