// PayPal disputes on a payment. A buyer who opened a dispute in PayPal (item not as described, not
// received) and also files a request here could otherwise be paid twice: once by the refund here,
// once when PayPal settles the dispute. The case page shows them, and the refund agent leaves any
// case with an open dispute to the merchant.
const OPEN = ["OPEN", "WAITING_FOR_BUYER_RESPONSE", "WAITING_FOR_SELLER_RESPONSE", "UNDER_REVIEW"];
const REASON = {
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "item not as described",
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "item not received",
  UNAUTHORISED: "payment not authorised",
  CREDIT_NOT_PROCESSED: "refund not received",
  DUPLICATE_TRANSACTION: "charged twice",
  INCORRECT_AMOUNT: "wrong amount charged",
  PAYMENT_BY_OTHER_MEANS: "paid another way",
  CANCELED_RECURRING_BILLING: "cancelled subscription charged",
};
const STAGE = { INQUIRY: "inquiry", CHARGEBACK: "chargeback", PRE_ARBITRATION: "pre-arbitration", ARBITRATION: "arbitration" };

// Throws when PayPal cannot be asked (not connected, unreachable, or the app may not read disputes).
export async function paymentDisputes(paypal, captureId) {
  const res = await paypal.listDisputes(captureId);
  if (res.status !== 200) throw Object.assign(new Error(`PayPal ${res.status}`), { debugId: res.debugId });
  return (res.body.items ?? []).map((d) => ({
    id: d.dispute_id,
    reason: REASON[d.reason] ?? String(d.reason ?? "other").toLowerCase().replace(/_/g, " "),
    status: d.status,
    open: OPEN.includes(d.status),
    stage: STAGE[d.dispute_life_cycle_stage] ?? null,
    amount: d.dispute_amount?.value ?? null,
    createdAt: d.create_time ?? null,
  }));
}

export const openDispute = (disputes) => disputes.find((d) => d.open) ?? null;
