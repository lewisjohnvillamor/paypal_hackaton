// Run-to-run stability probe: assess every labelled case several times with live Jev and report how
// often each finding flips between runs, and how often it is wrong.
// Usage: npm run probe:stability -- [runs] [filter]      (default 5 runs, all cases)
// The number that matters is the route: whether the merchant gets a one-click proposal, manual
// review, or a request for better photos. A finding can waver between "consistent" and "uncertain"
// without changing the route when another finding already sends the case to a person.
import { readFile, writeFile } from "node:fs/promises";
import { assessEvidence, TEMPLATE_VERSION } from "../src/ai/jev.js";
import { normalizeImage } from "../src/images.js";
import { draftProposal } from "../src/policy/refundPolicy.js";

const dir = new URL("./", import.meta.url);
const { reference, cases } = JSON.parse(await readFile(new URL("cases.json", dir), "utf8"));
const runs = Number(process.argv[2] || 5);
const filter = process.argv[3];
const ref = (await normalizeImage(await readFile(new URL(reference.file, dir)))).data;
const FIELDS = ["evidence_usable", "visible_breakage", "product_consistency", "design_match"];

const rows = [];
for (const c of cases.filter((c) => !filter || c.id.includes(filter))) {
  const photo = (await normalizeImage(await readFile(new URL(c.file, dir)))).data;
  const results = [];
  for (let i = 0; i < runs; i++) {
    try {
      results.push(await assessEvidence({ photos: [photo], reference: ref }));
    } catch (err) {
      results.push({ error: String(err.message || err) });
    }
  }
  const ok = results.filter((r) => !r.error);
  const row = { id: c.id, expected: c.expected, errors: results.length - ok.length, fields: {} };
  for (const f of FIELDS) {
    const got = ok.map((r) => r.findings[f]);
    const exp = c.expected[f];
    row.fields[f] = {
      got,
      flipped: new Set(got).size > 1,
      wrong: exp && exp !== "ambiguous" ? got.filter((g) => g !== "uncertain" && g !== exp).length : 0,
    };
  }
  // Route as the policy would draft it for a fresh one-unit claim with no record-based flags.
  const line = { unit_cents: 2000, quantity: 4 };
  const at = new Date().toISOString();
  row.routes = ok.map((r) => draftProposal({ line, quantity: 1, findings: r.findings, deliveredAt: at, claimedAt: at, refundableCents: 8000 }).route);
  row.routeFlipped = new Set(row.routes).size > 1;
  row.sameKind = ok.map((r) => r.findings.signals.same_kind_as_catalog);
  row.latencyMs = ok.map((r) => r.latencyMs);
  rows.push(row);
  console.log(`${c.id.padEnd(28)} ` + FIELDS.map((f) => `${f.split("_")[0]}=${row.fields[f].got.join("/")}`).join(" ") +
    ` route=${row.routes.join("/")} sameKind=${row.sameKind.map((x) => x.toFixed(2)).join(",")}`);
}

const total = (f, k) => rows.reduce((s, r) => s + (k === "flipped" ? Number(r.fields[f].flipped) : r.fields[f][k]), 0);
const lat = rows.flatMap((r) => r.latencyMs).sort((a, b) => a - b);
const summary = {
  ranAt: new Date().toISOString(),
  templateVersion: TEMPLATE_VERSION,
  runsPerCase: runs,
  cases: rows.length,
  errors: rows.reduce((s, r) => s + r.errors, 0),
  latencyMs: { median: lat[Math.floor(lat.length / 2)], p90: lat[Math.floor(lat.length * 0.9)] },
  casesWithARouteFlip: rows.filter((r) => r.routeFlipped).map((r) => r.id),
  oneClickProposals: rows.filter((r) => r.routes.includes("propose")).map((r) => `${r.id}: ${r.routes.filter((x) => x === "propose").length}/${r.routes.length}`),
  casesWithAFlip: Object.fromEntries(FIELDS.map((f) => [f, total(f, "flipped")])),
  wrongAnswers: Object.fromEntries(FIELDS.map((f) => [f, total(f, "wrong")])),
};
console.log(JSON.stringify(summary, null, 2));
const stamp = summary.ranAt.replace(/[:.]/g, "-");
await writeFile(new URL(`results/stability-${stamp}.json`, dir), JSON.stringify({ summary, rows }, null, 2));
