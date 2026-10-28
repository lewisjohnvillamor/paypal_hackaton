// Many photos, many claims, long histories. Jev and PayPal are test doubles; bench/ has the timings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFindings, fakeAssess, fakePayPal, testPhoto } from "./helpers.js";
import { fileClaim, purchase, purchaseAndClaim, setup } from "./harness.js";
import { pickForModel, AI_MAX_PHOTOS } from "../src/ai/select.js";
import { anyNearOtherClaim } from "../src/photoIndex.js";
import { openDb } from "../src/db.js";

let n = 0;
const uniqueEmails = () => fakePayPal({ payerEmail: () => `scale${++n}@example.com` });
const detail = async (t, id) => (await t.merchant("GET", `/claims/${id}`)).body;

test("a claim with 100 photos is stored in full and the model sees the best 8", async () => {
  let seen = 0;
  const t = await setup({ pp: uniqueEmails(), assess: async (input) => { seen = input.photos.length; return fakeAssess()(); } });
  try {
    const photos = await Promise.all(Array.from({ length: 100 }, (_, i) => testPhoto(1000 + i)));
    const c = await purchaseAndClaim(t, { photos });
    await t.login();
    const d = await detail(t, c.claimId);
    assert.equal(d.evidence.length, 100);
    assert.equal(seen, AI_MAX_PHOTOS);
    assert.equal(d.assessment.photosSent, AI_MAX_PHOTOS);
    assert.equal(d.evidence.filter((e) => e.sentToAi).length, AI_MAX_PHOTOS);
    assert.equal(d.proposal.route, "auto_refund");
  } finally { t.close(); }
});

test("damage boxes land on the photos Jev saw, in the order it saw them", async () => {
  const box = { top: 0.1, bottom: 0.5, left: 0.2, right: 0.6 };
  // Box only for the second photo the model sees; the first had no confident damage.
  const assess = async ({ photos }) => ({ ...(await fakeAssess()()),
    findings: { ...clearFindings, locations: photos.map((_, i) => (i === 1 ? { damaged: 0.95, box } : { damaged: 0.3, box: null })) } });
  const t = await setup({ pp: uniqueEmails(), assess });
  try {
    const photos = await Promise.all(Array.from({ length: 3 }, (_, i) => testPhoto(5000 + i)));
    const c = await purchaseAndClaim(t, { photos });
    await t.login();
    const d = await detail(t, c.claimId);
    assert.deepEqual(d.evidence.map((e) => e.damageBox), [null, box, null]);
    assert.equal(d.proposal.route, "auto_refund"); // display only: policy is unchanged
  } finally { t.close(); }
});

test("if the photos exceed the model's token budget the set is halved, not failed", async () => {
  const calls = [];
  const assess = async ({ photos }) => {
    calls.push(photos.length);
    if (photos.length > 3) throw new Error('400 {"detail":{"error_type":"max_tokens_exceeded"}}');
    return fakeAssess()();
  };
  const t = await setup({ pp: uniqueEmails(), assess });
  try {
    const c = await purchaseAndClaim(t, { photos: await Promise.all(Array.from({ length: 12 }, (_, i) => testPhoto(2000 + i))) });
    await t.login();
    const d = await detail(t, c.claimId);
    assert.deepEqual(calls, [8, 4, 2]);
    assert.equal(d.assessment.error, null);
    assert.equal(d.assessment.photosSent, 2);
  } finally { t.close(); }
});

test("photo picking puts the newest upload first, then the sharpest, and skips near-duplicates", () => {
  const e = (id, created_at, sharpness, phash) => ({ id, created_at, sharpness, phash });
  const old = "2026-01-01T00:00:00.000Z", fresh = "2026-01-02T00:00:00.000Z";
  const evidence = [
    e("blurry", old, 5, "0000000000000000"),
    e("sharp", old, 900, "ffffffffffffffff"),
    e("sharp-copy", old, 899, "fffffffffffffff0"), // 4 bits away from "sharp"
    e("mid", old, 400, "00000000ffffffff"),
    e("new", fresh, 1, "0f0f0f0f0f0f0f0f"),
  ];
  assert.deepEqual(pickForModel(evidence, 3).map((x) => x.id), ["sharp", "mid", "new"]);
  assert.equal(pickForModel(evidence, 10).length, 5, "under the cap everything is sent");
});

test("assessment runs in a bounded queue: a burst of claims never exceeds the concurrency", async () => {
  let inFlight = 0, max = 0;
  const assess = async () => {
    max = Math.max(max, ++inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
    return fakeAssess()();
  };
  const t = await setup({ pp: uniqueEmails(), assess });
  try {
    const orders = [];
    for (let i = 0; i < 8; i++) orders.push(await purchase(t));
    // All from one address, so the per-IP claim limit (5 a minute) refuses some; the rest queue.
    const results = await Promise.all(orders.map((o) => fileClaim(t, o)));
    assert.ok(results.every((r) => r.status === 201 || r.status === 429));
    await t.queue.idle();
    assert.ok(max <= t.queue.stats().concurrency, `max in flight ${max}`);
    assert.ok(t.queue.stats().completed >= 5);
  } finally { t.close(); }
});

test("claims left waiting by a restart are picked up again", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess() });
  try {
    const c = await purchaseAndClaim(t);
    t.db.prepare("UPDATE claims SET status = 'new', version = version + 1 WHERE id = ?").run(c.claimId);
    assert.equal(t.queue.resume(), 1);
    await t.queue.idle();
    await t.login();
    const d = await detail(t, c.claimId);
    assert.equal(d.claim.status, "ready");
    assert.equal(d.proposal.current, true);
  } finally { t.close(); }
});

test("the reused-photo index follows inserts and deletions", () => {
  const db = openDb(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  const add = (id, claim, phash) => db.prepare("INSERT INTO evidence (id, claim_id, storage_key, sha256, phash, width, height, bytes, created_at) VALUES (?, ?, 'k', 's', ?, 1, 1, 1, 'now')").run(id, claim, phash);
  add("a", "c1", "ffffffffffffffff");
  assert.equal(anyNearOtherClaim(db, "c2", ["fffffffffffffff0"], 8), true);
  assert.equal(anyNearOtherClaim(db, "c1", ["fffffffffffffff0"], 8), false, "own photos never count");
  assert.equal(anyNearOtherClaim(db, "c2", ["0000000000000000"], 8), false);
  add("b", "c3", "0000000000000001");
  assert.equal(anyNearOtherClaim(db, "c2", ["0000000000000000"], 8), true, "new rows are seen");
  db.prepare("DELETE FROM evidence WHERE id = 'b'").run();
  assert.equal(anyNearOtherClaim(db, "c2", ["0000000000000000"], 8), false, "deleted rows are dropped");
});

test("the merchant inbox pages instead of returning every claim", async () => {
  const t = await setup({ pp: uniqueEmails(), assess: fakeAssess(clearFindings) });
  try {
    for (let i = 0; i < 3; i++) await purchaseAndClaim(t);
    await t.login();
    const first = (await t.merchant("GET", "/claims?limit=2")).body;
    assert.equal(first.length, 2);
    const rest = (await t.merchant("GET", `/claims?limit=2&before=${encodeURIComponent(first[1].created_at)}`)).body;
    assert.equal(rest.length, 1);
    assert.ok(!first.some((c) => c.id === rest[0].id));
  } finally { t.close(); }
});

test("health check reports the database and the queue", async () => {
  const t = await setup();
  try {
    const h = await t.call("GET", "/healthz");
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    assert.equal(typeof h.body.queue.waiting, "number");
  } finally { t.close(); }
});

test("backups are consistent copies, pruned to the newest few", async () => {
  const { mkdtempSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { backup } = await import("../src/db.js");
  const dir = mkdtempSync(join(tmpdir(), "rr-backup-"));
  const db = openDb(join(dir, "live.db"));
  db.prepare("INSERT INTO audit (actor, type, at) VALUES ('system', 'test', 'now')").run();
  for (let i = 0; i < 3; i++) { backup(db, { dir: join(dir, "b"), keep: 2 }); await new Promise((r) => setTimeout(r, 5)); }
  const files = readdirSync(join(dir, "b"));
  assert.equal(files.length, 2);
  assert.equal(openDb(join(dir, "b", files[1])).prepare("SELECT COUNT(*) n FROM audit").get().n, 1);
});
