// Resolution offers: instead of picking the refund alone, the merchant approves a short list of
// options (the full refund, or remedies from their library that Jev judged to fit) and the buyer
// picks one. Every amount on the list is approved by the merchant when the offer is sent, so the
// buyer's pick only selects among approved refunds; it can never raise one.
import { randomUUID } from "node:crypto";
import { audit, now, tx } from "./db.js";
import { GateError, reserve } from "./refunds/execute.js";
import { toDecimal } from "./money.js";

const json = (s) => (s ? JSON.parse(s) : null);

export function sendOffer(db, { claimId, claimVersion, proposalId, reason, actor }) {
  return tx(db, () => {
    const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
    if (!claim) throw new GateError("NOT_FOUND", "No such refund request.");
    if (claim.version !== claimVersion) throw new GateError("STALE_CASE", "This request changed since you opened it. Reload and review again.");
    if (claim.status !== "ready") throw new GateError("NOT_READY", `Request is ${claim.status}; an offer cannot be sent now.`);
    const proposal = db.prepare("SELECT * FROM proposals WHERE id = ? AND claim_id = ?").get(proposalId, claimId);
    if (!proposal || proposal.claim_version !== claim.version) {
      throw new GateError("STALE_CASE", "The proposal is out of date. Reload and review again.");
    }
    const options = json(proposal.calc_json).options ?? [];
    if (options.length < 2) throw new GateError("NO_OPTIONS", "No remedy in your library fits this damage; approve a refund instead.");
    // Same rule as a direct approval: a case the policy did not propose needs the merchant's reason.
    const why = (reason || "").trim();
    if (proposal.route !== "propose" && why.length < 3) {
      throw new GateError("REASON_REQUIRED", "Give a reason when sending options for a case the policy did not propose.");
    }

    const ts = now();
    const version = claim.version + 1;
    db.prepare("UPDATE claims SET status = 'offer_sent', version = ?, updated_at = ? WHERE id = ?").run(version, ts, claimId);
    const id = randomUUID();
    db.prepare(`INSERT INTO offers (id, claim_id, claim_version, proposal_id, options_json, actor, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`).run(id, claimId, version, proposal.id, JSON.stringify(options), actor, why || null, ts);
    audit(db, { claimId, actor, type: "offer.sent", payload: { options: options.map((o) => ({ id: o.id, refundCents: o.refundCents })) } });
    return db.prepare("SELECT * FROM offers WHERE id = ?").get(id);
  });
}

// The buyer's pick. Returns { op, option, duplicate }; the caller submits op to PayPal. op is null
// when the pick refunds nothing (a replacement).
export function acceptOffer(db, { claimId, offerId, optionId }) {
  return tx(db, () => {
    const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
    const offer = db.prepare("SELECT * FROM offers WHERE id = ? AND claim_id = ?").get(offerId, claimId);
    if (!claim || !offer) throw new GateError("NOT_FOUND", "No such offer.");
    const options = json(offer.options_json);
    // A second tap (or a retry after a dropped connection) gets the first pick's refund back.
    if (offer.status === "accepted") {
      const op = offer.op_id ? db.prepare("SELECT * FROM refund_ops WHERE id = ?").get(offer.op_id) : null;
      return { op, option: options.find((o) => o.id === offer.chosen_option), duplicate: true };
    }
    if (claim.status !== "offer_sent" || claim.version !== offer.claim_version) {
      throw new GateError("STALE_CASE", "This offer is no longer open.");
    }
    const option = options.find((o) => o.id === optionId);
    if (!option) throw new GateError("INVALID_OPTION", "Pick one of the options offered.");

    const proposal = db.prepare("SELECT * FROM proposals WHERE id = ?").get(offer.proposal_id);
    const sends = option.kind === "refund" ? null : option.item;
    // Logged before the reservation so the timeline reads: the pick, then the money.
    audit(db, { claimId, actor: "buyer", type: "offer.accepted",
      payload: { option: option.id, title: option.title, refund: toDecimal(option.refundCents), kit: sends } });
    let op = null;
    if (option.refundCents > 0) {
      op = reserve(db, {
        claim, proposal, amountCents: option.refundCents, actor: "buyer",
        overrideReason: `Buyer chose "${option.title}" from options the ${offer.actor} approved`,
        note: sends ? `Refund for request ${claim.ref}: you kept the item; ${sends} ships separately.` : undefined,
      });
    } else {
      // Nothing to refund (a replacement): the case is settled without a PayPal call.
      db.prepare("UPDATE claims SET status = 'resolved', version = version + 1, updated_at = ? WHERE id = ?").run(now(), claimId);
      audit(db, { claimId, actor: "system", type: "claim.resolved", payload: { sends } });
    }
    db.prepare("UPDATE offers SET status = 'accepted', chosen_option = ?, op_id = ?, decided_at = ? WHERE id = ?")
      .run(option.id, op?.id ?? null, now(), offer.id);
    return { op, option, duplicate: false };
  });
}

export function latestOffer(db, claimId) {
  const o = db.prepare("SELECT * FROM offers WHERE claim_id = ? ORDER BY created_at DESC LIMIT 1").get(claimId);
  return o && { id: o.id, status: o.status, options: json(o.options_json), chosen: o.chosen_option, sentBy: o.actor, createdAt: o.created_at, decidedAt: o.decided_at };
}
