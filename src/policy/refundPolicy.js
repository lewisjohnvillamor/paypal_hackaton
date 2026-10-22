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

// Damage the buyer can mend at home. A shattered mug, or a case where the model is unsure what
// it saw, only ever gets the plain refund.
const REPAIRABLE = ["handle_off", "crack_or_chip"];

// Resolution options the merchant can put to the buyer instead of deciding alone: the full refund
// (always first, always available) and, for repairable damage, keeping the item with a repair kit
// and a smaller refund. An upgraded kit is sold by taking its price off the refund, so the buyer
// never pays a second time. Pure: amounts come from the catalog and the drafted refund.
export function resolutionOptions({ repair, quantity, findings, amountCents }) {
  if (!repair || !findings || !(amountCents > 0)) return [];
  const kind = findings.signals?.damage_kind;
  const repairable = findings.visible_breakage === "yes" && REPAIRABLE.includes(findings.damage_kind) &&
    (kind?.confidence ?? 0) >= 0.5;
  if (!repairable) return [];
  const options = [{ id: "refund", kind: "refund", refundCents: amountCents }];
  const repairCents = Math.min(repair.refundUnitCents * quantity, amountCents);
  if (repairCents > 0 && repairCents < amountCents) {
    options.push({ id: "repair", kind: "repair", kit: repair.kit, refundCents: repairCents });
    const up = repair.upgrade;
    const upCents = up ? repairCents - up.unitCents * quantity : 0;
    if (up && upCents > 0) options.push({ id: "repair_gold", kind: "repair", kit: up.kit, refundCents: upCents, kitPriceCents: up.unitCents * quantity });
  }
  return options.length > 1 ? options : [];
}

// Funds still refundable on a capture: captured minus completed refunds minus open reservations.
export function refundableBalance(capturedCents, ops) {
  const held = ops
    .filter((o) => ["COMPLETED", "SUBMITTING", "PENDING", "UNKNOWN"].includes(o.status))
    .reduce((s, o) => s + o.amount_cents, 0);
  return capturedCents - held;
}
