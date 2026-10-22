// The agent timeline: every step on a case, in order, saying who acted (the buyer, Jev, the refund
// policy, the merchant, PayPal) and what they saw or did. Built from the audit log plus the stored
// assessment and proposal behind each review, so it never shows anything that was not recorded.
import { REASON_TEXT } from "./reasons.js";
import { toDecimal } from "./money.js";

const json = (s) => (s ? JSON.parse(s) : null);
const usd = (cents) => `$${toDecimal(cents)}`;
const pct = (p) => (typeof p === "number" ? ` (${Math.round(p * 100)}%)` : "");
const ROUTE = { propose: "suggests a one-click refund", manual_review: "needs your judgment", request_info: "asks the buyer for clearer photos" };
const WORD = { yes: "yes", no: "no", uncertain: "unsure", consistent: "yes", inconsistent: "no" };
const DAMAGE = { shattered: "broken into pieces", handle_off: "handle snapped off", crack_or_chip: "a crack or chip", none_visible: "no damage visible" };
const OPTION = { refund: "Full refund", repair: "Keep it and mend it with kintsugi", repair_gold: "Mend it in 24k gold leaf" };

function reviewSteps(db, claimId, h, photoNumber) {
  const a = db.prepare("SELECT * FROM assessments WHERE claim_id = ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1").get(claimId, h.at);
  if (!a) return [];
  const p = db.prepare("SELECT * FROM proposals WHERE assessment_id = ?").get(a.id);
  const sent = json(a.photo_ids_json) ?? [];
  const steps = [];
  const f = json(a.findings_json);
  if (a.error || !f) {
    steps.push({ at: h.at, actor: "jev", title: "Jev could not review the photos", detail: `${a.error ?? "No answer"}. Nothing was filled in; a person reviews it.` });
  } else {
    const s = f.signals ?? {};
    steps.push({
      at: a.created_at, actor: "jev",
      title: `Jev checked ${sent.length} photo${sent.length === 1 ? "" : "s"} against your catalog photo`,
      detail: [
        `Damage visible: ${WORD[f.visible_breakage]}${pct(s.visible_breakage)}`,
        `damage type: ${DAMAGE[f.damage_kind] ?? f.damage_kind}${pct(s.damage_kind?.confidence)}`,
        `same kind of product: ${WORD[f.product_consistency]}`,
        `photos usable: ${WORD[f.evidence_usable]}`,
      ].join(" · "),
      meta: `${a.model} · ${a.latency_ms} ms · photos only, never the buyer's words`,
    });
    const boxed = (f.locations ?? []).map((l, i) => (l?.box ? photoNumber(sent[i]) : null)).filter(Boolean);
    if (boxed.length) {
      steps.push({ at: a.created_at, actor: "jev", title: `Jev outlined the damage in photo ${boxed.join(", ")}`, detail: "Shown on the photos above. Outlines never change the amount." });
    }
  }
  if (p) {
    const calc = json(p.calc_json);
    const reasons = calc.reasons ?? [];
    steps.push({
      at: p.created_at, actor: "policy",
      title: p.route === "request_info" ? `Policy ${ROUTE[p.route]}` : `Policy drafted ${usd(p.amount_cents)} and ${ROUTE[p.route]}`,
      detail: reasons.length ? reasons.map((r) => REASON_TEXT[r] ?? r).join(" ") : "Clear evidence, inside the 14-day window, within the refundable balance.",
      meta: p.policy_version,
    });
    if ((calc.options ?? []).length > 1) {
      steps.push({
        at: p.created_at, actor: "policy", title: "This damage can be mended, so the buyer could be offered a choice",
        detail: calc.options.map((o) => `${OPTION[o.id] ?? o.id}: ${usd(o.refundCents)} back`).join(" · "),
      });
    }
  }
  return steps;
}

export function agentTimeline(db, claimId) {
  const evidence = db.prepare("SELECT id FROM evidence WHERE claim_id = ? ORDER BY created_at").all(claimId).map((e) => e.id);
  const photoNumber = (id) => evidence.indexOf(id) + 1 || null;
  const history = db.prepare("SELECT actor, type, payload, at FROM audit WHERE claim_id = ? ORDER BY id").all(claimId);
  const steps = [];
  for (const h of history) {
    const x = json(h.payload) ?? {};
    const who = h.actor === "buyer" ? "buyer" : h.actor === "system" ? "system" : "merchant";
    const add = (s) => steps.push({ at: h.at, actor: who, ...s });
    switch (h.type) {
      case "claim.submitted": add({ title: `Buyer reported ${x.quantity > 1 ? `${x.quantity} damaged items` : "a damaged item"}` }); break;
      case "evidence.added": add({ title: `Buyer sent ${x.count} photo${x.count === 1 ? "" : "s"}` }); break;
      case "assessment.completed":
      case "assessment.failed": steps.push(...reviewSteps(db, claimId, h, photoNumber)); break;
      case "claim.info_requested": add({ title: "You asked for more photos", detail: x.message }); break;
      case "claim.closed": add({ title: "You closed it without a refund", detail: x.reason }); break;
      case "offer.sent": add({ title: "You let the buyer choose", detail: "This approved every amount on the list." }); break;
      case "offer.accepted": add({ title: `Buyer chose: ${OPTION[x.option] ?? x.option}`, detail: x.kit ? `$${x.refund} back; send the ${x.kit}.` : `$${x.refund} back.` }); break;
      case "refund.approved":
        // A buyer's pick already has its own step; the reservation behind it adds nothing new.
        if (who !== "buyer") add({ title: `You approved ${usd(x.amountCents)}`, detail: x.overrideReason });
        break;
      case "refund.completed": steps.push({ at: h.at, actor: "paypal", title: "PayPal completed the refund", meta: x.refundId }); break;
      case "refund.pending": steps.push({ at: h.at, actor: "paypal", title: "PayPal is still processing the refund", meta: x.refundId }); break;
      case "refund.failed": steps.push({ at: h.at, actor: "paypal", title: "PayPal declined the refund", detail: x.error, meta: x.debugId }); break;
      case "refund.unknown": steps.push({ at: h.at, actor: "paypal", title: "PayPal's answer was unclear; the money stays reserved until it is checked", detail: x.error }); break;
      case "refund.network_error": steps.push({ at: h.at, actor: "paypal", title: "Could not reach PayPal; it will be checked again", detail: x.message }); break;
      case "paypal.external_refund_detected": steps.push({ at: h.at, actor: "paypal", title: "PayPal shows a refund made outside Refund Relay", detail: "Refunds here are paused until you reconcile it." }); break;
      case "paypal.capture_not_refundable": steps.push({ at: h.at, actor: "paypal", title: `PayPal reports the payment as ${x.captureStatus}`, detail: "It cannot be refunded here." }); break;
      case "evidence.deleted_retention": add({ title: "Photos deleted under the retention policy" }); break;
      default: add({ title: h.type });
    }
  }
  return steps;
}
