// The merchant's refund policy settings: how much each kind of damage is worth, how far the
// automatic path may go on one request and in one day, and how sure the photo check must be. The
// decision itself (src/policy/refundPolicy.js) is plain code over these numbers, so the same facts
// and the same settings always give the same outcome. Every saved version is kept; a proposal
// records the version it was drafted under.
import { randomUUID } from "node:crypto";
import { audit, now, tx } from "../db.js";
import { DAMAGE_LABELS } from "../kinds.js";
import { formatUsd as usd } from "../money.js";

// Severity is fixed per damage type; the refund percentage for each is the merchant's.
//   total:    nothing left to use (in pieces)
//   major:    no longer does its job (snapped handle, crack, hole)
//   moderate: works, with a visible defect (split seam, torn cushion)
//   minor:    looks worse, works as new (scratches, a stain)
export const SEVERITY = {
  shattered: "total", handle_off: "major", crack_or_chip: "major", snapped: "major", tear_or_hole: "major",
  seam_or_print: "moderate", cushion_torn: "moderate", stain: "minor", cosmetic: "minor",
};
export const SEVERITY_LABEL = {
  total: "Destroyed", major: "Can't be used", moderate: "Usable, visibly damaged", minor: "Cosmetic only",
};

// No setting may let the automatic path refund more than this on one request.
export const AUTO_CEILING_CENTS = Number(process.env.AGENT_CEILING_CENTS || 20000);
const DAILY_CEILING_CENTS = 100000;

export const DEFAULT_POLICY = Object.freeze({
  refundPercent: Object.freeze({
    shattered: 100, handle_off: 100, crack_or_chip: 100, snapped: 100, tear_or_hole: 100,
    seam_or_print: 50, cushion_torn: 40, stain: 30, cosmetic: 20,
  }),
  claimWindowDays: 14,
  autoRefundMaxCents: 5000,      // above this a person decides, whatever the photos show
  dailyAutoRefundCents: 15000,   // the most the agent sends on its own in any 24 hours
  minDamageSeen: 0.8,            // photo check at least this sure damage is visible
  noDamageBelow: 0.2,            // at or under this, the photos show no damage: decline
  minDamageTypeSure: 0.6,        // photo check at least this sure of the kind of damage
  agentDeclines: true,           // the agent closes requests the shop's own records rule out
});

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID_POLICY";
    this.status = 400;
  }
}

const between = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

// Check settings (from the browser) and return a clean copy. Missing fields keep their defaults.
export function checkPolicy(input = {}) {
  const p = { ...DEFAULT_POLICY, ...input, refundPercent: { ...DEFAULT_POLICY.refundPercent, ...(input.refundPercent ?? {}) } };
  for (const key of Object.keys(p.refundPercent)) {
    if (!SEVERITY[key]) throw new PolicyError(`Unknown kind of damage: ${key}.`);
    const v = p.refundPercent[key];
    if (!Number.isInteger(v) || v < 0 || v > 100) throw new PolicyError(`The refund for ${DAMAGE_LABELS[key]} must be a whole percentage from 0 to 100.`);
  }
  if (!Number.isInteger(p.claimWindowDays) || !between(p.claimWindowDays, 1, 90)) throw new PolicyError("The reporting window must be 1 to 90 days.");
  if (!Number.isSafeInteger(p.autoRefundMaxCents) || !between(p.autoRefundMaxCents, 1, AUTO_CEILING_CENTS)) {
    throw new PolicyError(`The automatic refund limit must be between $0.01 and ${usd(AUTO_CEILING_CENTS)}.`);
  }
  if (!Number.isSafeInteger(p.dailyAutoRefundCents) || !between(p.dailyAutoRefundCents, p.autoRefundMaxCents, DAILY_CEILING_CENTS)) {
    throw new PolicyError(`The daily limit must be at least the per-request limit (${usd(p.autoRefundMaxCents)}) and at most ${usd(DAILY_CEILING_CENTS)}.`);
  }
  // Tighter than the photo check's own cut-offs is allowed; looser is not.
  if (!between(p.minDamageSeen, 0.8, 0.99)) throw new PolicyError("How sure the photo check must be that damage is visible: 80% to 99%.");
  if (!between(p.noDamageBelow, 0.01, 0.2)) throw new PolicyError("The no-damage cut-off must be 1% to 20%.");
  if (!between(p.minDamageTypeSure, 0.5, 0.95)) throw new PolicyError("How sure the photo check must be of the kind of damage: 50% to 95%.");
  if (typeof p.agentDeclines !== "boolean") throw new PolicyError("agentDeclines must be true or false.");
  return {
    refundPercent: Object.fromEntries(Object.keys(SEVERITY).map((k) => [k, p.refundPercent[k]])),
    claimWindowDays: p.claimWindowDays, autoRefundMaxCents: p.autoRefundMaxCents, dailyAutoRefundCents: p.dailyAutoRefundCents,
    minDamageSeen: p.minDamageSeen, noDamageBelow: p.noDamageBelow, minDamageTypeSure: p.minDamageTypeSure, agentDeclines: p.agentDeclines,
  };
}

// The settings in force: the latest saved version, or the defaults (id null) before any save.
export function currentPolicy(db) {
  const row = db.prepare("SELECT id, settings_json, created_at FROM policy_settings ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
  return row ? { id: row.id, savedAt: row.created_at, ...checkPolicy(JSON.parse(row.settings_json)) } : { id: null, savedAt: null, ...checkPolicy() };
}

export function savePolicy(db, input, actor) {
  const settings = checkPolicy(input);
  return tx(db, () => {
    const id = randomUUID();
    db.prepare("INSERT INTO policy_settings (id, settings_json, actor, created_at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(settings), actor, now());
    audit(db, { actor, type: "policy.saved", payload: { policyId: id, ...settings } });
    return currentPolicy(db);
  });
}

// The severity table as the merchant reads it, one row per damage type.
export function severityTable(settings) {
  return Object.entries(SEVERITY).map(([kind, level]) => ({
    kind, label: DAMAGE_LABELS[kind], level, levelLabel: SEVERITY_LABEL[level], percent: settings.refundPercent[kind],
  }));
}
