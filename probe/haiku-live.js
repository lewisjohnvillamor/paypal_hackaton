// Live check of Claude Haiku suggestions on the probe photos. Needs ANTHROPIC_API_KEY.
//   node --env-file=.env probe/haiku-live.js
// Jev's reading is fixed per photo here, so only Haiku varies. Prints each suggestion, what the
// server's checks kept, and the token cost at the Haiku 5.5 rates checked on 2026-10-22.
import { readFile } from "node:fs/promises";
import { aiCopy } from "../src/images.js";
import { PRODUCTS } from "../src/catalog.js";
import { candidatesFor } from "../src/suggest/candidates.js";
import { checkSuggestions } from "../src/suggest/suggestions.js";
import { suggestRemedies } from "../src/ai/haiku.js";

const CASES = [
  ["chipped-closeup.jpg", "crack_or_chip"],
  ["broken-handle-white.jpg", "handle_off"],
  ["broken-shards-bubblewrap.jpg", "shattered"],
  ["broken-in-packing.jpg", "shattered"],
];
const IN = 0.10 / 1e6, OUT = 0.50 / 1e6;
const product = PRODUCTS["MUG-CLASSIC"];
const reference = await readFile(new URL(`../public/assets/${product.refImage}`, import.meta.url));
let total = 0;
for (const [file, damage_kind] of CASES) {
  const photo = await aiCopy(await readFile(new URL(`cases/${file}`, import.meta.url)));
  const findings = { visible_breakage: "yes", evidence_usable: "yes", damage_kind };
  const candidates = candidatesFor(product.sku, findings);
  try {
    const r = await suggestRemedies({ photos: [photo], reference: await aiCopy(reference), product, findings, candidates });
    const kept = checkSuggestions(r.suggestions, { candidates, unitCents: product.unitCents });
    const cost = r.usage.input_tokens * IN + r.usage.output_tokens * OUT;
    total += cost;
    console.log(`\n${file} (${damage_kind}): ${candidates.length} candidates, ${r.latencyMs} ms, ${r.usage.input_tokens} in / ${r.usage.output_tokens} out, $${cost.toFixed(5)}`);
    for (const s of r.suggestions) {
      const ok = kept.some((k) => k.listing.id === s.listingId && k.title === s.title.trim());
      console.log(`  ${ok ? "kept   " : "DROPPED"} ${s.listingId} +$${(s.refundUnitCents / 100).toFixed(2)}: ${s.title} | ${s.why}`);
    }
    if (!r.suggestions.length) console.log("  (no suggestions)");
  } catch (err) {
    console.log(`\n${file}: failed: ${err.message}`);
  }
}
console.log(`\nTotal $${total.toFixed(5)} for ${CASES.length} calls`);
