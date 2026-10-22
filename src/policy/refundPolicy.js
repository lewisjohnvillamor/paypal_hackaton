// Refund policy v2: a pure function from recorded facts to a draft proposal. No I/O, no model calls.
// The merchant always decides; this only drafts and explains.
export const POLICY_VERSION = "policy-v2";
export const CLAIM_WINDOW_DAYS = 14;

const DAY = 24 * 60 * 60 * 1000;

// route: "propose"      clear evidence, draft the unit refund for one-click approval
//        "manual_review" a person must look; the unit amount is shown as a starting point only
//        "request_info"  photos are not usable; ask the buyer for better ones
// flags: record-based risk signals (photo reuse, repeat claimant, ...). Any flag or doubtful
// finding means manual review; nothing here ever produces a denial.
export function draftProposal({ line, quantity, findings, deliveredAt, claimedAt, refundableCents, flags = [] }) {
  const reasons = [...flags];
  const unitCents = line.unit_cents;
  const claimed = Math.min(quantity, line.quantity);
  const grossCents = unitCents * claimed;
  const amountCents = Math.min(grossCents, Math.max(0, refundableCents));

  if (quantity > line.quantity) reasons.push("QUANTITY_EXCEEDS_PURCHASED");
  if (amountCents < grossCents) reasons.push("CAPPED_AT_REFUNDABLE_BALANCE");

  const days = (Date.parse(claimedAt) - Date.parse(deliveredAt)) / DAY;
  if (!(days <= CLAIM_WINDOW_DAYS)) reasons.push("OUTSIDE_CLAIM_WINDOW");

  let route;
  if (!findings) {
    reasons.push("AI_UNAVAILABLE");
    route = "manual_review";
  } else if (findings.evidence_usable === "no") {
    reasons.push("EVIDENCE_NOT_USABLE");
    route = "request_info";
  } else {
    if (findings.evidence_usable === "uncertain") reasons.push("EVIDENCE_QUALITY_UNCERTAIN");
    if (findings.visible_breakage === "no") reasons.push("NO_BREAKAGE_SEEN"); // never an automatic denial
    if (findings.visible_breakage === "uncertain") reasons.push("BREAKAGE_UNCERTAIN");
    if (findings.product_consistency === "inconsistent") reasons.push("ITEM_MAY_NOT_MATCH_ORDER");
    if (findings.product_consistency === "uncertain") reasons.push("ITEM_MATCH_UNCERTAIN");
    if (findings.design_match === "mismatch") reasons.push("DESIGN_MISMATCH");
    if (findings.stock_photo_suspected) reasons.push("STOCK_PHOTO_SUSPECTED");
    if (findings.instructions_in_photo) reasons.push("INSTRUCTIONS_IN_PHOTO");
    const clear = findings.evidence_usable === "yes" && findings.visible_breakage === "yes" &&
      findings.product_consistency === "consistent";
    route = clear && reasons.length === 0 ? "propose" : "manual_review";
  }
  if (amountCents === 0) route = "manual_review";

  return {
    policyVersion: POLICY_VERSION,
    route,
    amountCents: route === "request_info" ? 0 : amountCents,
    currency: "USD",
    reasons,
    calculation: { unitCents, quantity: claimed, grossCents, refundableCents, amountCents },
  };
}

// Funds still refundable on a capture: captured minus completed refunds minus open reservations.
export function refundableBalance(capturedCents, ops) {
  const held = ops
    .filter((o) => ["COMPLETED", "SUBMITTING", "PENDING", "UNKNOWN"].includes(o.status))
    .reduce((s, o) => s + o.amount_cents, 0);
  return capturedCents - held;
}
