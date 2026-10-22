// Small live sample: how Jev latency and token usage grow with the number of photos in one call.
// Uses the real API (costs tokens); keep the sizes and repeats small.
import { readdirSync, readFileSync } from "node:fs";
import { assessEvidence } from "../src/ai/jev.js";
import { normalizeImage } from "../src/images.js";

const CASES = new URL("../probe/cases/", import.meta.url).pathname;
const sizes = (process.argv[2] || "1,3,6,12").split(",").map(Number);
const files = readdirSync(CASES).filter((f) => f.startsWith("broken") || f.startsWith("chipped"));
const photos = [];
for (let i = 0; i < Math.max(...sizes); i++) photos.push((await normalizeImage(readFileSync(CASES + files[i % files.length]))).data);
const reference = readFileSync(new URL("../public/assets/catalog-mug.jpg", import.meta.url));

for (const n of sizes) {
  const t = Date.now();
  try {
    const r = await assessEvidence({ photos: photos.slice(0, n), reference });
    const kb = Math.round(photos.slice(0, n).reduce((s, b) => s + b.length, 0) / 1024);
    console.log(JSON.stringify({ photos: n, uploadKB: kb, wallMs: Date.now() - t, usage: r.usage, breakage: r.findings.visible_breakage }));
  } catch (err) {
    console.log(JSON.stringify({ photos: n, wallMs: Date.now() - t, error: String(err.message).slice(0, 200), status: err.status }));
  }
}
