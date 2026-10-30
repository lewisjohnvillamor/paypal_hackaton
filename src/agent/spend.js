// What a store's refund agent has committed in the last 24 hours: refunds it approved, refunds
// buyers picked from options it sent, and the largest amount still open on any offer it sent. The
// refund policy's daily limit and the merchant's own rule limit are both measured against this.
// Each store's agent has its own total.
const json = (s) => (s ? JSON.parse(s) : null);
const DAY = 86400e3;

export function agentSpent(db, merchantId = "demo", at = Date.now()) {
  const since = new Date(at - DAY).toISOString();
  const refunded = db.prepare(`SELECT COALESCE(SUM(o.amount_cents), 0) n FROM refund_ops o JOIN approvals a ON a.id = o.approval_id
    JOIN orders r ON r.id = o.order_id
    WHERE o.status != 'FAILED' AND o.created_at >= ? AND r.merchant_id = ?
      AND (a.actor = 'agent' OR o.id IN (SELECT op_id FROM offers WHERE actor = 'agent' AND op_id IS NOT NULL))`).get(since, merchantId).n;
  const open = db.prepare(`SELECT f.options_json FROM offers f JOIN claims c ON c.id = f.claim_id JOIN orders r ON r.id = c.order_id
    WHERE f.actor = 'agent' AND f.status = 'open' AND f.decided_at IS NULL AND f.created_at >= ? AND r.merchant_id = ?`).all(since, merchantId)
    .reduce((s, o) => s + Math.max(0, ...json(o.options_json).map((x) => x.refundCents)), 0);
  return refunded + open;
}
