// The agent timeline: every step on a case, in order, saying who acted (the buyer, Jev, the refund
// policy, the merchant, PayPal) and what they saw or did. Built from the audit log plus the stored
// assessment and proposal behind each review, so it never shows anything that was not recorded.
import { REASON_TEXT } from "./reasons.js";
import { toDecimal } from "./money.js";
import { DAMAGE_LABELS as DAMAGE } from "./kinds.js";

const json = (s) => (s ? JSON.parse(s) : null);
const usd = (cents) => `$${toDecimal(cents)}`;
const pct = (p) => (typeof p === "number" ? ` (${Math.round(p * 100)}%)` : "");
const ROUTE = {
  auto_refund: "marked it safe to refund automatically", propose: "suggests a one-click refund", manual_review: "needs your judgment",
  reject: "advises no refund", request_info: "advises asking the buyer for clearer photos",
};
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const WORD = { yes: "yes", no: "no", uncertain: "unsure", consistent: "yes", inconsistent: "no" };


function reviewSteps(db, claimId, h, photoNumber) {
  const a = db.prepare("SELECT * FROM assessments WHERE claim_id = ? AND created_at <= ? ORDER BY created_at DESC LIMIT 1").get(claimId, h.at);
  if (!a) return [];
  const p = db.prepare("SELECT * FROM proposals WHERE assessment_id = ?").get(a.id);
  const sent = json(a.photo_ids_json) ?? [];
  const steps = [];
  const f = json(a.findings_json);
  if (a.error || !f) {
    steps.push({ at: h.at, actor: "jev", title: "The AI photo check could not review the photos", detail: `${a.error ?? "No answer"}. Nothing was filled in; a person reviews it.` });
  } else {
    const s = f.signals ?? {};
    steps.push({
      at: a.created_at, actor: "jev",
      title: `AI checked ${sent.length} photo${sent.length === 1 ? "" : "s"} against your catalog photo`,
      detail: [
        `Damage visible: ${WORD[f.visible_breakage]}${pct(s.visible_breakage)}`,
        `damage type: ${DAMAGE[f.damage_kind] ?? f.damage_kind}${pct(s.damage_kind?.confidence)}`,
        `same kind of product: ${WORD[f.product_consistency]}`,
        `photos usable: ${WORD[f.evidence_usable]}`,
      ].join(" · "),
      meta: `${a.model} · ${a.latency_ms} ms · photos only, never the buyer's words`,
    });
    if (f.second_check) {
      const c = f.second_check;
      steps.push({ at: a.created_at, actor: "claude", title: `A second AI check: ${{ yes: "same product as your catalog photo", no: "a different product from your catalog photo", unsure: "can't tell if it is your product" }[c.same]}`,
        detail: c.differences, meta: `${c.model} · ${c.latencyMs} ms · photos and catalog photo only` });
    }
    const boxed = (f.locations ?? []).map((l, i) => (l?.box ? photoNumber(sent[i]) : null)).filter(Boolean);
    if (boxed.length) {
      steps.push({ at: a.created_at, actor: "jev", title: `AI outlined the damage in photo ${boxed.join(", ")}`, detail: "Shown on the photos above. Outlines never change the amount." });
    }
  }
  if (p) {
    const calc = json(p.calc_json);
    const reasons = calc.reasons ?? [];
    const c = calc.calculation ?? {};
    const priced = c.percent != null && p.route !== "reject"
      ? ` ${cap(DAMAGE[c.damageKind] ?? c.damageKind)} pays ${c.percent}% of ${usd(c.grossCents)} under your severity table.` : "";
    steps.push({
      at: p.created_at, actor: "policy",
      title: p.route === "request_info" || calc.askForPhotos ? "Policy advises asking the buyer for clearer photos"
        : p.route === "reject" ? `Policy ${ROUTE[p.route]}` : `Policy drafted ${usd(p.amount_cents)} and ${ROUTE[p.route]}`,
      detail: `${reasons.length ? reasons.map((r) => REASON_TEXT[r] ?? r).join(" ") : REASON_TEXT.ALL_CHECKS_PASSED}${priced}`,
      meta: p.policy_version,
    });
    if ((calc.options ?? []).length > 1) {
      steps.push({
        at: p.created_at, actor: "jev",
        title: `AI matched ${calc.options.length - 1} remed${calc.options.length === 2 ? "y" : "ies"} from your library to this damage`,
        detail: calc.options.map((o) => `${o.title}${pct(o.fit)}: ${o.refundCents ? `${usd(o.refundCents)} back` : "no refund"}`).join(" · "),
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
    const who = ["buyer", "system", "agent"].includes(h.actor) ? h.actor : "merchant";
    const add = (s) => steps.push({ at: h.at, actor: who, ...s });
    switch (h.type) {
      case "claim.submitted": add({ title: `Buyer reported ${x.quantity > 1 ? `${x.quantity} damaged items` : "a damaged item"}` }); break;
      case "evidence.added": add({ title: `Buyer sent ${x.count} photo${x.count === 1 ? "" : "s"}` }); break;
      case "assessment.completed":
      case "assessment.failed": steps.push(...reviewSteps(db, claimId, h, photoNumber)); break;
      case "claim.info_requested": add({ title: who === "agent" ? "The buyer was asked" : "You asked for more photos", detail: x.message }); break;
      case "claim.closed":
        if (who !== "agent") add({ title: "You closed it without a refund", detail: x.reason });
        else add({ title: "The buyer was told", detail: x.reason });
        break;
      case "offer.sent":
        if (who !== "agent") add({ title: "You let the buyer choose", detail: "This approved every amount on the list." });
        break;
      case "offer.withdrawn": add({ title: "You took back the choices", detail: "The buyer can no longer pick; review the case again to decide." }); break;
      case "agent.acted": add({ title: x.act === "offer" ? "Your refund agent let the buyer choose, on its own" : x.act === "decline" ? "Your refund agent closed it without a refund, under your policy" : x.act === "ask" ? "Your refund agent asked the buyer for clearer photos" : "Your refund agent approved the refund, on its own", detail: x.why }); break;
      case "agent.left_for_merchant": add({ title: "Your refund agent left this one for you", detail: x.why }); break;
      case "offer.accepted": add({ title: `Buyer chose: ${x.title ?? x.option}`, detail: `${x.refund === "0.00" ? "No refund" : `$${x.refund} back`}${x.kit ? `; send ${x.kit}` : ""}.` }); break;
      case "suggestion.created":
        steps.push({ at: h.at, actor: "claude", title: x.titles.length
          ? `AI suggested ${x.titles.length === 1 ? "a remedy" : `${x.titles.length} remedies`} from ${x.candidates} store listing${x.candidates === 1 ? "" : "s"}`
          : `AI looked at ${x.candidates} store listing${x.candidates === 1 ? "" : "s"} and found none that fit`,
          detail: x.titles.length ? `${x.titles.join(" · ")}. Waiting for your approval.` : undefined,
          meta: `${x.model} · ${x.latencyMs} ms · photos and the photo check only, never the buyer's words${x.dropped ? ` · ${x.dropped} failed the price check` : ""}` });
        break;
      case "suggestion.failed": steps.push({ at: h.at, actor: "claude", title: "The AI could not suggest a remedy", detail: x.error }); break;
      case "match.failed": steps.push({ at: h.at, actor: "claude", title: "The second AI product check failed; the photo check stands alone", detail: x.error }); break;
      case "suggestion.approved": add({ title: `You added the AI's suggestion: ${x.title}`, detail: `${x.refundUnitCents ? `$${(x.refundUnitCents / 100).toFixed(2)} back per item` : "No refund"}, plus ${x.item}.` }); break;
      case "suggestion.dismissed": add({ title: `You dismissed the AI's suggestion: ${x.title}` }); break;
      case "claim.resolved": add({ title: "Sorted without a refund", detail: x.sends ? `Send ${x.sends}.` : undefined }); break;
      case "refund.approved":
        // A buyer's pick already has its own step; the reservation behind it adds nothing new.
        // So does an agent's approval: its own step says which rule it acted on.
        if (who === "merchant") add({ title: `You approved ${usd(x.amountCents)}`, detail: x.overrideReason });
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
