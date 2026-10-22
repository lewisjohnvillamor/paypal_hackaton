// Read models for the UI. Buyer views expose only that buyer's safe status.
import { refundableBalance } from "./policy/refundPolicy.js";
import { REASON_TEXT } from "./reasons.js";
import { latestOffer } from "./offers.js";
import { agentTimeline } from "./timeline.js";

const json = (s) => (s ? JSON.parse(s) : null);

// Newest first, one page at a time: `before` is the created_at of the last row already shown.
// The whole table in one response was 4.8 MB and 200 ms at 20k claims.
// Each row also carries what the merchant grid shows at a glance: Jev's headline finding, the
// photo it outlined, how many concerns the policy raised, and how the case ended.
export function inbox(db, { limit = 100, before = null } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db.prepare(`
    SELECT c.id, c.ref, c.status, c.quantity, c.created_at, c.updated_at, l.title, l.ref_image, o.amount_cents,
      p.route, p.amount_cents AS proposed_cents, p.calc_json, a.findings_json, a.photo_ids_json,
      (SELECT id FROM evidence e WHERE e.claim_id = c.id ORDER BY e.created_at LIMIT 1) AS first_photo,
      (SELECT COUNT(*) FROM evidence e WHERE e.claim_id = c.id) AS photos,
      (SELECT chosen_option FROM offers f WHERE f.claim_id = c.id ORDER BY f.created_at DESC LIMIT 1) AS chosen_option,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM refund_ops r WHERE r.claim_id = c.id AND r.status = 'COMPLETED') AS refunded_cents
    FROM claims c JOIN order_lines l ON l.id = c.line_id JOIN orders o ON o.id = c.order_id
    LEFT JOIN proposals p ON p.id = (SELECT id FROM proposals x WHERE x.claim_id = c.id ORDER BY x.created_at DESC LIMIT 1)
    LEFT JOIN assessments a ON a.id = p.assessment_id
    WHERE (? IS NULL OR c.created_at < ?)
    ORDER BY c.created_at DESC LIMIT ?`).all(before, before, n).map(({ calc_json, findings_json, photo_ids_json, ...r }) => {
    const f = json(findings_json);
    const calc = json(calc_json);
    const sent = json(photo_ids_json) ?? [];
    const i = (f?.locations ?? []).findIndex((x) => x?.box);
    return {
      ...r,
      damage_kind: f?.damage_kind ?? null,
      breakage: f?.signals?.visible_breakage ?? null,
      concerns: calc?.reasons?.length ?? null,
      repairable: (calc?.options ?? []).length > 1,
      thumb: i >= 0 ? { id: sent[i], box: f.locations[i].box } : r.first_photo ? { id: r.first_photo, box: null } : null,
    };
  });
}

export function caseDetail(db, claimId) {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
  if (!claim) return null;
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(claim.order_id);
  const line = db.prepare("SELECT * FROM order_lines WHERE id = ?").get(claim.line_id);
  const evidence = db.prepare("SELECT id, width, height, created_at FROM evidence WHERE claim_id = ? ORDER BY created_at").all(claimId);
  const assessment = db.prepare("SELECT * FROM assessments WHERE claim_id = ? ORDER BY created_at DESC LIMIT 1").get(claimId);
  const sentIds = json(assessment?.photo_ids_json) ?? [];
  const sentToAi = new Set(sentIds);
  // Damage boxes are stored in the order the photos were sent to Jev.
  const locations = json(assessment?.findings_json)?.locations ?? [];
  const damageBox = new Map(sentIds.map((id, i) => [id, locations[i]?.box ?? null]));
  const proposal = db.prepare("SELECT * FROM proposals WHERE claim_id = ? ORDER BY created_at DESC LIMIT 1").get(claimId);
  const ops = db.prepare("SELECT * FROM refund_ops WHERE capture_id = ? ORDER BY created_at").all(order.capture_id);
  const approvals = db.prepare("SELECT id, actor, amount_cents, override_reason, claim_version, created_at FROM approvals WHERE claim_id = ? ORDER BY created_at").all(claimId);
  const history = db.prepare("SELECT actor, type, payload, at FROM audit WHERE claim_id = ? ORDER BY id").all(claimId)
    .map((h) => ({ ...h, payload: json(h.payload) }));

  return {
    claim: {
      id: claim.id, ref: claim.ref, status: claim.status, version: claim.version, quantity: claim.quantity,
      statement: claim.statement, createdAt: claim.created_at,
    },
    payment: {
      orderId: order.id, paypalOrderId: order.paypal_order_id, captureId: order.capture_id, captureStatus: order.capture_status,
      amountCents: order.amount_cents, currency: order.currency, payee: order.payee_merchant_id,
      deliveredAt: order.delivered_at, deliverySource: order.delivery_source,
      refundableCents: refundableBalance(order.amount_cents, ops),
    },
    line: { title: line.title, sku: line.sku, quantity: line.quantity, unitCents: line.unit_cents, refImage: `/assets/${line.ref_image}` },
    evidence: evidence.map((e) => ({ ...e, url: `/api/merchant/evidence/${e.id}`, sentToAi: sentToAi.has(e.id), damageBox: damageBox.get(e.id) ?? null })),
    assessment: assessment && {
      current: assessment.claim_version === claim.version || (proposal && proposal.claim_version === claim.version),
      model: assessment.model, templateVersion: assessment.template_version, latencyMs: assessment.latency_ms,
      findings: json(assessment.findings_json), usage: json(assessment.usage_json), error: assessment.error,
      createdAt: assessment.created_at, photosSent: sentToAi.size, photosTotal: evidence.length,
    },
    proposal: proposal && {
      id: proposal.id, route: proposal.route, amountCents: proposal.amount_cents, currency: proposal.currency,
      policyVersion: proposal.policy_version, current: proposal.claim_version === claim.version, ...json(proposal.calc_json),
      reasonText: Object.fromEntries((json(proposal.calc_json).reasons ?? []).map((r) => [r, REASON_TEXT[r] ?? r])),
    },
    approvals,
    offer: latestOffer(db, claimId),
    refunds: ops.filter((o) => o.claim_id === claimId).map((o) => ({
      id: o.id, status: o.status, amountCents: o.amount_cents, providerRefundId: o.provider_refund_id,
      providerStatus: o.provider_status, debugId: o.debug_id, error: o.error, attempts: o.attempts,
      requestId: o.request_id, updatedAt: o.updated_at,
    })),
    history,
    timeline: agentTimeline(db, claimId),
  };
}

const BUYER_WORDING = {
  new: "Received. The shop will look at it soon.",
  ready: "The shop is reviewing your photos.",
  offer_sent: "Choose how you'd like this put right.",
  needs_info: "The shop needs another photo.",
  refund_processing: "Your refund is on its way.",
  refunded: "The shop refunded you through PayPal.",
  closed: "The shop closed this request without a refund.",
};

export function buyerStatus(db, claim) {
  const op = db.prepare("SELECT status, amount_cents, provider_refund_id FROM refund_ops WHERE claim_id = ? ORDER BY created_at DESC LIMIT 1").get(claim.id);
  const last = (type) => db.prepare("SELECT payload FROM audit WHERE claim_id = ? AND type = ? ORDER BY id DESC LIMIT 1").get(claim.id, type);
  const line = db.prepare("SELECT title FROM order_lines WHERE id = ?").get(claim.line_id);
  const offer = latestOffer(db, claim.id);
  return {
    ref: claim.ref, status: claim.status, message: BUYER_WORDING[claim.status], item: line.title, quantity: claim.quantity,
    infoRequest: claim.status === "needs_info" ? json(last("claim.info_requested")?.payload)?.message : null,
    closeReason: claim.status === "closed" ? json(last("claim.closed")?.payload)?.reason : null,
    refund: op && ["COMPLETED", "PENDING", "SUBMITTING", "UNKNOWN"].includes(op.status)
      ? { amountCents: op.amount_cents, state: op.status === "COMPLETED" ? "issued" : "processing", refundId: op.provider_refund_id }
      : null,
    // Only what the buyer needs to choose: no model findings, no risk flags.
    offer: offer && (offer.status === "open" ? claim.status === "offer_sent" : true)
      ? { id: offer.id, open: offer.status === "open", chosen: offer.chosen, options: offer.options }
      : null,
    createdAt: claim.created_at,
  };
}
