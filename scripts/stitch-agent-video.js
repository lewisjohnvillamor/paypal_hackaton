// Joins the recording from record-agent-video.js into one mp4 with sound: the main page, the PayPal
// popup in place (minus the sandbox sign-in), the waits marked as cuts removed, each voiceover line
// laid at the moment its caption appears, and background music ducked under the voice.
// Usage: node scripts/stitch-agent-video.js [dir] [music.mp3]   (needs ffmpeg)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const dir = process.argv[2] || "data/agent-video";
const music = process.argv[3] || process.env.MUSIC;
const t = JSON.parse(readFileSync(`${dir}/timeline.json`, "utf8"));
const END = 1e6;

// Wall clock -> main video time. The recorder flipped a corner square red/green/blue at every
// mark; read the square's colour frame by frame and pair the n-th flip with the n-th mark.
const FPS = 25;
const px = execFileSync("ffmpeg", ["-v", "error", "-i", t.main.file, "-vf", `fps=${FPS},crop=4:4:3:3,scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
const flips = [];
let last = null;
for (let f = 0; f * 3 + 2 < px.length; f++) {
  const [r, g, b] = px.subarray(f * 3, f * 3 + 3);
  const c = r > 170 && g < 90 && b < 90 ? 0 : g > 170 && r < 90 && b < 90 ? 1 : b > 170 && r < 90 && g < 90 ? 2 : null;
  if (c !== null && c !== last) { flips.push([f / FPS, c]); last = c; }
}
// A mark can be missed when the page was mid-load; mark n is colour n % 3, so a flip whose colour is
// not the next mark's means that mark left no trace, and it is skipped.
const pairs = [];
for (let n = 0, j = 0; n < t.marks.length && j < flips.length; n++) {
  if (flips[j][1] === n % 3) pairs.push([t.marks[n], flips[j++][0]]);
}
if (pairs.length !== t.marks.length) console.warn(`matched ${pairs.length} of ${t.marks.length} marks (${flips.length} flips seen)`);
function raw(at) {
  if (!pairs.length) return at;
  let i = pairs.findIndex(([m]) => m > at);
  if (i === -1) i = pairs.length;
  const [m0, v0] = pairs[Math.max(0, i - 1)];
  const [m1, v1] = pairs[Math.min(pairs.length - 1, i)];
  return m1 === m0 ? v0 + (at - m0) : v0 + ((at - m0) * (v1 - v0)) / (m1 - m0);
}
t.main.cuts = t.main.cuts.map(([a, b]) => [raw(a), raw(b)]);
const popupOpen = t.popup.open;
t.popup.mainOpen = raw(t.popup.open);
t.popup.mainClose = raw(t.popup.close);

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
for (const s of keep(0, t.popup.mainOpen)) segs.push([0, ...s]);
segs.push([1, t.popup.cut[1], t.popup.close - t.popup.open]); // the popup's loading and the sandbox sign-in are left out
for (const s of keep(t.popup.mainClose, END)) segs.push([0, ...s]);

const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", t.main.file]).toString());
segs[segs.length - 1][2] = Math.min(segs[segs.length - 1][2], duration);

// Where a moment on the recording clock lands in the cut video. A moment inside a cut moves to the
// end of that cut.
function place(at) {
  const inPopup = at >= popupOpen && at < t.popup.close;
  const local = inPopup ? at - popupOpen : raw(at);
  let out = 0;
  for (const [i, a, b] of segs) {
    if ((i === 1) === inPopup) {
      if (local < a) return out;
      if (local < b) return out + (local - a);
    }
    out += b - a;
  }
  return out;
}
const total = segs.reduce((n, [, a, b]) => n + (b - a), 0);

// One seeked input per kept span: trimming one long input many times makes ffmpeg buffer every
// frame between spans, which runs out of memory on a long take.
const inputs = segs.flatMap(([i, a, b]) => ["-ss", a.toFixed(3), "-to", b.toFixed(3), "-i", i === 1 ? t.popup.file : t.main.file]);
const fit = "fps=30,scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0x05070d,setsar=1";
const graph = [
  ...segs.map((_, n) => `[${n}:v]setpts=PTS-STARTPTS,${fit}[s${n}]`),
  `${segs.map((_, n) => `[s${n}]`).join("")}concat=n=${segs.length}:v=1:a=0,split[base][patch]`,
  "[patch]crop=12:12:14:0[p]",
  "[base][p]overlay=0:0,format=yuv420p[v]",
];
const lines = t.voice.lines;
lines.forEach((l, n) => {
  inputs.push("-i", `${t.voice.dir}/${l.key}.wav`);
  const ms = Math.round(place(l.at) * 1000);
  graph.push(`[${n + segs.length}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[l${n}]`);
});
graph.push(`${lines.map((_, n) => `[l${n}]`).join("")}amix=inputs=${lines.length}:normalize=0,apad,atrim=end=${total.toFixed(3)},volume=1.6,asplit=2[voice][key]`);
if (music) {
  inputs.push("-stream_loop", "-1", "-i", music);
  graph.push(`[${lines.length + segs.length}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=end=${total.toFixed(3)},volume=0.22,afade=t=in:d=1.5,afade=t=out:st=${(total - 3.5).toFixed(3)}:d=3.5[bed]`,
    "[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=600[ducked]",
    "[voice][ducked]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]");
} else graph.push("[voice]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]", "[key]anullsink");

const outFile = `${dir}/refund-relay-agents.mp4`;
execFileSync("ffmpeg", ["-y", "-v", "error", ...inputs, "-filter_complex", graph.join(";"), "-map", "[v]", "-map", "[a]",
  "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outFile], { stdio: "inherit" });
console.log(outFile, `${total.toFixed(1)} s`);
for (const l of lines) console.log(place(l.at).toFixed(1).padStart(6), l.key);
