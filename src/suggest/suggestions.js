// Claude Haiku's suggestions on a case: checked, stored as pending, and only offered to the buyer
// once the merchant approves them. Nothing Haiku returns is trusted: an id must be one of the
// candidates it was shown, and the refund must leave the listing plus refund at or under the price
// paid, or the suggestion is dropped.
import { randomUUID } from "node:crypto";
import { audit, now, tx } from "../db.js";
import { ClaimError } from "../claims.js";
import { MAX_SUGGESTIONS } from "../ai/haiku.js";

const json = (s) => (s ? JSON.parse(s) : null);
const clip = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function checkSuggestions(raw, { candidates, unitCents }) {
  const seen = new Set();
  const out = [];
  for (const s of raw ?? []) {
    const c = candidates.find((x) => x.id === s.listingId);
    if (!c || seen.has(c.id)) continue;
    const refund = s.refundUnitCents;
    if (!Number.isSafeInteger(refund) || refund < 0 || refund + c.priceCents > unitCents || refund >= unitCents) continue;
    const title = clip(s.title, 80), why = clip(s.why, 300);
    if (title.length < 3 || why.length < 3) continue;
    seen.add(c.id);
    out.push({ listing: c, title, why, refundUnitCents: refund });
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

export function storeSuggestions(db, { claimId, proposalId, model, suggestions }) {
  const insert = db.prepare(`INSERT INTO suggestions (id, claim_id, proposal_id, listing_id, kind, title, item, item_price_cents, why,
    refund_unit_cents, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`);
  for (const s of suggestions) {
    insert.run(randomUUID(), claimId, proposalId, s.listing.id, s.listing.kind, s.title, s.listing.title, s.listing.priceCents, s.why, s.refundUnitCents, model, now());
  }
}

const row = (r) => ({
  id: r.id, listingId: r.listing_id, kind: r.kind, title: r.title, item: r.item, itemPriceCents: r.item_price_cents,
  why: r.why, refundUnitCents: r.refund_unit_cents, model: r.model, status: r.status, decidedAt: r.decided_at,
});

export const proposalSuggestions = (db, proposalId) =>
  db.prepare("SELECT * FROM suggestions WHERE proposal_id = ? ORDER BY created_at, rowid").all(proposalId).map(row);

// The merchant's call on one suggestion. Only on a case still waiting for their decision, and only
// on a suggestion attached to its current proposal.
export function decideSuggestion(db, { claimId, suggestionId, approve, actor }) {
  return tx(db, () => {
    const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
    const s = db.prepare("SELECT * FROM suggestions WHERE id = ? AND claim_id = ?").get(suggestionId, claimId);
    if (!claim || !s) throw new ClaimError("NOT_FOUND", "No such suggestion.", 404);
    const proposal = db.prepare("SELECT * FROM proposals WHERE claim_id = ? ORDER BY created_at DESC LIMIT 1").get(claimId);
    if (claim.status !== "ready" || proposal?.id !== s.proposal_id || proposal.claim_version !== claim.version) {
      throw new ClaimError("STALE_CASE", "This suggestion is no longer open. Reload the case.", 409);
    }
    const status = approve ? "approved" : "dismissed";
    if (s.status === status) return row(s);
    db.prepare("UPDATE suggestions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(status, actor, now(), s.id);
    audit(db, { claimId, actor, type: approve ? "suggestion.approved" : "suggestion.dismissed", payload: { title: s.title, item: s.item, refundUnitCents: s.refund_unit_cents } });
    return row(db.prepare("SELECT * FROM suggestions WHERE id = ?").get(s.id));
  });
}

// What the buyer could be offered for a proposal: the library remedies Jev matched plus the
// suggestions the merchant approved, with the full refund first whenever there is any choice.
export function offerOptions(db, proposal) {
  const calc = json(proposal.calc_json);
  const base = calc.options ?? [];
  const quantity = calc.calculation?.quantity ?? 1;
  const amountCents = proposal.amount_cents;
  const approved = db.prepare("SELECT * FROM suggestions WHERE proposal_id = ? AND status = 'approved' ORDER BY created_at, rowid").all(proposal.id)
    .map((s) => ({ id: `ai_${s.id}`, kind: s.kind, title: s.title, item: s.item, source: "haiku", refundCents: Math.min(s.refund_unit_cents * quantity, amountCents) }))
    .filter((o) => o.refundCents < amountCents);
  if (!approved.length) return base;
  const refund = base.find((o) => o.kind === "refund") ?? (amountCents > 0 ? { id: "refund", kind: "refund", title: "Full refund", refundCents: amountCents } : null);
  if (!refund) return base;
  return [refund, ...base.filter((o) => o.kind !== "refund"), ...approved];
}
