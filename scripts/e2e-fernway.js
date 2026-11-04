// Proves the dashboard's four setup steps work for a store that is not Juniper Market, against a
// running Refund Relay (the live one by default) and the real PayPal sandbox and photo check:
//   1-2. Fernway Glass signs up on /dashboard, pastes its PayPal app, and creates a secret key.
//   3.   Its own store (examples/fernway-glass) sells a vase with the PayPal button, captures it,
//        and makes the documented POST /v1/orders call with shipping and tax.
//   4.   The confirmation page shows the relay.js button; the buyer reports a cracked vase.
//   Then Fernway decides the request in its own console and PayPal refunds Fernway's capture.
//
//   node --env-file=.env scripts/e2e-fernway.js
// Env: PAYPAL_CLIENT_ID/SECRET (the app Fernway connects; FERNWAY_PAYPAL_CLIENT_ID/SECRET override),
// SANDBOX_BUYER_EMAIL/PASSWORD, APP_BASE_URL (default https://refund-relay.onrender.com),
// FERNWAY_EMAIL/FERNWAY_PASSWORD (the store's dashboard login, reused on later runs).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = (process.env.APP_BASE_URL || "https://refund-relay.onrender.com").replace(/\/+$/, "");
const PORT = Number(process.env.FERNWAY_PORT || 8898);
const STORE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR || "examples/fernway-glass/screenshots";
mkdirSync(shots, { recursive: true });
const photo = process.env.E2E_PHOTO || "demo-photos/2-vase-cracked.jpg";
const clientId = process.env.FERNWAY_PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.FERNWAY_PAYPAL_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET;
const EMAIL = process.env.FERNWAY_EMAIL || "studio@fernway-glass.test";
const PASS = process.env.FERNWAY_PASSWORD || "fernway-glass-sandbox";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[fernway]", ...a);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const shot = async (name, p = page) => { await p.waitForTimeout(700); return p.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };

// ---- Steps 1 and 2, on the dashboard ----------------------------------------------------------
await page.goto(`${BASE}/dashboard`);
await page.waitForSelector("#auth:not(.hidden)");
await page.fill("#s-name", "Fernway Glass");
await page.fill("#s-email", EMAIL);
await page.fill("#s-pass", PASS);
await shot("01-dashboard-signup");
await page.click("#signup button[type=submit]");
await page.waitForSelector("#page:not(.hidden), #auth-error:not(.hidden)");
if (await page.isVisible("#auth-error")) {
  log("signup:", (await page.textContent("#auth-error")).trim(), "- signing in");
  await page.click('[data-tab="login"]');
  await page.fill("#l-email", EMAIL);
  await page.fill("#l-pass", PASS);
  await page.click("#login button[type=submit]");
  await page.waitForSelector("#page:not(.hidden)");
}
if (await page.isVisible("#pp-id")) {
  await page.fill("#pp-id", clientId);
  await page.fill("#pp-secret", clientSecret);
  await page.click("#pp-save");
  await page.waitForSelector("#pp-connected:not(.hidden), #notice.warn:not(.hidden), #notice.bad:not(.hidden)", { timeout: 30_000 });
  const note = (await page.textContent("#notice")).trim();
  log("step 1, connect PayPal:", note);
  if (!(await page.isVisible("#pp-connected"))) { await shot("02-paypal-refused"); throw new Error(`PayPal connect refused: ${note}`); }
} else log("step 1: PayPal already connected");
await shot("02-dashboard-paypal");
// Keys from earlier runs are revoked, so reruns never reach the limit of active keys.
await page.evaluate(async () => {
  const { keys } = await (await fetch("/api/dashboard")).json();
  for (const k of keys.filter((x) => !x.revokedAt)) await fetch(`/api/dashboard/keys/${k.id}`, { method: "DELETE", headers: { "X-Refund-Relay": "1" } });
});
await page.fill("#key-label", "Fernway store server");
await page.click("#key-create");
await page.waitForSelector("#newkey:not(.hidden)");
const key = (await page.textContent("#newkey-value")).trim();
log("step 2, key:", key.slice(0, 15) + "…");
// The key is live: mask it before the screenshot so it never lands in an image.
await page.evaluate(() => { document.getElementById("newkey-value").textContent = "rr_sk_test_•••••••• (hidden in screenshots)"; });
await shot("03-dashboard-key");

// ---- Step 3, the store's own checkout ---------------------------------------------------------
const server = spawn(process.execPath, ["examples/fernway-glass/server.js"], {
  env: { ...process.env, REFUND_RELAY_URL: BASE, REFUND_RELAY_KEY: key, FERNWAY_PORT: String(PORT), FERNWAY_PAYPAL_CLIENT_ID: clientId, FERNWAY_PAYPAL_CLIENT_SECRET: clientSecret },
  stdio: "inherit",
});
try {
  for (let i = 0; i < 40; i++) { if (await fetch(STORE).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 250)); }
  const buyer = await ctx.newPage();
  await buyer.goto(STORE);
  await buyer.selectOption("#qty", "2");
  const ppFrame = buyer.frameLocator("#paypal-buttons iframe").first();
  await ppFrame.locator('[data-funding-source="paypal"]').first().waitFor({ timeout: 30_000 });
  await buyer.waitForTimeout(1500);
  await shot("04-store", buyer);

  // The buyer pays with the PayPal button (a PayPal popup), as a real shopper would.
  const [popup] = await Promise.all([buyer.waitForEvent("popup", { timeout: 30_000 }), ppFrame.locator('[data-funding-source="paypal"]').first().click()]);
  await popup.waitForLoadState();
  if (await popup.waitForSelector("#email", { timeout: 30_000 }).catch(() => null)) {
    await popup.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
    await popup.click("#btnNext");
    await popup.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
    await popup.click("#btnLogin");
  }
  const pay = popup.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Continue")').first();
  await pay.waitFor({ timeout: 60_000 });
  await shot("05-paypal-approve", popup);
  await pay.click();
  await buyer.waitForURL(/\/orders\//, { timeout: 90_000 });
  const paypalOrderId = buyer.url().split("/orders/")[1];
  log("step 3: captured and sent PayPal order", paypalOrderId);

  // ---- Step 4, the button on the confirmation page ----------------------------------------------
  await buyer.waitForFunction(() => document.querySelector("[data-refund-relay]")?.shadowRoot?.querySelector("a"), null, { timeout: 15_000 });
  await shot("06-confirmation-button", buyer);
  const order = await (await fetch(`${BASE}/v1/orders/${paypalOrderId}`, { headers: { Authorization: `Bearer ${key}` } })).json();
  log("GET /v1/orders:", JSON.stringify({ amount: order.amount, items: order.items?.map((i) => `${i.quantity}x ${i.sku} @ ${i.unit_price}`) }));

  const [claim] = await Promise.all([ctx.waitForEvent("page"), buyer.locator("[data-refund-relay] a").click()]);
  await claim.waitForSelector("#form:not(.hidden)", { timeout: 30_000 });
  log("claim page store name:", (await claim.textContent("#store")).trim());
  await claim.fill("#statement", "One of the two vases arrived with a crack running down from the rim.");
  await claim.setInputFiles("#photos", photo);
  await shot("07-buyer-claim", claim);
  await claim.click("#submit");
  await claim.waitForSelector("#sent:not(.hidden)", { timeout: 90_000 });
  const statusUrl = await claim.getAttribute("#status-link", "href");
  const claimId = new URL(BASE + statusUrl).searchParams.get("claim");
  log("claim filed", claimId);

  // ---- Fernway decides it in its own console ----------------------------------------------------
  await page.goto(`${BASE}/merchant/`);
  await page.waitForSelector("#inbox:not(.hidden)", { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await shot("08-fernway-requests");
  await page.goto(`${BASE}/merchant/case?id=${claimId}`);
  await page.waitForSelector("#approve", { state: "attached", timeout: 120_000 });
  await page.waitForTimeout(1500);
  await shot("09-fernway-case");
  log("approve button:", (await page.textContent("#approve")).trim());
  if (!(await page.isVisible("#approve"))) {
    log("the policy left it to the merchant: Refund anyway, with a reason");
    await page.click("summary:has-text('Refund anyway')");
  }
  if (await page.isVisible("#reason")) await page.fill("#reason", "Photo shows our bud vase with a crack from the rim");
  await page.click("#approve");
  await page.waitForSelector('h2:has-text("PayPal refund")', { timeout: 90_000 });
  await shot("10-fernway-refunded");
  const cookie = (await ctx.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join("; ");
  const detail = await (await fetch(`${BASE}/api/merchant/claims/${claimId}`, { headers: { Cookie: cookie } })).json();
  const f = detail.assessment?.findings ?? {};
  log("photo check:", JSON.stringify({ breakage: f.visible_breakage, kind: f.damage_kind, design: f.design_match }));
  log("refunds:", JSON.stringify(detail.refunds?.map((r) => ({ id: r.providerRefundId, status: r.status, amount: r.amountCents }))));
  const after = await (await fetch(`${BASE}/v1/orders/${paypalOrderId}`, { headers: { Authorization: `Bearer ${key}` } })).json();
  log("GET /v1/orders after:", JSON.stringify(after.requests));

  await claim.goto(BASE + statusUrl);
  await claim.waitForSelector("#card:not(.hidden)");
  await shot("11-buyer-status", claim);
  await page.goto(`${BASE}/dashboard`);
  await page.waitForSelector("#page:not(.hidden)");
  await shot("12-dashboard-done");
  log("checklist:", (await page.textContent("#progress")).trim());
} finally {
  server.kill();
  await browser.close();
}
