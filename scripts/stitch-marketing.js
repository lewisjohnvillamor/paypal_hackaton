// Joins the recording from record-marketing.js into one mp4: the main page, the PayPal popup in
// place (minus the sandbox sign-in), and the waits marked as cuts removed.
// Usage: node scripts/stitch-marketing.js [dir]   (needs ffmpeg)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const dir = process.argv[2] || "data/marketing";
const t = JSON.parse(readFileSync(`${dir}/timeline.json`, "utf8"));
const END = 1e6;

// Main-video spans to keep, before and after the popup, with the cuts taken out.
function keep(from, to) {
  const spans = [];
  let at = from;
  for (const [a, b] of [...t.main.cuts].sort((x, y) => x[0] - y[0])) {
    if (b <= at || a >= to) continue;
    if (a > at) spans.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < to) spans.push([at, to]);
  return spans;
}
const segs = [];
if (t.popup) {
  for (const s of keep(0, t.popup.open)) segs.push([0, ...s]);
  segs.push([1, 0, t.popup.cut[0]], [1, t.popup.cut[1], t.popup.close - t.popup.open]);
  for (const s of keep(t.popup.close, END)) segs.push([0, ...s]);
} else for (const s of keep(0, END)) segs.push([0, ...s]);

const inputs = ["-i", t.main.file, ...(t.popup ? ["-i", t.popup.file] : [])];
const fit = "fps=30,scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0x05070d,setsar=1";
const parts = segs.map(([i, a, b], n) => `[${i}:v]trim=start=${a.toFixed(2)}${b < END ? `:end=${b.toFixed(2)}` : ""},setpts=PTS-STARTPTS,${fit}[s${n}]`);
const graph = `${parts.join(";")};${segs.map((_, n) => `[s${n}]`).join("")}concat=n=${segs.length}:v=1:a=0,format=yuv420p[v]`;
const outFile = `${dir}/refund-relay-marketing.mp4`;
execFileSync("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-movflags", "+faststart", outFile], { stdio: "inherit" });
console.log(outFile);
