// Gate 2 probe: run live Jev assessments over the labelled photo cases and report agreement.
// Usage: npm run probe            (all cases)
//        npm run probe -- broken   (cases whose id contains "broken")
import { readFile, writeFile } from "node:fs/promises";
import { assessEvidence, MODEL, TEMPLATE_VERSION } from "../src/ai/jev.js";
import { normalizeImage } from "../src/images.js";

const dir = new URL("./", import.meta.url);
const { reference, cases } = JSON.parse(await readFile(new URL("cases.json", dir), "utf8"));
const filter = process.argv[2];
const ref = (await normalizeImage(await readFile(new URL(reference.file, dir)))).data;

const rows = [];
for (const c of cases.filter((c) => !filter || c.id.includes(filter))) {
  const photo = (await normalizeImage(await readFile(new URL(c.file, dir)))).data;
  try {
    const r = await assessEvidence({ photos: [photo], reference: ref });
    rows.push({ id: c.id, expected: c.expected, got: r.findings, model: r.model, usage: r.usage, latencyMs: r.latencyMs });
  } catch (err) {
    rows.push({ id: c.id, expected: c.expected, error: String(err.message || err) });
  }
  const last = rows.at(-1);
  console.log(last.error ? `${c.id}: ERROR ${last.error}` :
    `${c.id.padEnd(22)} usable=${last.got.evidence_usable.padEnd(9)} breakage=${last.got.visible_breakage.padEnd(9)} ` +
    `(exp ${c.expected.visible_breakage.padEnd(9)}) kind=${last.got.product_consistency.padEnd(12)} ` +
    `(exp ${c.expected.product_consistency}) ${last.latencyMs}ms`);
}

// A definite wrong answer is the costly error. "uncertain" routes to a person, so it is tracked
// separately as an abstention rather than counted as correct.
function score(field) {
  let right = 0, wrong = 0, abstain = 0, n = 0;
  for (const r of rows.filter((r) => !r.error)) {
    const exp = r.expected[field], got = r.got[field];
    if (exp === "ambiguous") continue;
    n++;
    if (got === "uncertain") abstain++;
    else if (got === exp) right++;
    else wrong++;
  }
  return { n, right, wrong, abstain };
}

const ok = rows.filter((r) => !r.error);
const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
const summary = {
  ranAt: new Date().toISOString(),
  model: ok[0]?.model ?? MODEL,
  templateVersion: TEMPLATE_VERSION,
  cases: rows.length,
  errors: rows.length - ok.length,
  latencyMs: { median: lat[Math.floor(lat.length / 2)], max: lat.at(-1) },
  inputTokens: ok.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0),
  outputTokens: ok.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0),
  visible_breakage: score("visible_breakage"),
  product_consistency: score("product_consistency"),
  evidence_usable: score("evidence_usable"),
};
console.log(JSON.stringify(summary, null, 2));
const stamp = summary.ranAt.replace(/[:.]/g, "-");
await writeFile(new URL(`results/${stamp}.json`, dir), JSON.stringify({ summary, rows }, null, 2));
