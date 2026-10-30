// Fourth bug hunt: races between two calls for the same order or request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFindings, fakeAssess, fakePayPal } from "./helpers.js";
import { purchaseAndClaim, setup } from "./harness.js";
import { PRODUCTS } from "../src/catalog.js";

test("two capture calls for one order: the claim link the first one handed out keeps working", async () => {
  const pp = fakePayPal();
  const capture = pp.captureOrder;
  pp.captureOrder = async (...a) => { await new Promise((r) => setTimeout(r, 30)); return capture(...a); };
  const t = await setup({ pp });
  try {
    const o = await t.call("POST", "/api/demo/orders");
    const both = await Promise.all([1, 2].map(() => t.call("POST", `/api/demo/orders/${o.body.paypalOrderId}/capture`)));
    assert.deepEqual(both.map((r) => r.status), [200, 200]);
    const links = both.map((r) => r.body.claimUrl).filter(Boolean);
    assert.equal(links.length, 1, "only one call issues a link");
    assert.equal(both.filter((r) => r.body.alreadyCaptured).length, 1);
    const r = await t.call("GET", `/api/claim-link/${o.body.id}`, { headers: { "X-Claim-Token": links[0].split("#t=")[1] } });
    assert.equal(r.status, 200);
  } finally { t.close(); }
});

test("asking for photos while the AI is still checking: the request keeps waiting for the buyer", async () => {
  let release, calls = 0;
  const gate = new Promise((r) => (release = r));
  const fast = fakeAssess();
  const assess = async (a) => { if (++calls === 1) await gate; return fast(a); };
  const t = await setup({ assess });
  try {
    await t.login();
    // The claim call waits for the queue; file it without awaiting and act while the check runs.
    const filing = purchaseAndClaim(t);
    while (!t.db.prepare("SELECT 1 FROM claims").get() || calls === 0) await new Promise((r) => setTimeout(r, 5));
    const { id } = t.db.prepare("SELECT id FROM claims").get();
    const ask = t.merchant("POST", `/claims/${id}/request-info`, { message: "Please show the whole mug." });
    while (t.db.prepare("SELECT status FROM claims WHERE id = ?").get(id).status !== "needs_info") await new Promise((r) => setTimeout(r, 5));
    release();
    assert.equal((await ask).status, 200);
    await filing; await t.queue.idle();
    const c = t.db.prepare("SELECT status FROM claims WHERE id = ?").get(id);
    assert.equal(c.status, "needs_info");
  } finally { t.close(); }
});

test("a pick whose PayPal refund is declined is not shown to the buyer as their choice", async () => {
  const handleOff = { ...clearFindings, damage_kind: "handle_off", remedyFit: { kintsugi: 0.82, replacement: 0.9 } };
  const pp = fakePayPal({ refundBehavior: async () => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_NOT_ALLOWED" }] } }) });
  assert.ok(PRODUCTS["MUG-CLASSIC"].remedies.length);
  const t = await setup({ pp, assess: fakeAssess(handleOff) });
  try {
    const c = await purchaseAndClaim(t);
    await t.login();
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    assert.equal((await t.merchant("POST", `/claims/${c.claimId}/send-offer`, { claimVersion: d.claim.version, proposalId: d.proposal.id })).status, 200);
    const h = { headers: { "X-Claim-Token": c.statusToken } };
    const s = (await t.call("GET", `/api/claims/${c.claimId}/status`, h)).body;
    const r = await t.call("POST", `/api/claims/${c.claimId}/choose`, { body: { offerId: s.offer.id, optionId: "kintsugi" }, ...h });
    assert.equal(r.body.status, "ready"); // PayPal declined: back with the shop
    assert.equal(r.body.offer, null);
    assert.equal(r.body.refund, null);
  } finally { t.close(); }
});
