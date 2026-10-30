// The refund agent. After every review it reads the merchant's standing rules (src/agent/rules.js)
// and either acts on them, sending a PayPal refund or the buyer's choices with no click, or leaves
// the case for the merchant with one sentence on why. It acts through the same gate as a merchant's
// own approval (reserve, then submit), so every PayPal safeguard still applies: the ledger check,
// one open refund per payment, the refundable balance, idempotent retries.
//
// Every store has its own agent: its own rules, its own daily total, its own refund policy, and a
// connected store's refunds go out through its own PayPal account (the routed client).
import { randomUUID } from "node:crypto";
import { audit, now, tx } from "../db.js";
import { checkPayPalLedger, latestProposal, reserve, submit } from "../refunds/execute.js";
import { openOffer } from "../offers.js";
import { offerOptions } from "../suggest/suggestions.js";
import { checkRules, decide, describeRules } from "./rules.js";
import { agentSpent } from "./spend.js";
import { closeClaim, requestInfo } from "../claims.js";
import { currentPolicy } from "../policy/settings.js";
import { BUYER_DECLINE } from "../reasons.js";
import { PRODUCTS } from "../catalog.js";
import { DEMO } from "../merchants/accounts.js";

export { agentSpent };

const json = (s) => (s ? JSON.parse(s) : null);
// What the buyer reads when the agent asks for clearer photos (the merchant's case page suggests the same).
export const ASK_FOR_PHOTOS = "Please send a clear, well-lit photo that shows the damage and the whole item.";

// The products a store's rules may name: the demo store's catalog, or for a connected store every
// product it has registered an order for (newest title and price per SKU).
export function storeCatalog(db, merchantId = DEMO) {
  if (merchantId === DEMO) return PRODUCTS;
  const rows = db.prepare(`SELECT l.sku, l.title, l.unit_cents, l.category FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.merchant_id = ? ORDER BY o.created_at`).all(merchantId);
  return Object.fromEntries(rows.map((r) => [r.sku, { sku: r.sku, title: r.title, unitCents: r.unit_cents, category: r.category }]));
}

const view = (db, m) => !m ? null : {
  id: m.id, text: m.text, ...json(m.rules_json), model: m.model, createdAt: m.created_at,
  readback: describeRules(json(m.rules_json), storeCatalog(db, m.merchant_id)),
};

export const activeMandate = (db, merchantId = DEMO) =>
  view(db, db.prepare("SELECT * FROM mandates WHERE merchant_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1").get(merchantId));

// Turning rules on replaces whatever was on before; the old ones stay on record.
export function saveMandate(db, { text, rules, model = null, actor, merchantId = DEMO }) {
  const checked = checkRules(rules, storeCatalog(db, merchantId));
  const words = String(text ?? "").trim().slice(0, 1000);
  return tx(db, () => {
    const ts = now();
    db.prepare("UPDATE mandates SET ended_at = ? WHERE merchant_id = ? AND ended_at IS NULL").run(ts, merchantId);
    const id = randomUUID();
    db.prepare("INSERT INTO mandates (id, merchant_id, text, rules_json, model, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, merchantId, words, JSON.stringify(checked), model, actor, ts);
    audit(db, { actor, type: "agent.rules_on", payload: { mandateId: id, merchantId, ...checked } });
    return activeMandate(db, merchantId);
  });
}

export function stopMandate(db, actor, merchantId = DEMO) {
  const r = db.prepare("UPDATE mandates SET ended_at = ? WHERE merchant_id = ? AND ended_at IS NULL").run(now(), merchantId);
  if (r.changes) audit(db, { actor, type: "agent.rules_off", payload: { merchantId } });
}

const merchantOf = (db, claimId) =>
  db.prepare("SELECT o.merchant_id FROM claims c JOIN orders o ON o.id = c.order_id WHERE c.id = ?").get(claimId)?.merchant_id;

const policyFacts = (calc) => ({
  reasons: calc.reasons ?? [], decidedBy: calc.decidedBy ?? null, hardReject: !!calc.hardReject, askForPhotos: !!calc.askForPhotos,
});

// Facts the agent decides on, for a case still waiting on its current proposal.
function caseFacts(db, claimId, merchantId) {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
  if (!claim || claim.status !== "ready") return null;
  const proposal = latestProposal(db, claimId);
  if (!proposal || proposal.claim_version !== claim.version) return null;
  const assessment = db.prepare("SELECT findings_json FROM assessments WHERE id = ?").get(proposal.assessment_id);
  const line = db.prepare("SELECT sku FROM order_lines WHERE id = ?").get(claim.line_id);
  return {
    claim, proposal,
    ctx: {
      ...policyFacts(json(proposal.calc_json)), route: proposal.route, amountCents: proposal.amount_cents,
      sku: line.sku, findings: json(assessment?.findings_json), options: offerOptions(db, proposal).length,
      spentCents: agentSpent(db, merchantId), policy: currentPolicy(db, merchantId), products: storeCatalog(db, merchantId),
    },
  };
}

const leave = (db, claimId, mandateId, code, why) => {
  audit(db, { claimId, actor: "agent", type: "agent.left_for_merchant", payload: { mandateId, code, why } });
  return { act: null, code, why };
};

// Run once per review. Returns the decision (or null when no rules are on or the case moved on).
export async function runAgent(db, paypal, claimId) {
  const merchantId = merchantOf(db, claimId);
  const mandate = merchantId && activeMandate(db, merchantId);
  if (!mandate) return null;
  const first = caseFacts(db, claimId, merchantId);
  if (!first) return null;
  const d = decide(mandate, first.ctx);
  if (!d.act) return leave(db, claimId, mandate.id, d.code, d.why);

  // Same order as a merchant's click: PayPal's own record first (network, outside any transaction).
  if (d.act === "refund") {
    try {
      await checkPayPalLedger(db, paypal, claimId);
    } catch (err) {
      return leave(db, claimId, mandate.id, err.code ?? "PAYPAL_CHECK", `${err.message} The agent did not refund.`);
    }
  }
  let op = null;
  try {
    op = tx(db, () => {
      // Decide again inside the transaction: the case, the rules or the day's total may have moved
      // while PayPal answered, and two cases must not both fit under the same daily limit.
      const current = activeMandate(db, merchantId);
      const facts = caseFacts(db, claimId, merchantId);
      if (!current || current.id !== mandate.id || !facts || facts.claim.version !== first.claim.version) throw Object.assign(new Error("The case or your rules changed while the agent checked it."), { code: "CHANGED" });
      const again = decide(current, facts.ctx);
      if (again.act !== d.act) throw Object.assign(new Error(again.why), { code: again.code });
      audit(db, { claimId, actor: "agent", type: "agent.acted", payload: { mandateId: mandate.id, act: d.act, rule: d.rule, why: d.why } });
      if (d.act === "ask") {
        requestInfo(db, claimId, ASK_FOR_PHOTOS, "agent", true);
        return null;
      }
      if (d.act === "decline") {
        closeClaim(db, claimId, BUYER_DECLINE[facts.ctx.decidedBy] ?? BUYER_DECLINE.DEFAULT, "agent", true);
        return null;
      }
      if (d.act === "offer") {
        openOffer(db, { claimId, claimVersion: facts.claim.version, proposalId: facts.proposal.id, actor: "agent" });
        return null;
      }
      return reserve(db, {
        claim: facts.claim, proposal: facts.proposal, amountCents: facts.proposal.amount_cents, actor: "agent",
        note: `Refund for request ${facts.claim.ref}, under the shop's refund rules.`,
      });
    });
  } catch (err) {
    return leave(db, claimId, mandate.id, err.code ?? "AGENT_ERROR", err.message);
  }
  // A store that disconnected PayPal mid-way: the refund stays reserved and goes out once it reconnects.
  if (op) await submit(db, paypal, op, "agent").catch((err) => { if (err.code !== "PAYPAL_NOT_CONNECTED") throw err; });
  return d;
}

// After a restart: cases whose review finished but which the agent never looked at (the server
// stopped in between). Only reviews drafted while the store's current rules were on, so turning
// rules on never reaches back to older cases. Returns the claim ids, oldest first.
export function unseenByAgent(db) {
  return db.prepare(`SELECT c.id FROM claims c JOIN orders o ON o.id = c.order_id
    JOIN mandates m ON m.merchant_id = o.merchant_id AND m.ended_at IS NULL
    JOIN proposals p ON p.id = (SELECT id FROM proposals x WHERE x.claim_id = c.id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1)
    WHERE c.status = 'ready' AND p.claim_version = c.version AND p.created_at >= m.created_at
      AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.claim_id = c.id AND a.type IN ('agent.acted', 'agent.left_for_merchant') AND a.at >= p.created_at)
    ORDER BY c.created_at`).all().map((r) => r.id);
}

// What the rules would have done on the most recent reviewed requests, as if each were new and the
// day's total were zero. Read only; shown before the merchant turns the rules on.
export function replay(db, rules, { limit = 12, merchantId = DEMO } = {}) {
  const products = storeCatalog(db, merchantId);
  const mandate = checkRules(rules, products);
  const policy = currentPolicy(db, merchantId);
  return db.prepare(`SELECT c.id, c.ref, l.title, l.sku, p.route, p.amount_cents, p.calc_json, p.id proposal_id, a.findings_json
    FROM claims c JOIN order_lines l ON l.id = c.line_id JOIN orders o ON o.id = c.order_id AND o.merchant_id = ?
    JOIN proposals p ON p.id = (SELECT id FROM proposals x WHERE x.claim_id = c.id ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1)
    LEFT JOIN assessments a ON a.id = p.assessment_id
    ORDER BY c.created_at DESC LIMIT ?`).all(merchantId, limit).map((r) => {
    const proposal = { id: r.proposal_id, amount_cents: r.amount_cents, calc_json: r.calc_json };
    const d = decide(mandate, {
      ...policyFacts(json(r.calc_json)), route: r.route, amountCents: r.amount_cents, sku: r.sku,
      findings: json(r.findings_json), options: offerOptions(db, proposal).length, spentCents: 0, policy, products,
    });
    return { id: r.id, ref: r.ref, title: r.title, amountCents: r.amount_cents, act: d.act, why: d.why };
  });
}
