// Multi-merchant tests: sign-up, PayPal connection, secret keys, POST /v1/orders, and a connected
// store's request refunded through its own PayPal account. PayPal and Jev are test doubles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeAssess, fakePayPal, testPhoto } from "./helpers.js";
import { createApp } from "../src/server.js";
import { openDb } from "../src/db.js";
import { decrypt } from "../src/merchants/crypto.js";
import { fetchCatalogImage } from "../src/merchants/register.js";

// A connected merchant's own PayPal app (test double). `orders` are the checkouts it captured.
function merchantPayPal(orders) {
  const calls = { refunds: [], getOrder: 0 };
  const refunds = new Map();
  return {
    calls,
    async accessToken() { return "token"; },
    async getOrder(id) {
      calls.getOrder++;
      const o = orders[id];
      if (!o) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      const own = [...refunds.values()];
      return {
        status: 200,
        body: {
          id, status: "COMPLETED", payer: { email_address: "shopper@example.com" },
          purchase_units: [{
            payee: { merchant_id: o.payee ?? "SHOPPAYEE1" },
            payments: {
              captures: o.uncaptured ? [] : [{ id: `CAP-${id}`, status: own.length ? "PARTIALLY_REFUNDED" : "COMPLETED", amount: { currency_code: o.currency ?? "USD", value: o.total }, create_time: "2026-10-28T10:00:00Z" }],
              refunds: own,
            },
          }],
        },
      };
    },
    async refundCapture(captureId, body, requestId) {
      calls.refunds.push({ captureId, body, requestId });
      if (!refunds.has(requestId)) refunds.set(requestId, { id: `SHOPREF-${refunds.size + 1}`, status: "COMPLETED", amount: body.amount });
      return { status: 201, body: refunds.get(requestId) };
    },
    async getRefund(id) {
      const r = [...refunds.values()].find((x) => x.id === id);
      return r ? { status: 200, body: r } : { status: 404, body: {} };
    },
  };
}

process.env.PAYPAL_CLIENT_ID ||= "DemoStoreClientId_0123456789";
const CLIENT_ID = "AcmeSandboxClientId_0123456789";
const SECRET = "AcmeSandboxSecret_abcdefghijklmnop";

async function platform(orders = {}) {
  const shop = merchantPayPal(orders);
  const credentials = [];
  const paypalFor = (c) => {
    credentials.push(c);
    return c.clientSecret === SECRET ? shop : { accessToken: async () => { throw Object.assign(new Error("PayPal OAuth failed"), { status: 401 }); } };
  };
  const photo = await testPhoto(42);
  const db = openDb(":memory:");
  const demo = fakePayPal();
  const { app, queue } = createApp({ db, pp: demo, paypalFor, fetchImage: async () => photo, assess: fakeAssess(), suggest: null, match: null, parseRules: null });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map(); // one cookie per browser
  const call = async (method, path, { body, headers = {}, form, as = "shop" } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(jar.get(as) ? { Cookie: jar.get(as) } : {}), ...(method !== "GET" ? { "X-Refund-Relay": "1" } : {}), ...headers },
      body: form ?? (body ? JSON.stringify(body) : undefined),
    });
    const set = res.headers.get("set-cookie");
    if (set) jar.set(as, set.split(";")[0]);
    const out = { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
    await queue.idle();
    return out;
  };
  const api = (key, method, path, body) => call(method, path, { body, as: "server", headers: key ? { Authorization: `Bearer ${key}` } : {} });
  return { db, demo, shop, credentials, call, api, base, close: () => server.close() };
}

const ORDER = (id = "5O190127TN364715T", extra = {}) => ({
  paypal_order_id: id,
  items: [{ sku: "BOWL-01", title: "Hand-thrown stoneware mug", quantity: 2, unit_price: "18.50", category: "ceramic-mug", image_url: "https://cdn.example.com/mug.jpg" }],
  ...extra,
});

async function connectedShop(p) {
  const s = await p.call("POST", "/api/dashboard/signup", { body: { name: "Acme Ceramics", email: "Owner@Acme.test", password: "correct horse battery" } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const c = await p.call("PUT", "/api/dashboard/paypal", { body: { clientId: CLIENT_ID, clientSecret: SECRET } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const k = await p.call("POST", "/api/dashboard/keys", { body: { label: "Production server" } });
  assert.equal(k.status, 201);
  return { merchant: s.body.merchant, key: k.body.created.key };
}

test("sign-up, PayPal connection and keys: secrets are checked with PayPal, encrypted, and keys shown once", async () => {
  const p = await platform();
  try {
    const s = await p.call("POST", "/api/dashboard/signup", { body: { name: "Acme Ceramics", email: "owner@acme.test", password: "correct horse battery" } });
    assert.equal(s.status, 201);
    assert.equal((await p.call("POST", "/api/dashboard/signup", { body: { name: "Again", email: "OWNER@acme.test", password: "correct horse battery" }, as: "other" })).body.error, "EMAIL_TAKEN");
    assert.equal((await p.call("POST", "/api/dashboard/signup", { body: { name: "Weak", email: "weak@acme.test", password: "short" }, as: "other" })).status, 400);
    let o = (await p.call("GET", "/api/dashboard")).body;
    assert.deepEqual(o.checklist.map((x) => x.done), [false, false, false, false]);
    assert.equal(o.demo, false);

    const bad = await p.call("PUT", "/api/dashboard/paypal", { body: { clientId: CLIENT_ID, clientSecret: "WrongSecret_abcdefghijklmnop" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "PAYPAL_REJECTED");
    assert.equal(p.db.prepare("SELECT COUNT(*) n FROM paypal_connections").get().n, 0);

    const ok = await p.call("PUT", "/api/dashboard/paypal", { body: { clientId: CLIENT_ID, clientSecret: SECRET } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.connection.source, "merchant");
    assert.ok(!JSON.stringify(ok.body).includes(SECRET), "the secret never comes back");
    const row = p.db.prepare("SELECT * FROM paypal_connections").get();
    assert.ok(!row.secret_enc.includes(SECRET), "stored encrypted");
    assert.equal(decrypt(row.secret_enc), SECRET);

    const k = await p.call("POST", "/api/dashboard/keys", { body: { label: "Server" } });
    assert.match(k.body.created.key, /^rr_sk_test_/);
    assert.ok(!JSON.stringify(k.body.keys).includes(k.body.created.key), "the list shows a prefix, not the key");
    assert.ok(!JSON.stringify(p.db.prepare("SELECT * FROM api_keys").all()).includes(k.body.created.key), "only a hash is stored");
    o = (await p.call("GET", "/api/dashboard")).body;
    assert.deepEqual(o.checklist.map((x) => x.done), [true, true, false, false]);

    // Sign out and back in with the email, case-insensitively.
    await p.call("POST", "/api/merchant/logout");
    assert.equal((await p.call("GET", "/api/dashboard")).status, 401);
    assert.equal((await p.call("POST", "/api/dashboard/login", { body: { email: "owner@acme.test", password: "wrong password!" } })).status, 401);
    assert.equal((await p.call("POST", "/api/dashboard/login", { body: { email: "Owner@Acme.test", password: "correct horse battery" } })).status, 200);
    assert.equal((await p.call("GET", "/api/dashboard")).body.merchant.name, "Acme Ceramics");
  } finally { p.close(); }
});

test("POST /v1/orders checks the order in the merchant's own PayPal account before issuing a claim link", async () => {
  const p = await platform({
    "5O190127TN364715T": { total: "37.00" },
    "7AB12345CD678901E": { total: "99.00" },
    "8UNCAPTURED00001X": { total: "37.00", uncaptured: true },
    "9OTHERPAYEE00001X": { total: "37.00", payee: "SOMEONEELSE" },
    "3EURORDER0000001X": { total: "37.00", currency: "EUR" },
  });
  try {
    const { key } = await connectedShop(p);
    assert.equal((await p.api(null, "POST", "/v1/orders", ORDER())).status, 401);
    assert.equal((await p.api("rr_sk_test_" + "x".repeat(32), "POST", "/v1/orders", ORDER())).status, 401);

    const bad = (body) => p.api(key, "POST", "/v1/orders", body);
    assert.equal((await bad(ORDER("5O190127TN364715T", { items: [{ ...ORDER().items[0], category: "sofa" }] }))).status, 400);
    assert.equal((await bad(ORDER("5O190127TN364715T", { items: [{ ...ORDER().items[0], image_url: "http://cdn.example.com/a.jpg" }] }))).status, 400);
    assert.equal((await bad(ORDER("5O190127TN364715T", { items: [{ ...ORDER().items[0], unit_price: "-1" }] }))).status, 400);
    assert.equal((await bad(ORDER("NOTONPAYPAL00001X"))).body.error, "ORDER_NOT_FOUND");
    const mismatch = await bad(ORDER("7AB12345CD678901E"));
    assert.equal(mismatch.status, 422);
    assert.match(mismatch.body.message, /captured 99.00 USD but the items add up to 37.00/);
    assert.match((await bad(ORDER("8UNCAPTURED00001X"))).body.message, /no capture yet/);
    assert.match((await bad(ORDER("3EURORDER0000001X"))).body.message, /only USD/);
    assert.equal(p.db.prepare("SELECT COUNT(*) n FROM orders").get().n, 0, "nothing stored for a rejected order");

    const r = await p.api(key, "POST", "/v1/orders", ORDER());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.amount.value, "37.00");
    assert.equal(r.body.capture_id, "CAP-5O190127TN364715T");
    assert.match(r.body.claim_url, /^http:\/\/127\.0\.0\.1:\d+\/claim\?order=[0-9a-f-]+#t=/);
    assert.equal(p.demo.calls.orders, 0, "the demo store's PayPal app is never asked about another store's order");
    // The connection learned its payee from the first order; an order paid to anyone else is refused.
    assert.equal(p.db.prepare("SELECT payee_merchant_id p FROM paypal_connections").get().p, "SHOPPAYEE1");
    assert.match((await bad(ORDER("9OTHERPAYEE00001X"))).body.message, /different PayPal account/);

    // Retrying the same order returns it with a new link; the old link stops working.
    const old = r.body.claim_url.split("#t=")[1];
    const again = await p.api(key, "POST", "/v1/orders", ORDER());
    assert.equal(again.status, 200);
    assert.equal(again.body.id, r.body.id);
    assert.equal(again.body.already_registered, true);
    assert.equal((await p.call("GET", `/api/claim-link/${r.body.id}`, { headers: { "X-Claim-Token": old }, as: "buyer" })).status, 403);
    const fresh = await p.call("GET", `/api/claim-link/${r.body.id}`, { headers: { "X-Claim-Token": again.body.claim_url.split("#t=")[1] }, as: "buyer" });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.store.name, "Acme Ceramics");
    assert.match(fresh.body.lines[0].ref_image, /^m\/[0-9a-f]{64}\.jpg$/);
    const img = await fetch(`${p.base}/assets/${fresh.body.lines[0].ref_image}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/jpeg");

    assert.equal((await p.api(key, "GET", "/v1/orders/5O190127TN364715T")).body.id, r.body.id);
    assert.equal((await p.api(key, "GET", "/v1/orders/5O190127TN364715T")).body.claim_url, undefined, "a lookup never shows the link again");

    // A second store cannot claim the first store's order, even with its own keys.
    await p.call("POST", "/api/dashboard/signup", { body: { name: "Other Shop", email: "b@other.test", password: "another long password" }, as: "b" });
    await p.call("PUT", "/api/dashboard/paypal", { body: { clientId: CLIENT_ID, clientSecret: SECRET }, as: "b" });
    const kb = (await p.call("POST", "/api/dashboard/keys", { body: {}, as: "b" })).body.created.key;
    assert.equal((await p.api(kb, "POST", "/v1/orders", ORDER())).body.error, "ORDER_TAKEN");
    assert.equal((await p.api(kb, "GET", `/v1/orders/${r.body.id}`)).status, 404);

    // A revoked key stops working at once.
    const keys = (await p.call("GET", "/api/dashboard")).body.keys;
    await p.call("DELETE", `/api/dashboard/keys/${keys[0].id}`);
    assert.equal((await p.api(key, "GET", `/v1/orders/${r.body.id}`)).status, 401);
  } finally { p.close(); }
});

test("a connected store's request is reviewed in its own console and refunded through its own PayPal", async () => {
  const p = await platform({ "5O190127TN364715T": { total: "37.00" } });
  try {
    const { key } = await connectedShop(p);
    const reg = (await p.api(key, "POST", "/v1/orders", ORDER())).body;
    const token = reg.claim_url.split("#t=")[1];
    const link = await p.call("GET", `/api/claim-link/${reg.id}`, { headers: { "X-Claim-Token": token }, as: "buyer" });
    const form = new FormData();
    form.set("orderId", reg.id);
    form.set("lineId", link.body.lines[0].id);
    form.set("quantity", "1");
    form.set("statement", "The mug arrived in pieces.");
    form.append("photos", new Blob([await testPhoto(7)], { type: "image/jpeg" }), "p.jpg");
    const claim = await p.call("POST", "/api/claims", { form, headers: { "X-Claim-Token": token }, as: "buyer" });
    assert.equal(claim.status, 201, JSON.stringify(claim.body));

    // The demo store's console never sees it.
    await p.call("POST", "/api/merchant/login", { body: { password: "test-password" }, as: "demo" });
    assert.equal((await p.call("GET", "/api/merchant/claims", { as: "demo" })).body.length, 0);
    assert.equal((await p.call("GET", `/api/merchant/claims/${claim.body.claimId}`, { as: "demo" })).status, 404);

    const inbox = (await p.call("GET", "/api/merchant/claims")).body;
    assert.equal(inbox.length, 1);
    const d = (await p.call("GET", `/api/merchant/claims/${claim.body.claimId}`)).body;
    assert.equal(d.proposal.route, "auto_refund");
    assert.equal(d.proposal.amountCents, 1850);
    assert.equal(d.line.refImage, `/assets/${link.body.lines[0].ref_image}`);
    assert.equal(d.proposal.options.filter((o) => o.kind !== "refund").length, 0, "no demo-store remedies on another store's order");

    // A demo-store approval attempt is refused before anything reaches PayPal.
    assert.equal((await p.call("POST", `/api/merchant/claims/${d.claim.id}/approve-refund`, { as: "demo",
      body: { claimVersion: d.claim.version, proposalId: d.proposal.id, amountCents: 1850 } })).status, 404);

    const r = await p.call("POST", `/api/merchant/claims/${d.claim.id}/approve-refund`, { body: { claimVersion: d.claim.version, proposalId: d.proposal.id, amountCents: 1850 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.claim.status, "refunded");
    assert.equal(p.shop.calls.refunds.length, 1);
    assert.deepEqual(p.shop.calls.refunds[0].body.amount, { currency_code: "USD", value: "18.50" });
    assert.equal(p.demo.calls.refunds.length, 0, "no money moved on the demo store's account");

    const status = await p.call("GET", `/api/claims/${claim.body.claimId}/status`, { headers: { "X-Claim-Token": claim.body.statusUrl.split("#t=")[1] }, as: "buyer" });
    assert.equal(status.body.store, "Acme Ceramics");
    assert.equal(status.body.refund.refundId, "SHOPREF-1");
    const after = (await p.api(key, "GET", `/v1/orders/${reg.id}`)).body;
    assert.equal(after.requests[0].status, "refunded");
    assert.equal(after.requests[0].refunded, "18.50");
    assert.equal((await p.call("GET", "/api/dashboard")).body.checklist.every((x) => x.done), true);
  } finally { p.close(); }
});

test("each store keeps its own refund policy; the agent and remedy library stay with the demo store", async () => {
  const p = await platform();
  try {
    await connectedShop(p);
    await p.call("POST", "/api/merchant/login", { body: { password: "test-password" }, as: "demo" });
    const saved = await p.call("PUT", "/api/merchant/policy", { body: { claimWindowDays: 30 } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.policy.claimWindowDays, 30);
    assert.equal((await p.call("GET", "/api/merchant/policy", { as: "demo" })).body.policy.claimWindowDays, 14);
    assert.equal((await p.call("GET", "/api/merchant/remedies")).body.error, "DEMO_STORE_ONLY");
    assert.equal((await p.call("GET", "/api/merchant/agent")).body.error, "DEMO_STORE_ONLY");
    assert.equal((await p.call("GET", "/api/merchant/agent", { as: "demo" })).status, 200);
    const me = (await p.call("GET", "/api/merchant/me")).body;
    assert.deepEqual([me.merchant.name, me.demo], ["Acme Ceramics", false]);
    assert.equal((await p.call("GET", "/api/dashboard", { as: "demo" })).body.connection.source, "server");
    assert.equal((await p.call("PUT", "/api/dashboard/paypal", { body: { clientId: CLIENT_ID, clientSecret: SECRET }, as: "demo" })).body.error, "SERVER_MANAGED");
  } finally { p.close(); }
});

test("catalog photos are only fetched from public https hosts", async () => {
  for (const url of ["https://127.0.0.1/a.jpg", "https://10.0.0.5/a.jpg", "https://[::1]/a.jpg", "https://169.254.169.254/latest/meta-data"]) {
    await assert.rejects(fetchCatalogImage(url), /host not allowed/, url);
  }
});
