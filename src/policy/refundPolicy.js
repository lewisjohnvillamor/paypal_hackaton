// Refund policy v3: a pure function from recorded facts to exactly one of three outcomes. No I/O,
// no model calls. The AI only supplies signals (what the photos show and how sure it is); every
// decision below is a fixed rule over those signals, the shop's own records and the merchant's
// settings (src/policy/settings.js), so the same inputs always give the same outcome and amount.
import { DEFAULT_POLICY, SEVERITY } from "./settings.js";

export const POLICY_VERSION = "policy-v3";
export const CLAIM_WINDOW_DAYS = DEFAULT_POLICY.claimWindowDays;

const DAY = 24 * 60 * 60 * 1000;

// Outcomes:
//   "auto_refund"   every check passed: the computed amount can be refunded with no judgment call
//                   (by the refund agent when it is on, or the merchant's one click)
//   "manual_review" something is doubtful, risky or over a limit: a person decides
//   "reject"        no refund on this request; `askForPhotos` when clearer photos could change that
// Older proposals used "propose" and "request_info"; read them with isAutoRoute / askForPhotos.
export const ROUTES = ["auto_refund", "manual_review", "reject"];
export const isAutoRoute = (route) => route === "auto_refund" || route === "propose";

// Rejections from the shop's own records, not from the AI. Only these may be closed by the agent.
export const HARD_REJECTS = ["QUANTITY_EXCEEDS_PURCHASED", "OUTSIDE_CLAIM_WINDOW", "NOTHING_REFUNDABLE", "PHOTO_MATCHES_CATALOG"];
// Rejections from clear photo-check answers. Drafted for the merchant's click; never automatic.
export const AI_REJECTS = ["EVIDENCE_NOT_USABLE", "NO_DAMAGE_SEEN", "DIFFERENT_PRODUCT", "NO_REFUND_FOR_DAMAGE_TYPE"];
// Record-based risk flags (src/claims.js riskFlags). Each one sends the case to a person.
export const RISK_FLAGS = ["PHOTO_REUSED_FROM_OTHER_CLAIM", "PRIOR_CLAIM_ON_ORDER", "REPEAT_CLAIMANT", "MULTI_UNIT_CLAIM"];

// The amount a damage type is worth: unit price x units x the merchant's percentage, rounded down
// to the cent so rounding never favours a refund.
export function severityAmount({ unitCents, quantity, damageKind, settings = DEFAULT_POLICY }) {
  const percent = settings.refundPercent[damageKind];
  if (!SEVERITY[damageKind] || percent == null) return null;
  return { severity: SEVERITY[damageKind], percent, cents: Math.floor((unitCents * quantity * percent) / 100) };
}

// The breakage signal as a number; older findings without signals fall back to their yes/no.
const breakageSignal = (f) => f.signals?.visible_breakage ?? { yes: 1, no: 0 }[f.visible_breakage] ?? 0.5;

// facts: { line, quantity, findings, deliveredAt, claimedAt, refundableCents, flags, settings,
//          agentSpentCents (what the agent sent in the last 24 hours, for the daily limit) }
// Returns { route, amountCents, decidedBy, reasons, askForPhotos, hardReject, calculation, ... }.
// `decidedBy` is the one rule that settled the outcome; `reasons` lists every concern found.
export function draftProposal({ line, quantity, findings, deliveredAt, claimedAt, refundableCents, flags = [], settings = DEFAULT_POLICY, agentSpentCents = 0 }) {
  const hard = [], aiReject = [], review = [];
  const unitCents = line.unit_cents;
  const claimed = Math.min(quantity, line.quantity);
  const grossCents = unitCents * claimed;
  const refundable = Math.max(0, refundableCents);

  // 1. The shop's records.
  if (quantity > line.quantity) hard.push("QUANTITY_EXCEEDS_PURCHASED");
  const days = (Date.parse(claimedAt) - Date.parse(deliveredAt)) / DAY;
  if (!(days <= settings.claimWindowDays)) hard.push("OUTSIDE_CLAIM_WINDOW");
  if (refundable === 0) hard.push("NOTHING_REFUNDABLE");
  if (flags.includes("PHOTO_MATCHES_CATALOG")) hard.push("PHOTO_MATCHES_CATALOG");
  for (const f of flags) if (RISK_FLAGS.includes(f)) review.push(f);

  // 2. What the photos show, and how sure the check is.
  let worth = null;
  if (!findings) review.push("AI_UNAVAILABLE");
  else if (findings.evidence_usable === "no") aiReject.push("EVIDENCE_NOT_USABLE");
  else {
    const usable = findings.evidence_usable === "yes";
    if (!usable) review.push("EVIDENCE_QUALITY_UNCERTAIN");
    const seen = breakageSignal(findings);
    if (seen <= settings.noDamageBelow) (usable ? aiReject : review).push(usable ? "NO_DAMAGE_SEEN" : "NO_BREAKAGE_SEEN");
    else if (seen < settings.minDamageSeen) review.push("BREAKAGE_UNCERTAIN");

    // Two independent checks must agree before "different product" declines; one alone is a doubt.
    const otherKind = findings.product_consistency === "inconsistent";
    const otherDesign = findings.design_match === "mismatch" || findings.second_check?.same === "no";
    if (otherKind && otherDesign) aiReject.push("DIFFERENT_PRODUCT");
    else {
      if (otherKind) review.push("ITEM_MAY_NOT_MATCH_ORDER");
      if (findings.product_consistency === "uncertain") review.push("ITEM_MATCH_UNCERTAIN");
      if (findings.design_match === "mismatch") review.push("DESIGN_MISMATCH");
      if (findings.second_check?.same === "no") review.push("SECOND_CHECK_DIFFERENT_ITEM");
    }
    if (!itemConfirmed(findings)) review.push("OFFERS_HELD_ITEM_MISMATCH");
    if (findings.stock_photo_suspected) review.push("STOCK_PHOTO_SUSPECTED");
    if (findings.instructions_in_photo) review.push("INSTRUCTIONS_IN_PHOTO");

    // 3. How bad the damage is, from the merchant's severity table.
    const kindSure = (findings.signals?.damage_kind?.confidence ?? 0) >= settings.minDamageTypeSure;
    worth = severityAmount({ unitCents, quantity: claimed, damageKind: findings.damage_kind, settings });
    if (seen > settings.noDamageBelow) {
      if (!worth) review.push("DAMAGE_TYPE_UNCLEAR");
      else if (!kindSure) review.push("DAMAGE_TYPE_UNSURE");
      else if (worth.percent === 0) aiReject.push("NO_REFUND_FOR_DAMAGE_TYPE");
    }
  }

  // 4. The amount, and the limits on the automatic path.
  const proposedCents = worth ? worth.cents : grossCents;
  const amountCents = Math.min(proposedCents, refundable);
  if (amountCents < proposedCents && refundable > 0) review.push("CAPPED_AT_REFUNDABLE_BALANCE");
  if (amountCents > settings.autoRefundMaxCents) review.push("OVER_AUTO_REFUND_LIMIT");
  else if (agentSpentCents + amountCents > settings.dailyAutoRefundCents) review.push("DAILY_AUTO_LIMIT_REACHED");

  const route = hard.length || aiReject.length ? "reject" : review.length || !(amountCents > 0) ? "manual_review" : "auto_refund";
  const decidedBy = hard[0] ?? aiReject[0] ?? review[0] ?? (route === "manual_review" ? "NO_AMOUNT" : "ALL_CHECKS_PASSED");
  return {
    policyVersion: POLICY_VERSION,
    route,
    amountCents: route === "reject" ? 0 : amountCents,
    currency: "USD",
    decidedBy,
    reasons: [...hard, ...aiReject, ...review],
    askForPhotos: route === "reject" && !hard.length && aiReject[0] === "EVIDENCE_NOT_USABLE",
    hardReject: hard.length > 0,
    calculation: {
      unitCents, quantity: claimed, grossCents, refundableCents,
      damageKind: findings?.damage_kind ?? null, severity: worth?.severity ?? null, percent: worth?.percent ?? null,
      severityCents: worth?.cents ?? null, amountCents: route === "reject" ? 0 : amountCents,
      autoRefundMaxCents: settings.autoRefundMaxCents, dailyAutoRefundCents: settings.dailyAutoRefundCents, agentSpentCents,
    },
  };
}

// A proposal that asks the buyer for clearer photos, old ("request_info") or new.
export const askForPhotos = (proposal) => proposal.route === "request_info" || !!proposal.askForPhotos;

// The product-match layer. Two independent checks compare the photos with the catalog photo: Jev's
// kind and design questions, and Claude Haiku's second check (findings.second_check, when the
// server has a key). If either says it is a different product, nothing but the plain refund is put
// in front of the buyer, and the merchant decides; a repair kit for an item the shop never sold
// makes no sense. "Unsure" from either does not block, since broken pieces rarely look identical.
export function itemConfirmed(findings) {
  return !!findings && findings.design_match !== "mismatch" && findings.product_consistency !== "inconsistent" &&
    findings.second_check?.same !== "no";
}

// Remedies Jev judged to fit at least this well are offered. Over two live runs per photo, the
// kintsugi kits scored 0.73-0.83 on a chipped mug and at most 0.18 on mugs in pieces, and the
// replacement 0.43-0.97 on broken mugs; see hackathon/STATE.md.
export const REMEDY_FIT = 0.5;
export const MAX_OFFERED_REMEDIES = 3;

// Resolution options the merchant can put to the buyer instead of deciding alone: the full refund
// (always first, always available) and up to three remedies from the merchant's library that Jev
// judged to fit the damage in the photos, best fit first. A remedy's refund is the merchant's
// per-unit amount, capped by the drafted refund; it can be $0 (a replacement). A replacement is
// only offered when the damage earns a full refund: for damage the policy pays part of the price
// for (scratches, a stain), a new item would be worth more than the policy allows. Pure: no I/O.
export function resolutionOptions({ remedies = [], quantity, findings, amountCents, fullRefund = true }) {
  if (!findings || !(amountCents > 0) || findings.visible_breakage !== "yes" || findings.evidence_usable === "no") return [];
  if (!itemConfirmed(findings)) return [];
  const fit = findings.remedyFit ?? {};
  const picked = remedies
    .filter((r) => typeof fit[r.id] === "number" && fit[r.id] >= REMEDY_FIT)
    .filter((r) => fullRefund || r.kind !== "replacement")
    .sort((a, b) => fit[b.id] - fit[a.id])
    .slice(0, MAX_OFFERED_REMEDIES)
    .map((r) => ({
      id: r.id, kind: r.kind, title: r.title, item: r.item, fit: fit[r.id],
      refundCents: Math.min(r.refundUnitCents * quantity, amountCents),
    }))
    .filter((o) => o.refundCents < amountCents); // a remedy worth the full refund adds nothing
  return picked.length ? [{ id: "refund", kind: "refund", title: fullRefund ? "Full refund" : "Partial refund", refundCents: amountCents }, ...picked] : [];
}

// Funds still refundable on a capture: captured minus completed refunds minus open reservations.
export function refundableBalance(capturedCents, ops) {
  const held = ops
    .filter((o) => ["COMPLETED", "SUBMITTING", "PENDING", "UNKNOWN"].includes(o.status))
    .reduce((s, o) => s + o.amount_cents, 0);
  return capturedCents - held;
}
