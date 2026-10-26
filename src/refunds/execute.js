// Refund execution gate. The only code path that moves money. It runs after a stored merchant
// approval, reserves funds in a short transaction, and only then talks to PayPal.
import { randomUUID } from "node:crypto";
import { audit, now, tx } from "../db.js";
import { toDecimal, toCents } from "../money.js";
import { refundableBalance } from "../policy/refundPolicy.js";

export class GateError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// Map PayPal refund statuses onto our lifecycle. Unknown values are reconciled, never guessed.
export function mapProviderStatus(s) {
  if (s === "COMPLETED") return "COMPLETED";
  if (s === "PENDING") return "PENDING";
  if (s === "FAILED" || s === "CANCELLED") return "FAILED";
  return "UNKNOWN";
}

const OPEN = ["SUBMITTING", "PENDING", "UNKNOWN"];

// Step 0 (network, before any reservation): compare PayPal's own record of the capture with ours.
// Refunds issued from the PayPal dashboard, a reversed (charged-back) capture, or a capture PayPal
// no longer considers refundable all block the app until a person reconciles them.
export async function checkPayPalLedger(db, paypal, claimId) {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
  if (!claim) throw new GateError("NOT_FOUND", "No such refund request.");
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(claim.order_id);
  const ops = db.prepare("SELECT * FROM refund_ops WHERE capture_id = ?").all(order.capture_id);
  if (ops.some((o) => OPEN.includes(o.status))) return; // the reservation step reports this case

  let res;
  try {
    res = await paypal.getOrder(order.paypal_order_id);
  } catch {
    res = null;
  }
  if (!res || res.status !== 200) {
    throw new GateError("PAYPAL_UNAVAILABLE", "Could not confirm the payment with PayPal. Nothing was refunded; try again shortly.", { status: 503 });
  }
  const payments = res.body.purchase_units?.[0]?.payments ?? {};
  const cap = payments.captures?.find((c) => c.id === order.capture_id);
  if (!cap) throw new GateError("CAPTURE_NOT_FOUND", "PayPal does not list this capture on the order.");
  if (!["COMPLETED", "PARTIALLY_REFUNDED"].includes(cap.status)) {
    audit(db, { claimId, actor: "system", type: "paypal.capture_not_refundable", payload: { captureStatus: cap.status } });
    throw new GateError("CAPTURE_NOT_REFUNDABLE", `PayPal reports this payment as ${cap.status}; it cannot be refunded here.`);
  }
  const ours = new Set(ops.map((o) => o.provider_refund_id).filter(Boolean));
  const external = (payments.refunds ?? []).filter((r) => !ours.has(r.id) && !["FAILED", "CANCELLED"].includes(r.status));
  if (external.length) {
    audit(db, { claimId, actor: "system", type: "paypal.external_refund_detected",
      payload: { refunds: external.map((r) => ({ id: r.id, status: r.status, value: r.amount?.value })) } });
    throw new GateError("EXTERNAL_REFUND_DETECTED",
      "PayPal shows a refund on this payment that Refund Relay did not make. Reconcile it in PayPal before refunding here.");
  }
}

// Step 1 (transaction, no I/O): validate approval inputs, record approval, reserve funds, persist op.
export function approveAndReserve(db, { claimId, claimVersion, proposalId, amountCents, reason, actor }) {
  return tx(db, () => {
    const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
    if (!claim) throw new GateError("NOT_FOUND", "No such refund request.");

    // Duplicate click on the same version: hand back the existing operation, do not create another.
    const prior = db.prepare(
      "SELECT o.* FROM approvals a JOIN refund_ops o ON o.approval_id = a.id WHERE a.claim_id = ? AND a.claim_version = ?",
    ).get(claimId, claimVersion);
    if (prior) return { op: prior, duplicate: true };

    if (claim.version !== claimVersion) throw new GateError("STALE_CASE", "This request changed since you opened it. Reload and review again.");
    if (claim.status !== "ready") throw new GateError("NOT_READY", `Request is ${claim.status}; it cannot be approved now.`);

    const proposal = db.prepare("SELECT * FROM proposals WHERE id = ? AND claim_id = ?").get(proposalId, claimId);
    if (!proposal || proposal.claim_version !== claim.version) {
      throw new GateError("STALE_CASE", "The proposal is out of date. Reload and review again.");
    }
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new GateError("INVALID_AMOUNT", "Refund amount must be a positive number of cents.");
    }
    const overridden = amountCents !== proposal.amount_cents || proposal.route !== "propose";
    const why = (reason || "").trim();
    if (overridden && why.length < 3) {
      throw new GateError("REASON_REQUIRED", "Give a reason when approving an amount or case the policy did not propose.");
    }

    return { op: reserve(db, { claim, proposal, amountCents, actor, overrideReason: overridden ? why : null }), duplicate: false };
  });
}

// Inside the caller's transaction: record the approval, reserve the funds, persist the PayPal
// request. Shared by a merchant's direct approval and a buyer's pick from a merchant-approved offer.
export function reserve(db, { claim, proposal, amountCents, actor, overrideReason = null, note }) {
  const claimId = claim.id;
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(claim.order_id);
  if (!order.capture_id || order.capture_status !== "COMPLETED") {
    throw new GateError("CAPTURE_NOT_VERIFIED", "The original payment is not a verified, completed capture.");
  }
  const ops = db.prepare("SELECT * FROM refund_ops WHERE capture_id = ?").all(order.capture_id);
  if (ops.some((o) => OPEN.includes(o.status))) {
    throw new GateError("REFUND_IN_PROGRESS", "A refund on this payment is still being settled. Reconcile it first.");
  }
  const refundable = refundableBalance(order.amount_cents, ops);
  if (amountCents > refundable) {
    throw new GateError("INSUFFICIENT_REFUNDABLE_BALANCE", `Only ${toDecimal(refundable)} USD is refundable on this payment.`);
  }

  const ts = now();
  const approvalId = randomUUID();
  db.prepare(`INSERT INTO approvals (id, claim_id, claim_version, proposal_id, proposal_snapshot, actor,
    amount_cents, currency, override_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?)`)
    .run(approvalId, claimId, claim.version, proposal.id, JSON.stringify(proposal), actor, amountCents, overrideReason, ts);

  const opId = randomUUID();
  const body = {
    amount: { currency_code: "USD", value: toDecimal(amountCents) },
    custom_id: opId,
    note_to_payer: note ?? `Refund for request ${claim.ref}, reviewed by the merchant.`,
  };
  db.prepare(`INSERT INTO refund_ops (id, order_id, capture_id, claim_id, approval_id, request_id, request_body,
    amount_cents, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'SUBMITTING', ?, ?)`)
    .run(opId, order.id, order.capture_id, claimId, approvalId, randomUUID(), JSON.stringify(body), amountCents, ts, ts);

  db.prepare("UPDATE claims SET status = 'refund_processing', version = version + 1, updated_at = ? WHERE id = ?").run(ts, claimId);
  audit(db, { claimId, opId, actor, type: "refund.approved", payload: { amountCents, overrideReason } });
  return db.prepare("SELECT * FROM refund_ops WHERE id = ?").get(opId);
}

// Record a provider answer and move the op (and claim) to the matching state.
function applyProviderResult(db, op, { status, body, debugId }, actor) {
  const ts = now();
  let next, error = null;
  const providerStatus = body?.status ?? null;
  if (status >= 200 && status < 300) {
    next = mapProviderStatus(body.status);
    // Defense in depth: a refund that does not match the approved amount is not "done".
    if (body.amount && toCents(body.amount.value) !== op.amount_cents) {
      next = "UNKNOWN";
      error = `Provider amount ${body.amount.value} differs from approved ${toDecimal(op.amount_cents)}`;
    }
  } else if (status >= 500 || status === 429 || status === 409) {
    next = "UNKNOWN"; // may or may not have happened; keep reserved and reconcile
    error = `PayPal ${status}`;
  } else {
    next = "FAILED"; // definite rejection (4xx): provider wins over our proposal
    error = body?.details?.[0]?.issue || body?.name || `PayPal ${status}`;
  }

  tx(db, () => {
    db.prepare(`UPDATE refund_ops SET status = ?, provider_refund_id = COALESCE(?, provider_refund_id), provider_status = ?,
      debug_id = COALESCE(?, debug_id), error = ?, updated_at = ? WHERE id = ?`)
      .run(next, body?.id ?? null, providerStatus, debugId ?? null, error, ts, op.id);
    const claimStatus = next === "COMPLETED" ? "refunded" : next === "FAILED" ? "ready" : "refund_processing";
    db.prepare("UPDATE claims SET status = ?, version = version + 1, updated_at = ? WHERE id = ?").run(claimStatus, ts, op.claim_id);
    audit(db, { claimId: op.claim_id, opId: op.id, actor, type: `refund.${next.toLowerCase()}`,
      payload: { providerStatus, refundId: body?.id ?? null, debugId, error } });
  });
  return db.prepare("SELECT * FROM refund_ops WHERE id = ?").get(op.id);
}

// Step 2: submit to PayPal with the persisted request ID. Safe to call again for the same op.
export async function submit(db, paypal, op, actor = "system") {
  db.prepare("UPDATE refund_ops SET attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now(), op.id);
  let res;
  try {
    res = await paypal.refundCapture(op.capture_id, JSON.parse(op.request_body), op.request_id);
  } catch (err) {
    // Timeout or network failure: outcome unknown. Funds stay reserved; same request ID on retry.
    res = { status: 599, body: null, debugId: null };
    audit(db, { claimId: op.claim_id, opId: op.id, actor, type: "refund.network_error", payload: { message: String(err.message) } });
  }
  return applyProviderResult(db, op, res, actor);
}

// Refresh an op from PayPal. With a refund ID we read it; without one we replay the identical
// request (same PayPal-Request-Id), which PayPal answers idempotently instead of refunding twice.
export async function reconcile(db, paypal, opId, actor = "system") {
  const op = db.prepare("SELECT * FROM refund_ops WHERE id = ?").get(opId);
  if (!op) throw new GateError("NOT_FOUND", "No such refund operation.");
  if (!OPEN.includes(op.status)) return op;
  if (op.provider_refund_id) {
    let res;
    try {
      res = await paypal.getRefund(op.provider_refund_id);
    } catch {
      return op;
    }
    return applyProviderResult(db, op, res, actor);
  }
  return submit(db, paypal, op, actor);
}

export async function reconcileOpen(db, paypal) {
  const open = db.prepare("SELECT id FROM refund_ops WHERE status IN ('SUBMITTING','PENDING','UNKNOWN')").all();
  for (const { id } of open) await reconcile(db, paypal, id).catch(() => {});
  return open.length;
}
