// The refund agent. After every review it reads the merchant's standing rules (src/agent/rules.js)
// and either acts on them, sending a PayPal refund or the buyer's choices with no click, or leaves
// the case for the merchant with one sentence on why. It acts through the same gate as a merchant's
// own approval (reserve, then submit), so every PayPal safeguard still applies: the ledger check,
// one open refund per payment, the refundable balance, idempotent retries.
import { randomUUID } from "node:crypto";
import { audit, now, tx } from "../db.js";
import { checkPayPalLedger, reserve, submit } from "../refunds/execute.js";
import { openOffer } from "../offers.js";
import { offerOptions } from "../suggest/suggestions.js";
import { checkRules, decide, describeRules } from "./rules.js";
import { agentSpent } from "./spend.js";
import { closeClaim } from "../claims.js";
import { currentPolicy } from "../policy/settings.js";
import { BUYER_DECLINE } from "../reasons.js";

export { agentSpent };

const json = (s) => (s ? JSON.parse(s) : null);

const view = (m) => !m ? null : {
  id: m.id, text: m.text, ...json(m.rules_json), model: m.model, createdAt: m.created_at,
  readback: describeRules(json(m.rules_json)),
};

export const activeMandate = (db) =>
  view(db.prepare("SELECT * FROM mandates WHERE ended_at IS NULL ORDER BY created_at DESC LIMIT 1").get());

// Turning rules on replaces whatever was on before; the old ones stay on record.
export function saveMandate(db, { text, rules, model = null, actor }) {
  const checked = checkRules(rules);
  const words = String(text ?? "").trim().slice(0, 1000);
  return tx(db, () => {
    const ts = now();
    db.prepare("UPDATE mandates SET ended_at = ? WHERE ended_at IS NULL").run(ts);
    const id = randomUUID();
    db.prepare("INSERT INTO mandates (id, text, rules_json, model, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, words, JSON.stringify(checked), model, actor, ts);
    audit(db, { actor, type: "agent.rules_on", payload: { mandateId: id, ...checked } });
    return activeMandate(db);
  });
}

export function stopMandate(db, actor) {
  const r = db.prepare("UPDATE mandates SET ended_at = ? WHERE ended_at IS NULL").run(now());
  if (r.changes) audit(db, { actor, type: "agent.rules_off" });
}

const policyFacts = (calc) => ({
  reasons: calc.reasons ?? [], decidedBy: calc.decidedBy ?? null, hardReject: !!calc.hardReject, askForPhotos: !!calc.askForPhotos,
});

// Facts the agent decides on, for a case still waiting on its current proposal.
function caseFacts(db, claimId) {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
  if (!claim || claim.status !== "ready") return null;
  const proposal = db.prepare("SELECT * FROM proposals WHERE claim_id = ? ORDER BY created_at DESC LIMIT 1").get(claimId);
  if (!proposal || proposal.claim_version !== claim.version) return null;
  const assessment = db.prepare("SELECT findings_json FROM assessments WHERE id = ?").get(proposal.assessment_id);
  const line = db.prepare("SELECT sku FROM order_lines WHERE id = ?").get(claim.line_id);
  return {
    claim, proposal,
    ctx: {
      ...policyFacts(json(proposal.calc_json)), route: proposal.route, amountCents: proposal.amount_cents,
      sku: line.sku, findings: json(assessment?.findings_json), options: offerOptions(db, proposal).length,
      spentCents: agentSpent(db), policy: currentPolicy(db),
    },
  };
}

const leave = (db, claimId, mandateId, code, why) => {
  audit(db, { claimId, actor: "agent", type: "agent.left_for_merchant", payload: { mandateId, code, why } });
  return { act: null, code, why };
};

// Run once per review. Returns the decision (or null when no rules are on or the case moved on).
export async function runAgent(db, paypal, claimId) {
  const mandate = activeMandate(db);
  if (!mandate) return null;
  const first = caseFacts(db, claimId);
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
      const current = activeMandate(db);
      const facts = caseFacts(db, claimId);
      if (!current || current.id !== mandate.id || !facts || facts.claim.version !== first.claim.version) throw Object.assign(new Error("The case or your rules changed while the agent checked it."), { code: "CHANGED" });
      const again = decide(current, facts.ctx);
      if (again.act !== d.act) throw Object.assign(new Error(again.why), { code: again.code });
      audit(db, { claimId, actor: "agent", type: "agent.acted", payload: { mandateId: mandate.id, act: d.act, rule: d.rule, why: d.why } });
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
  if (op) await submit(db, paypal, op, "agent");
  return d;
}

// What the rules would have done on the most recent reviewed requests, as if each were new and the
// day's total were zero. Read only; shown before the merchant turns the rules on.
export function replay(db, rules, limit = 12) {
  const mandate = checkRules(rules);
  const policy = currentPolicy(db);
  return db.prepare(`SELECT c.id, c.ref, l.title, l.sku, p.route, p.amount_cents, p.calc_json, p.id proposal_id, a.findings_json
    FROM claims c JOIN order_lines l ON l.id = c.line_id
    JOIN proposals p ON p.id = (SELECT id FROM proposals x WHERE x.claim_id = c.id ORDER BY x.created_at DESC LIMIT 1)
    LEFT JOIN assessments a ON a.id = p.assessment_id
    ORDER BY c.created_at DESC LIMIT ?`).all(limit).map((r) => {
    const proposal = { id: r.proposal_id, amount_cents: r.amount_cents, calc_json: r.calc_json };
    const d = decide(mandate, {
      ...policyFacts(json(r.calc_json)), route: r.route, amountCents: r.amount_cents, sku: r.sku,
      findings: json(r.findings_json), options: offerOptions(db, proposal).length, spentCents: 0, policy,
    });
    return { id: r.id, ref: r.ref, title: r.title, amountCents: r.amount_cents, act: d.act, why: d.why };
  });
}
