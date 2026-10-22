// Load test. Starts bench/server.js in a child process (fresh on-disk SQLite, fake PayPal, stub Jev)
// and drives it over HTTP like real buyers and a merchant would.
//   node bench/run.js               all scenarios
//   node bench/run.js big burst     only those
// Each simulated buyer sends from its own 127.0.0.x address so per-IP rate limits behave as they
// would for distinct people.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { phonePhotos } from "./photos.js";

const only = process.argv.slice(2);
const want = (name) => !only.length || only.includes(name);

async function startServer(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rr-bench-"));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", new URL("./server.js", import.meta.url).pathname], {
    env: { ...process.env, DATABASE_PATH: join(dir, "db.sqlite"), UPLOAD_DIR: join(dir, "uploads"), REPEAT_CLAIM_LIMIT: "1", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { const m = /READY (\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    child.on("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  const peakRssMB = () => Math.round(Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${child.pid}/status`, "utf8"))[1]) / 1024);
  return { port, child, peakRssMB, stop: () => child.kill() };
}

function http(port, method, path, { body, headers = {}, ip = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers, localAddress: ip }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const jsonBody = (o) => ({ body: JSON.stringify(o), headers: { "Content-Type": "application/json" } });
async function multipart(form) {
  const r = new Response(form);
  return { body: Buffer.from(await r.arrayBuffer()), headers: { "Content-Type": r.headers.get("content-type") } };
}

async function buyerClaim(port, ip, photos) {
  const order = await http(port, "POST", "/api/demo/orders", { ip });
  const cap = await http(port, "POST", `/api/demo/orders/${order.body.paypalOrderId}/capture`, { ip });
  const token = cap.body.claimUrl.split("#t=")[1];
  const link = await http(port, "GET", `/api/claim-link/${order.body.id}`, { ip, headers: { "X-Claim-Token": token } });
  const form = new FormData();
  form.set("orderId", order.body.id);
  form.set("lineId", link.body.lines[0].id);
  form.set("quantity", "1");
  form.set("statement", "One mug arrived shattered.");
  for (const p of photos) form.append("photos", new Blob([p], { type: "image/jpeg" }), "p.jpg");
  const mp = await multipart(form);
  const t = performance.now();
  const res = await http(port, "POST", "/api/claims", { ip, body: mp.body, headers: { ...mp.headers, "X-Claim-Token": token } });
  return { ...res, submitMs: performance.now() - t, startedAt: t };
}

async function merchant(port) {
  const login = await http(port, "POST", "/api/merchant/login", jsonBody({ password: process.env.MERCHANT_PASSWORD || "test-password" }));
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  return (method, path, opts = {}) => http(port, method, `/api/merchant${path}`, { ...opts, headers: { ...opts.headers, Cookie: cookie, "X-Refund-Relay": "1" } });
}

// Time until the merchant sees a drafted proposal (covers both inline and queued assessment).
async function untilProposal(m, claimId, startedAt, timeoutMs = 120_000) {
  for (;;) {
    const d = await m("GET", `/claims/${claimId}`);
    if (d.body?.proposal?.current) return { readyMs: performance.now() - startedAt, route: d.body.proposal.route, aiError: d.body.assessment?.error ?? null, aiPhotos: d.body.assessment?.photosSent ?? null };
    if (performance.now() - startedAt > timeoutMs) return { readyMs: NaN, route: "timeout" };
    await new Promise((r) => setTimeout(r, 25));
  }
}

const pct = (xs, p) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null; };
const results = {};
const raw = await phonePhotos(100);
// What the claim page sends after its in-browser shrink (public/photos.js): 1568 px JPEG.
const shrunk = await Promise.all(raw.map((p) => sharp(p).resize(1568, 1568, { fit: "inside" }).jpeg({ quality: 88 }).toBuffer()));
const photos = raw;
console.error(`photos ready: ${photos.length}, avg ${(photos.reduce((s, b) => s + b.length, 0) / photos.length / 1e6).toFixed(2)} MB`);

for (const [name, cfg] of Object.entries({
  single3: { claims: 1, photos: 3 },
  big: { claims: 1, photos: 100 },
  big30: { claims: 1, photos: 30 },
  burst: { claims: 40, photos: 3 },
  burstBig: { claims: 10, photos: 20 },
  bigShrunk: { claims: 1, photos: 100, shrunk: true },
  burstShrunk: { claims: 40, photos: 3, shrunk: true },
})) {
  if (!want(name)) continue;
  const srv = await startServer();
  try {
    const m = await merchant(srv.port);
    await http(srv.port, "POST", "/__bench/reset");
    const t0 = performance.now();
    const subs = await Promise.all(Array.from({ length: cfg.claims }, (_, i) =>
      buyerClaim(srv.port, `127.0.${1 + Math.floor(i / 250)}.${1 + (i % 250)}`, (cfg.shrunk ? shrunk : photos).slice((i * cfg.photos) % 100, (i * cfg.photos) % 100 + cfg.photos).concat(cfg.shrunk ? shrunk : photos).slice(0, cfg.photos))));
    const ok = subs.filter((s) => s.status === 201);
    const ready = await Promise.all(ok.map((s) => untilProposal(m, s.body.claimId, s.startedAt)));
    const wall = performance.now() - t0;
    const stats = (await http(srv.port, "GET", "/__bench")).body;
    results[name] = {
      claims: cfg.claims, photosPerClaim: cfg.photos, browserShrunk: !!cfg.shrunk,
      accepted: ok.length, rejected: subs.filter((s) => s.status !== 201).map((s) => `${s.status} ${s.body?.error}`).slice(0, 3),
      submitP50: pct(subs.map((s) => s.submitMs), 0.5), submitP95: pct(subs.map((s) => s.submitMs), 0.95),
      readyP50: pct(ready.map((r) => r.readyMs), 0.5), readyP95: pct(ready.map((r) => r.readyMs), 0.95),
      wallMs: Math.round(wall), routes: [...new Set(ready.map((r) => r.route))], aiErrors: ready.filter((r) => r.aiError).length,
      jevCalls: stats.jevCalls, jevPhotos: stats.jevPhotos, jevTokens: stats.jevTokens, jevMaxInFlight: stats.maxInFlight,
      loopMaxMs: stats.loopMaxMs, peakRssMB: srv.peakRssMB(),
    };
    console.error(name, JSON.stringify(results[name]));
  } finally { srv.stop(); }
}

if (want("history")) {
  // A shop with a long history: claim submission and the merchant inbox against 20k past claims.
  const srv = await startServer({ SEED: "20000" });
  try {
    const m = await merchant(srv.port);
    const subs = [];
    for (let i = 0; i < 5; i++) subs.push(await buyerClaim(srv.port, `127.0.9.${i + 1}`, photos.slice(i * 3, i * 3 + 3)));
    const ready = [];
    for (const s of subs) ready.push(await untilProposal(m, s.body.claimId, s.startedAt));
    const inboxMs = [];
    let inboxBytes = 0;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const r = await m("GET", "/claims");
      inboxMs.push(performance.now() - t);
      inboxBytes = JSON.stringify(r.body).length;
    }
    results.history = {
      seededClaims: 20000, readyP50: pct(ready.map((r) => r.readyMs), 0.5), inboxP50: pct(inboxMs, 0.5), inboxKB: Math.round(inboxBytes / 1024),
      loopMaxMs: (await http(srv.port, "GET", "/__bench")).body.loopMaxMs, peakRssMB: srv.peakRssMB(),
    };
    console.error("history", JSON.stringify(results.history));
  } finally { srv.stop(); }
}

console.log(JSON.stringify(results, null, 2));
