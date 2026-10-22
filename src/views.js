// Read models for the UI. Buyer views expose only that buyer's safe status.
import { refundableBalance } from "./policy/refundPolicy.js";
import { REASON_TEXT } from "./reasons.js";

const json = (s) => (s ? JSON.parse(s) : null);

// Newest first, one page at a time: `before` is the created_at of the last row already shown.
// The whole table in one response was 4.8 MB and 200 ms at 20k claims.
export function inbox(db, { limit = 100, before = null } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db.prepare(`
    SELECT c.id, c.ref, c.status, c.quantity, c.created_at, c.updated_at, l.title, l.ref_image, o.amount_cents,
      (SELECT route FROM proposals p WHERE p.claim_id = c.id ORDER BY p.created_at DESC LIMIT 1) AS route,
      (SELECT amount_cents FROM proposals p WHERE p.claim_id = c.id ORDER BY p.created_at DESC LIMIT 1) AS proposed_cents
    FROM claims c JOIN order_lines l ON l.id = c.line_id JOIN orders o ON o.id = c.order_id
    WHERE (? IS NULL OR c.created_at < ?)
    ORDER BY c.created_at DESC LIMIT ?`).all(before, before, n);
}

export function caseDetail(db, claimId) {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
  if (!claim) return null;
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(claim.order_id);
  const line = db.prepare("SELECT * FROM order_lines WHERE id = ?").get(claim.line_id);
  const evidence = db.prepare("SELECT id, width, height, created_at FROM evidence WHERE claim_id = ? ORDER BY created_at").all(claimId);
  const assessment = db.prepare("SELECT * FROM assessments WHERE claim_id = ? ORDER BY created_at DESC LIMIT 1").get(claimId);
  const sentToAi = new Set(json(assessment?.photo_ids_json) ?? []);
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
    evidence: evidence.map((e) => ({ ...e, url: `/api/merchant/evidence/${e.id}`, sentToAi: sentToAi.has(e.id) })),
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
    refunds: ops.filter((o) => o.claim_id === claimId).map((o) => ({
      id: o.id, status: o.status, amountCents: o.amount_cents, providerRefundId: o.provider_refund_id,
      providerStatus: o.provider_status, debugId: o.debug_id, error: o.error, attempts: o.attempts,
      requestId: o.request_id, updatedAt: o.updated_at,
    })),
    history,
  };
}

const BUYER_WORDING = {
  new: "Received. The shop will look at it soon.",
  ready: "The shop is reviewing your photos.",
  needs_info: "The shop needs another photo.",
  refund_processing: "Your refund is on its way.",
  refunded: "The shop refunded you through PayPal.",
  closed: "The shop closed this request without a refund.",
};

export function buyerStatus(db, claim) {
  const op = db.prepare("SELECT status, amount_cents, provider_refund_id FROM refund_ops WHERE claim_id = ? ORDER BY created_at DESC LIMIT 1").get(claim.id);
  const last = (type) => db.prepare("SELECT payload FROM audit WHERE claim_id = ? AND type = ? ORDER BY id DESC LIMIT 1").get(claim.id, type);
  const line = db.prepare("SELECT title FROM order_lines WHERE id = ?").get(claim.line_id);
  return {
    ref: claim.ref, status: claim.status, message: BUYER_WORDING[claim.status], item: line.title, quantity: claim.quantity,
    infoRequest: claim.status === "needs_info" ? json(last("claim.info_requested")?.payload)?.message : null,
    closeReason: claim.status === "closed" ? json(last("claim.closed")?.payload)?.reason : null,
    refund: op && ["COMPLETED", "PENDING", "SUBMITTING", "UNKNOWN"].includes(op.status)
      ? { amountCents: op.amount_cents, state: op.status === "COMPLETED" ? "issued" : "processing", refundId: op.provider_refund_id }
      : null,
    createdAt: claim.created_at,
  };
}
