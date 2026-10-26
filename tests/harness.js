// Shared HTTP harness for workflow tests: in-memory DB, fake PayPal and fake Jev (test doubles).
import assert from "node:assert/strict";
import { fakeAssess, fakePayPal, testPhoto } from "./helpers.js";
import { createApp } from "../src/server.js";
import { openDb } from "../src/db.js";

export async function setup({ pp = fakePayPal(), assess = fakeAssess(), suggest = null, match = null } = {}) {
  const db = openDb(":memory:");
  const { app, queue } = createApp({ db, pp, assess, suggest, match });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const call = async (method, path, { body, headers = {}, form } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: form ?? (body ? JSON.stringify(body) : undefined),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const out = { status: res.status, body: await res.json().catch(() => null) };
    await queue.idle(); // assessment runs in the queue; tests read the settled result
    return out;
  };
  const merchant = (method, path, body) => call(method, `/api/merchant${path}`, { body, headers: { "X-Refund-Relay": "1" } });
  return { db, pp, queue, call, merchant, close: () => server.close(), login: () => call("POST", "/api/merchant/login", { body: { password: "test-password" } }) };
}

export async function purchase(t) {
  const order = await t.call("POST", "/api/demo/orders");
  assert.equal(order.status, 201);
  const cap = await t.call("POST", `/api/demo/orders/${order.body.paypalOrderId}/capture`);
  assert.equal(cap.status, 200, JSON.stringify(cap.body));
  return { orderId: order.body.id, token: cap.body.claimUrl.split("#t=")[1] };
}

// Files a claim; returns the raw response so tests can check rejections.
export async function fileClaim(t, { orderId, token }, { quantity = 1, statement = "One mug arrived shattered.", photos } = {}) {
  const link = await t.call("GET", `/api/claim-link/${orderId}`, { headers: { "X-Claim-Token": token } });
  const form = new FormData();
  form.set("orderId", orderId);
  form.set("lineId", link.body.lines[0].id);
  form.set("quantity", String(quantity));
  form.set("statement", statement);
  for (const p of photos ?? [await testPhoto()]) form.append("photos", new Blob([p], { type: "image/jpeg" }), "p.jpg");
  return t.call("POST", "/api/claims", { form, headers: { "X-Claim-Token": token } });
}

export async function purchaseAndClaim(t, opts = {}) {
  const o = await purchase(t);
  const claim = await fileClaim(t, o, opts);
  assert.equal(claim.status, 201, JSON.stringify(claim.body));
  return { ...o, claimId: claim.body.claimId, statusToken: claim.body.statusUrl.split("#t=")[1] };
}

export const approve = (t, d, extra = {}) => t.merchant("POST", `/api/merchant/claims/${d.claim.id}/approve-refund`.replace("/api/merchant", ""), {
  claimVersion: d.claim.version, proposalId: d.proposal.id, amountCents: d.proposal.amountCents, ...extra,
});
