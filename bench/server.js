// Load-test server: the real app with a fake PayPal and a stub Jev (no network, no cost).
// The stub mimics what the live sample measured: about 200 ms + 20 ms per photo, and a
// max_tokens_exceeded error once a single call carries too many image tokens.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fakePayPal, clearFindings } from "../tests/helpers.js";
import { createApp } from "../src/server.js";
import { openDb } from "../src/db.js";

const TOKEN_CAP = 32_000;
const STUB_FINDINGS = { ...clearFindings, signals: { evidence_usable: 0.95, visible_breakage: 0.93, same_kind_as_catalog: 0.9, same_design: 0.85, looks_like_stock_photo: 0.05, instructions_in_photo: 0.01 } };
const stats = { jevCalls: 0, jevPhotos: 0, jevTokens: 0, jevRejected: 0, inFlight: 0, maxInFlight: 0 };
const tokensFor = (buf) => 1200 + Math.round(buf.length / 100); // rough: bigger images cost more
async function stubAssess({ photos, reference }) {
  stats.jevCalls++;
  stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
  try {
    const tokens = 1500 + tokensFor(reference) + photos.reduce((s, p) => s + tokensFor(p), 0);
    await new Promise((r) => setTimeout(r, 200 + 20 * photos.length));
    if (tokens > TOKEN_CAP) {
      stats.jevRejected++;
      throw Object.assign(new Error('400 {"detail":{"error_type":"max_tokens_exceeded"}}'), { status: 400 });
    }
    stats.jevPhotos += photos.length; stats.jevTokens += tokens;
    return { model: "stub-jev", findings: STUB_FINDINGS, answers: {}, usage: { input_tokens: tokens, output_tokens: 224 }, latencyMs: 200 };
  } finally { stats.inFlight--; }
}

const db = openDb(process.env.DATABASE_PATH);
const seed = Number(process.env.SEED || 0);
if (seed) {
  // Bulk history: `seed` past orders, each with a closed claim and 3 photo fingerprints.
  const t = Date.now();
  db.exec("BEGIN");
  const ins = {
    o: db.prepare("INSERT INTO orders (id, paypal_order_id, capture_id, amount_cents, currency, buyer_email, delivered_at, created_at) VALUES (?, ?, ?, 8000, 'USD', ?, ?, ?)"),
    l: db.prepare("INSERT INTO order_lines (id, order_id, sku, title, quantity, unit_cents, ref_image) VALUES (?, ?, 'mug-white', 'White mug', 4, 2000, 'catalog-mug.jpg')"),
    c: db.prepare("INSERT INTO claims (id, ref, order_id, line_id, quantity, statement, status, version, token_hash, token_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'seeded', 'closed', 2, 'x', ?, ?, ?)"),
    e: db.prepare("INSERT INTO evidence (id, claim_id, storage_key, sha256, phash, width, height, bytes, created_at) VALUES (?, ?, 'none', 'x', ?, 1, 1, 1, ?)"),
    a: db.prepare("INSERT INTO audit (claim_id, actor, type, at) VALUES (?, 'buyer', 'claim.submitted', ?)"),
  };
  const ts = new Date(Date.now() - 200 * 86400e3).toISOString();
  const rnd = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  for (let i = 0; i < seed; i++) {
    const o = randomUUID(), l = randomUUID(), c = randomUUID();
    ins.o.run(o, `SEED-${i}`, `SEEDCAP-${i}`, `seed${i % 5000}@example.com`, ts, ts);
    ins.l.run(l, o);
    ins.c.run(c, `RS-${i}`, o, l, ts, ts, ts);
    for (let k = 0; k < 3; k++) ins.e.run(randomUUID(), c, rnd(), ts);
    ins.a.run(c, ts);
  }
  db.exec("COMMIT");
  console.error(`seeded ${seed} claims in ${Date.now() - t} ms`);
}

const { app } = createApp({ db, pp: fakePayPal(), assess: stubAssess });
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
app.get("/__bench", (_req, res) => res.json({
  ...stats, rssMB: Math.round(process.memoryUsage().rss / 1e6),
  loopP99Ms: Math.round(lag.percentile(99) / 1e6), loopMaxMs: Math.round(lag.max / 1e6),
}));
app.post("/__bench/reset", (_req, res) => { lag.reset(); Object.assign(stats, { maxInFlight: 0 }); res.json({ ok: true }); });
const server = createServer((req, res) => {
  if (req.url === "/api/claims") stats.lastUploadBytes = Number(req.headers["content-length"] || 0);
  app(req, res);
}).listen(Number(process.env.PORT || 0), () => console.log(`READY ${server.address().port}`));
