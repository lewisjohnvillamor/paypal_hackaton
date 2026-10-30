// What Refund Relay did for one store lately, for the top of the merchant inbox: how many requests
// came in, how many were settled with no click, how long a buyer waited for their PayPal refund,
// and what partial refunds and remedies kept compared with refunding every item in full.
// Read only; every number comes from the claims, PayPal refund records and the audit log.
const DAY = 86400e3;

export function storeStats(db, merchantId, { days = 30, at = Date.now() } = {}) {
  const since = new Date(at - days * DAY).toISOString();
  const rows = db.prepare(`SELECT c.status, c.created_at, c.quantity * l.unit_cents claimed_cents,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM refund_ops r WHERE r.claim_id = c.id AND r.status = 'COMPLETED') refunded_cents,
      (SELECT MIN(updated_at) FROM refund_ops r WHERE r.claim_id = c.id AND r.status = 'COMPLETED') refunded_at,
      EXISTS (SELECT 1 FROM audit a WHERE a.claim_id = c.id AND a.type = 'agent.acted') by_agent
    FROM claims c JOIN orders o ON o.id = c.order_id JOIN order_lines l ON l.id = c.line_id
    WHERE o.merchant_id = ? AND c.created_at >= ?`).all(merchantId, since);
  const settled = rows.filter((r) => ["refunded", "resolved", "closed"].includes(r.status));
  // Requests that ended with the buyer made whole (money back or a remedy), not declines.
  const madeWhole = settled.filter((r) => r.status !== "closed");
  const waits = rows.filter((r) => r.refunded_at).map((r) => Date.parse(r.refunded_at) - Date.parse(r.created_at)).sort((a, b) => a - b);
  const mid = waits.length >> 1;
  return {
    days,
    requests: rows.length,
    settled: settled.length,
    settledByAgent: settled.filter((r) => r.by_agent).length,
    open: rows.length - settled.length,
    medianRefundMs: waits.length ? (waits.length % 2 ? waits[mid] : Math.round((waits[mid - 1] + waits[mid]) / 2)) : null,
    refundedCents: rows.reduce((s, r) => s + r.refunded_cents, 0),
    keptCents: madeWhole.reduce((s, r) => s + Math.max(0, r.claimed_cents - r.refunded_cents), 0),
  };
}
