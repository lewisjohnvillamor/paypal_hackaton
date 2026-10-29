// The merchant's standing rules for the refund agent. The merchant writes them in plain English; an
// AI turns the words into the structure below, the server checks it, and the merchant reads it back
// (in words generated here from the structure, never the model's own) before turning it on. Only
// the structure is ever enforced, so what the merchant approved is exactly what the agent can do.
//
//   { rules: [{ skus, damage, maxRefundCents, action }], dailyLimitCents }
//   skus:   products the rule covers; empty means every product
//   damage: damage types (src/kinds.js) the rule covers; empty means any damage the AI saw
//   action: "refund" sends the drafted refund; "offer" sends the buyer the merchant's remedy list
//
// Pure: no I/O. decide() is the whole of the agent's judgment.
//
// products: the store's catalog, { sku: { sku, title, unitCents, category } }. The demo store's is
// src/catalog.js; a connected store's is what it has sold (storeCatalog() in autopilot.js).
import { PRODUCTS } from "../catalog.js";
import { KINDS, kindOf } from "../kinds.js";
import { formatUsd as usd } from "../money.js";
import { REASON_TEXT } from "../reasons.js";
import { isAutoRoute } from "../policy/refundPolicy.js";
import { AUTO_CEILING_CENTS, DEFAULT_POLICY } from "../policy/settings.js";

export const MAX_RULES = 8;
// No rule may let the agent send more than this on one request, whatever the words said.
export const AGENT_CEILING_CENTS = AUTO_CEILING_CENTS;
export const DEFAULT_DAILY_CENTS = 10000;
// The AI must be at least this sure of the damage type before a rule that names one applies.
export const DAMAGE_SURE = 0.5;
const ACTIONS = ["refund", "offer"];

// Damage types a product can have, by key, with the short label shown to the merchant. With no
// products (a store that has sold nothing yet), every damage type the photo check knows.
export function damageChoices(skus, products = PRODUCTS) {
  const categories = (skus ?? Object.keys(products)).map((sku) => products[sku]?.category);
  const out = {};
  for (const category of categories.length ? categories : Object.keys(KINDS)) {
    for (const [key, v] of Object.entries(kindOf(category).kinds)) if (key !== "none_visible") out[key] = v[1];
  }
  return out;
}

export class RuleError extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID_RULES";
    this.status = 400;
  }
}

// Check a structure (from the AI, or sent back by the browser) and return a clean copy.
export function checkRules(input, products = PRODUCTS) {
  const raw = Array.isArray(input?.rules) ? input.rules : [];
  if (!raw.length) throw new RuleError("No rule was found in that text. Say what the agent may refund on its own, for example \"refund chipped mugs under $25\".");
  if (raw.length > MAX_RULES) throw new RuleError(`Up to ${MAX_RULES} rules.`);
  const rules = raw.map((r, i) => {
    const skus = [...new Set(r.skus ?? [])];
    for (const s of skus) if (!products[s]) throw new RuleError(`Rule ${i + 1} names a product this store does not sell.`);
    const allowed = damageChoices(skus.length ? skus : undefined, products);
    const damage = [...new Set(r.damage ?? [])];
    for (const d of damage) if (!allowed[d]) throw new RuleError(`Rule ${i + 1} names a kind of damage those products cannot have.`);
    const max = r.maxRefundCents;
    if (!Number.isSafeInteger(max) || max <= 0) throw new RuleError(`Rule ${i + 1} needs a refund limit, for example "under $25".`);
    if (max > AGENT_CEILING_CENTS) throw new RuleError(`Rule ${i + 1}: the agent can refund at most ${usd(AGENT_CEILING_CENTS)} on one request without you.`);
    const action = ACTIONS.includes(r.action) ? r.action : "refund";
    return { skus, damage, maxRefundCents: max, action };
  });
  const top = Math.max(...rules.map((r) => r.maxRefundCents));
  let daily = input.dailyLimitCents ?? null;
  if (daily == null) daily = Math.max(DEFAULT_DAILY_CENTS, top);
  if (!Number.isSafeInteger(daily) || daily <= 0) throw new RuleError("The daily limit must be a positive amount.");
  if (daily < top) throw new RuleError(`The daily limit (${usd(daily)}) is below a rule's own limit (${usd(top)}).`);
  return { rules, dailyLimitCents: daily };
}

// How each damage type reads after a product in the read-back ("any mug with a crack or chip").
const AFTER_PRODUCT = {
  shattered: "broken into pieces", handle_off: "with a snapped-off handle", crack_or_chip: "with a crack or chip",
  stain: "with a stain", tear_or_hole: "with a tear or hole", seam_or_print: "with a split seam or peeling print",
  snapped: "with a broken headband or hinge", cushion_torn: "with a torn ear cushion", cosmetic: "with scratches or dents only",
};

const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

// The read-back the merchant approves: one sentence per rule, then the limits that always apply.
export function describeRules({ rules, dailyLimitCents }, products = PRODUCTS) {
  const labels = damageChoices([], products);
  const phrase = (d) => AFTER_PRODUCT[d] ?? `with ${labels[d] ?? d}`;
  const lines = rules.map((r) => {
    const what = r.skus.length ? `any ${list(r.skus.map((s) => lower(products[s]?.title ?? s)))}` : "any product";
    const damage = r.damage.length ? ` ${list(r.damage.map(phrase))}` : " with damage";
    const verb = r.action === "offer" ? "Let the buyer choose from your remedies, or a full refund, for" : "Refund";
    return `${verb} ${what}${damage}, up to ${usd(r.maxRefundCents)} a request.`;
  });
  return [
    ...lines,
    `Never more than ${usd(dailyLimitCents)} in a day without you.`,
    "When the photos can't be used, ask the buyer for clearer ones.",
    "Only when your refund policy marks a request safe to refund automatically; anything else waits for you.",
  ];
}

// The agent's judgment on one reviewed request. Returns { act, rule, code, why }: act is "refund",
// "offer", "decline", "ask" (ask the buyer for clearer photos) or null (leave it for the merchant),
// why is one sentence for the merchant. The refund policy's outcome comes first: the agent only
// refunds what the policy marked "auto_refund", and only declines what the shop's own records rule
// out. Asking for photos moves no money, so the agent does it whenever the policy says to.
// ctx: { route, reasons, decidedBy, hardReject, askForPhotos, amountCents, sku, findings, options,
//        spentCents, policy, products }
export function decide(mandate, ctx) {
  const leave = (code, why) => ({ act: null, rule: null, code, why });
  const policy = ctx.policy ?? DEFAULT_POLICY;
  const said = REASON_TEXT[ctx.decidedBy ?? ctx.reasons?.[0]];
  if (ctx.route === "request_info" || ctx.askForPhotos) {
    return { act: "ask", rule: null, code: "ASKING_FOR_PHOTOS", why: "The photos aren't usable, so the buyer was asked for clearer ones." };
  }
  if (ctx.route === "reject") {
    if (ctx.hardReject && policy.agentDeclines) return { act: "decline", rule: null, code: "POLICY_DECLINED", why: said ?? "The shop's records rule this request out." };
    return leave("POLICY_REJECTED", `The refund policy recommends no refund, and a person confirms that.${said ? ` ${said}` : ""}`);
  }
  if (!isAutoRoute(ctx.route)) {
    return leave("POLICY_FLAGGED", `The refund policy raised a concern, so you decide.${said ? ` ${said}` : ""}`);
  }
  // The policy's limits as they stand now; they may have been tightened since the case was drafted.
  if (ctx.amountCents > policy.autoRefundMaxCents) {
    return leave("OVER_LIMIT", `${usd(ctx.amountCents)} is above your ${usd(policy.autoRefundMaxCents)} automatic refund limit.`);
  }
  const f = ctx.findings ?? {};
  const products = ctx.products ?? PRODUCTS;
  const labels = damageChoices([], products);
  const product = products[ctx.sku] ? lower(products[ctx.sku].title) : "this product";
  const sure = (f.signals?.damage_kind?.confidence ?? 0) >= DAMAGE_SURE;

  const forProduct = mandate.rules.map((r, i) => ({ ...r, i })).filter((r) => !r.skus.length || r.skus.includes(ctx.sku));
  if (!forProduct.length) return leave("NO_RULE", `None of your rules covers the ${product}.`);
  const covering = forProduct.filter((r) => !r.damage.length || (sure && r.damage.includes(f.damage_kind)));
  if (!covering.length) {
    const seen = labels[f.damage_kind] ?? "this damage";
    return leave("NO_RULE", sure ? `Your rules for the ${product} don't cover ${seen}.` : `The AI wasn't sure enough of the kind of damage to apply a rule.`);
  }
  const within = covering.filter((r) => ctx.amountCents <= r.maxRefundCents);
  if (!within.length) {
    const limit = Math.max(...covering.map((r) => r.maxRefundCents));
    return leave("OVER_LIMIT", `${usd(ctx.amountCents)} is above your ${usd(limit)} limit for this.`);
  }
  const daily = Math.min(mandate.dailyLimitCents, policy.dailyAutoRefundCents);
  if (ctx.spentCents + ctx.amountCents > daily) {
    return leave("DAILY_LIMIT", `This would take the agent past your ${usd(daily)} daily limit (${usd(ctx.spentCents)} sent in the last 24 hours).`);
  }
  // A rule that offers remedies only applies when there is something to offer besides the refund.
  const rule = within.find((r) => r.action === "refund" || (ctx.options ?? 0) >= 2);
  if (!rule) return leave("NOTHING_TO_OFFER", "Your rule says to offer remedies, and none from your library fit this damage.");
  return {
    act: rule.action, rule: rule.i, code: "WITHIN_RULE",
    why: `Rule ${rule.i + 1}: ${rule.action === "offer" ? "remedies offered" : `${usd(ctx.amountCents)} refunded`}, within your ${usd(rule.maxRefundCents)} limit.`,
  };
}

// What the rule-writing AI may choose from: the store's products and each damage type with the
// products it applies to.
export function ruleVocabulary(catalog = PRODUCTS) {
  const products = Object.values(catalog).map((p) => ({ sku: p.sku, title: p.title, unitCents: p.unitCents }));
  const damage = new Map();
  for (const p of products) {
    for (const [key, label] of Object.entries(damageChoices([p.sku], catalog))) {
      const d = damage.get(key) ?? { key, label, skus: [] };
      d.skus.push(p.sku);
      damage.set(key, d);
    }
  }
  // A store that has sold nothing yet can still write rules for any product.
  if (!products.length) for (const [key, label] of Object.entries(damageChoices([], catalog))) damage.set(key, { key, label, skus: [] });
  return { products, damage: [...damage.values()] };
}
