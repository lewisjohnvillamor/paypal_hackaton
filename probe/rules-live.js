// Live check of the rule reader: a few plain-English instructions through the real AI, then the
// server's own check and read-back. Run: node --env-file=<.env> probe/rules-live.js
import { parseRules } from "../src/ai/haiku.js";
import { checkRules, describeRules, ruleVocabulary } from "../src/agent/rules.js";

const TEXTS = [
  "Refund chipped mugs under $25 on your own. Ask me about anything above that.",
  "Refund any broken mug or vase up to $50. For stained or torn T-shirts up to $25, offer the buyer my remedies. Never more than $150 a day.",
  "Headphones with torn ear cushions: refund up to $40. Everything else comes to me.",
  "Just handle the small stuff yourself, I trust you.",
  "Refund cracked vases but only under ten bucks, and mugs with a snapped handle up to $20.",
];

for (const text of TEXTS) {
  try {
    const r = await parseRules({ text, ...ruleVocabulary() });
    let out;
    try { out = describeRules(checkRules(r)); } catch (err) { out = [`REFUSED: ${err.message}`]; }
    console.log(JSON.stringify({ text, ms: r.latencyMs, rules: r.rules, daily: r.dailyLimitCents, notUnderstood: r.notUnderstood, readback: out }, null, 1));
  } catch (err) {
    console.log(JSON.stringify({ text, error: err.message }));
  }
}
