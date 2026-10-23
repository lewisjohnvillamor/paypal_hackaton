// Live check of the non-mug products: Jev reads each photo with that product's own questions,
// ranks its remedies, and Claude Haiku suggests from the in-stock listings for it.
//   node --env-file=.env probe/products-live.js
// Needs TYPESAFE_API_KEY; Haiku runs too when ANTHROPIC_API_KEY is set.
import { readFile } from "node:fs/promises";
import { aiCopy } from "../src/images.js";
import { PRODUCTS } from "../src/catalog.js";
import { assessEvidence } from "../src/ai/jev.js";
import { resolutionOptions } from "../src/policy/refundPolicy.js";
import { candidatesFor } from "../src/suggest/candidates.js";
import { checkSuggestions } from "../src/suggest/suggestions.js";
import { suggestRemedies } from "../src/ai/haiku.js";

// [photo in probe/products/, sku, what the photo shows]
const CASES = JSON.parse(await readFile(new URL("products/cases.json", import.meta.url), "utf8"));
const pct = (p) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "-");

for (const { file, sku, expect } of CASES) {
  const product = PRODUCTS[sku];
  const reference = await aiCopy(await readFile(new URL(`../public/assets/${product.refImage}`, import.meta.url)));
  const photo = await aiCopy(await readFile(new URL(`products/${file}`, import.meta.url)));
  const remedies = product.remedies.map((r) => ({ ...r }));
  console.log(`\n${file} (${sku}, expect ${expect})`);
  try {
    const r = await assessEvidence({ photos: [photo], reference, remedies, category: product.category });
    const f = r.findings, s = f.signals;
    console.log(`  Jev ${r.latencyMs} ms: damage ${f.visible_breakage} (${pct(s.visible_breakage)}), type ${f.damage_kind} (${pct(s.damage_kind.confidence)}), ` +
      `same kind ${f.product_consistency} (${pct(s.same_kind_as_catalog)}, ${s.item_kind.choice}), design ${f.design_match}, usable ${f.evidence_usable}, box ${f.locations?.[0]?.box ? "drawn" : "none"}`);
    console.log(`  remedy fit: ${Object.entries(f.remedyFit ?? {}).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}`);
    const options = resolutionOptions({ remedies, quantity: 1, findings: f, amountCents: product.unitCents });
    console.log(`  offered: ${options.map((o) => o.title).join(" | ") || "(refund only)"}`);
    const candidates = candidatesFor(sku, f);
    if (process.env.ANTHROPIC_API_KEY && f.visible_breakage === "yes" && candidates.length) {
      const h = await suggestRemedies({ photos: [photo], reference, product, findings: f, candidates });
      const kept = checkSuggestions(h.suggestions, { candidates, unitCents: product.unitCents });
      console.log(`  Haiku ${h.latencyMs} ms from ${candidates.length} listings (${candidates.map((c) => c.id).join(", ")}):`);
      for (const k of kept) console.log(`    ${k.listing.id} +$${(k.refundUnitCents / 100).toFixed(2)}: ${k.title} | ${k.why}`);
      if (!kept.length) console.log("    (none kept)");
    }
  } catch (err) {
    console.log(`  failed: ${err.message}`);
  }
}
