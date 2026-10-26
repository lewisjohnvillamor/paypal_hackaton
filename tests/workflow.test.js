// Workflow and financial-invariant tests over HTTP, using a fake PayPal and fake Jev (test doubles).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePayPal, testPhoto } from "./helpers.js";
import { approve, purchaseAndClaim, setup } from "./harness.js";
import { reconcile, reconcileOpen } from "../src/refunds/execute.js";

test("happy path: $80 purchase, one broken mug, $20 approved refund reaches PayPal once", async () => {
  const t = await setup();
  try {
    const { claimId } = await purchaseAndClaim(t);
    await t.login();
    const d = (await t.merchant("GET", `/claims/${claimId}`)).body;
    assert.equal(d.proposal.route, "propose");
    assert.equal(d.proposal.amountCents, 2000);
    const r = await approve(t, d);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.claim.status, "refunded");
    assert.equal(r.body.refunds[0].status, "COMPLETED");
    assert.equal(r.body.payment.refundableCents, 6000);
    assert.equal(t.pp.calls.refunds.length, 1);
    assert.deepEqual(t.pp.calls.refunds[0].body.amount, { currency_code: "USD", value: "20.00" });
  } finally { t.close(); }
});

test("duplicate and concurrent approvals produce one PayPal refund", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const pp = fakePayPal({ refundBehavior: async () => { await gate; } });
  const t = await setup({ pp });
  try {
    const { claimId } = await purchaseAndClaim(t);
    await t.login();
    const d = (await t.merchant("GET", `/claims/${claimId}`)).body;
    const all = Promise.all([approve(t, d), approve(t, d), approve(t, d)]);
    setTimeout(release, 50);
    const results = await all;
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 2);
    assert.equal(pp.calls.refunds.length, 1);
    const again = await approve(t, d);
    assert.equal(again.status, 409);
    assert.equal(pp.calls.refunds.length, 1);
  } finally { t.close(); }
});

test("amount tampering is rejected: zero, negative, over balance, and unexplained overrides", async () => {
  const t = await setup();
  try {
    const { claimId } = await purchaseAndClaim(t);
    await t.login();
    const d = (await t.merchant("GET", `/claims/${claimId}`)).body;
    assert.equal((await approve(t, d, { amountCents: 0 })).body.error, "INVALID_AMOUNT");
    assert.equal((await approve(t, d, { amountCents: -500 })).body.error, "INVALID_AMOUNT");
    assert.equal((await approve(t, d, { amountCents: 20.5 })).body.error, "INVALID_AMOUNT");
    assert.equal((await approve(t, d, { amountCents: 2500 })).body.error, "REASON_REQUIRED");
    assert.equal((await approve(t, d, { amountCents: 9000, reason: "goodwill" })).body.error, "INSUFFICIENT_REFUNDABLE_BALANCE");
    assert.equal(t.pp.calls.refunds.length, 0);
    const ok = await approve(t, d, { amountCents: 2500, reason: "Goodwill for the hassle" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.approvals[0].override_reason, "Goodwill for the hassle");
  } finally { t.close(); }
});

test("stale approval after new evidence is rejected", async () => {
  const t = await setup();
  try {
    const { claimId, statusToken } = await purchaseAndClaim(t);
    await t.login();
    const d = (await t.merchant("GET", `/claims/${claimId}`)).body;
    await t.merchant("POST", `/claims/${claimId}/request-info`, { message: "Please show the handle." });
    const form = new FormData();
    form.append("photos", new Blob([await testPhoto()], { type: "image/jpeg" }), "p2.jpg");
    const more = await t.call("POST", `/api/claims/${claimId}/evidence`, { form, headers: { "X-Claim-Token": statusToken } });
    assert.equal(more.status, 200, JSON.stringify(more.body));
    assert.equal((await approve(t, d)).body.error, "STALE_CASE");
    assert.equal(t.pp.calls.refunds.length, 0);
  } finally { t.close(); }
});

test("PayPal timeout leaves the refund UNKNOWN and reserved; reconcile reuses the same request ID", async () => {
  let fail = true;
  const pp = fakePayPal({ refundBehavior: async () => { if (fail) throw new Error("socket hang up"); } });
  const t = await setup({ pp });
  try {
    const { claimId } = await purchaseAndClaim(t);
    await t.login();
    const d = (await t.merchant("GET", `/claims/${claimId}`)).body;
    const r = await approve(t, d);
    assert.equal(r.body.refunds[0].status, "UNKNOWN");
    assert.equal(r.body.claim.status, "refund_processing");
    assert.equal(r.body.payment.refundableCents, 6000, "funds stay reserved while unknown");

    fail = false;
    const after = await t.merchant("POST", `/refunds/${r.body.refunds[0].id}/reconcile`);
    assert.equal(after.body.refunds[0].status, "COMPLETED");
    assert.equal(pp.calls.refunds.length, 2);
    assert.equal(pp.calls.refunds[0].requestId, pp.calls.refunds[1].requestId);
  } finally { t.close(); }
});

test("open operations survive a restart and reconcile without a new logical refund", async () => {
  let fail = true;
  const pp = fakePayPal({ refundBehavior: async () => { if (fail) return { status: 503, body: {} }; } });
  const t = await setup({ pp });
  try {
    const { claimId } = await purchaseAndClaim(t);
    await t.login();
    const d = (await t.merchant("GET", `/claims/${claimId}`)).body;
    await approve(t, d);
    fail = false;
    assert.equal(await reconcileOpen(t.db, pp), 1); // what the server runs at startup
    const op = t.db.prepare("SELECT * FROM refund_ops").all();
    assert.equal(op.length, 1);
    assert.equal(op[0].status, "COMPLETED");
  } finally { t.close(); }
});

test("PayPal rejection fails the operation and releases funds for a fresh approval", async () => {
  let reject = true;
  const pp = fakePayPal({ refundBehavior: async () => reject ? { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_NOT_ALLOWED" }] } } : null });
  const t = await setup({ pp });
  try {
    const { claimId } = await purchaseAndClaim(t);
    await t.login();
    let d = (await t.merchant("GET", `/claims/${claimId}`)).body;
    const r = await approve(t, d);
    assert.equal(r.body.refunds[0].status, "FAILED");
    assert.equal(r.body.refunds[0].error, "REFUND_NOT_ALLOWED");
    assert.equal(r.body.payment.refundableCents, 8000);
    assert.equal(r.body.claim.status, "ready");
    // The earlier approval is spent; the merchant must re-review and approve the new version.
    assert.equal((await approve(t, d)).status, 409);
    reject = false;
    await t.merchant("POST", `/claims/${claimId}/assess`);
    d = (await t.merchant("GET", `/claims/${claimId}`)).body;
    assert.equal((await approve(t, d)).body.claim.status, "refunded");
  } finally { t.close(); }
});

test("one active request per order; a second claim cannot reserve the same funds", async () => {
  const t = await setup();
  try {
    const { orderId, token } = await purchaseAndClaim(t);
    const link = await t.call("GET", `/api/claim-link/${orderId}`, { headers: { "X-Claim-Token": token } });
    const form = new FormData();
    form.set("orderId", orderId);
    form.set("lineId", link.body.lines[0].id);
    form.set("quantity", "1");
    form.set("statement", "Another one broke too.");
    form.append("photos", new Blob([await testPhoto()], { type: "image/jpeg" }), "p.jpg");
    const second = await t.call("POST", "/api/claims", { form, headers: { "X-Claim-Token": token } });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "ACTIVE_CLAIM_EXISTS");
  } finally { t.close(); }
});

test("access control: no merchant session, no CSRF header, wrong claim tokens", async () => {
  const t = await setup();
  try {
    const { claimId, orderId } = await purchaseAndClaim(t);
    assert.equal((await t.call("GET", `/api/merchant/claims/${claimId}`)).status, 401);
    assert.equal((await t.call("POST", "/api/merchant/login", { body: { password: "nope" } })).status, 401);
    await t.login();
    const noHeader = await t.call("POST", `/api/merchant/claims/${claimId}/close`, { body: { reason: "x y z" } });
    assert.equal(noHeader.status, 403);
    assert.equal((await t.call("GET", `/api/claim-link/${orderId}`, { headers: { "X-Claim-Token": "guess" } })).status, 403);
    assert.equal((await t.call("GET", `/api/claims/${claimId}/status`, { headers: { "X-Claim-Token": "guess" } })).status, 403);
  } finally { t.close(); }
});

test("AI failure still yields a reviewable case with no invented findings", async () => {
  const t = await setup({ assess: async () => { throw new Error("Jev unavailable"); } });
  try {
    const { claimId } = await purchaseAndClaim(t);
    await t.login();
    const d = (await t.merchant("GET", `/claims/${claimId}`)).body;
    assert.equal(d.assessment.findings, null);
    assert.match(d.assessment.error, /unavailable/);
    assert.equal(d.proposal.route, "manual_review");
    assert.ok(d.proposal.reasons.includes("AI_UNAVAILABLE"));
  } finally { t.close(); }
});

test("non-image uploads are rejected before a claim is created", async () => {
  const t = await setup();
  try {
    const order = await t.call("POST", "/api/demo/orders");
    const cap = await t.call("POST", `/api/demo/orders/${order.body.paypalOrderId}/capture`);
    const token = cap.body.claimUrl.split("#t=")[1];
    const link = await t.call("GET", `/api/claim-link/${order.body.id}`, { headers: { "X-Claim-Token": token } });
    const form = new FormData();
    form.set("orderId", order.body.id);
    form.set("lineId", link.body.lines[0].id);
    form.set("quantity", "1");
    form.set("statement", "Broken mug, see photo");
    form.append("photos", new Blob(["<svg/>"], { type: "image/jpeg" }), "x.jpg");
    const r = await t.call("POST", "/api/claims", { form, headers: { "X-Claim-Token": token } });
    assert.equal(r.status, 400);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM claims").get().n, 0);
  } finally { t.close(); }
});

test("demo sign-ins are published only when PUBLIC_DEMO=1", async () => {
  const t = await setup();
  const saved = { ...process.env };
  try {
    delete process.env.PUBLIC_DEMO;
    assert.equal((await t.call("GET", "/api/config")).body.demo, null);
    Object.assign(process.env, { PUBLIC_DEMO: "1", DEMO_BUYER_EMAIL: "judge@example.com" });
    const { demo } = (await t.call("GET", "/api/config")).body;
    assert.equal(demo.merchantPassword, process.env.MERCHANT_PASSWORD);
    assert.equal(demo.buyerEmail, "judge@example.com");
    assert.equal(demo.buyerPassword, null);
  } finally {
    for (const k of ["PUBLIC_DEMO", "DEMO_BUYER_EMAIL"]) if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
    t.close();
  }
});
