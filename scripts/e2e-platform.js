// Live run of Refund Relay as a service for a second store, against the real PayPal sandbox and
// the real photo check. Needs Refund Relay running (npm start) and Playwright.
//   1. Acme Ceramics signs up on the dashboard, connects its PayPal app, and creates a secret key.
//   2. Acme's own store (examples/acme-store) sells a mug through its own PayPal checkout and sends
//      the order to POST /v1/orders; its confirmation page shows the relay.js button.
//   3. The buyer clicks the button and reports the broken mug with a photo.
//   4. Acme signs in, approves the drafted refund, and PayPal refunds Acme's capture.
//   node --env-file=.env scripts/e2e-platform.js
// The sandbox has one REST app here, so Acme connects with the same app ID as the demo store; in
// real use each store pastes its own.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const ACME = `http://localhost:${process.env.ACME_PORT || 8899}`;
const shots = process.env.SHOTS_DIR || "hackathon/screenshots/platform";
mkdirSync(shots, { recursive: true });
const photo = process.env.E2E_PHOTO || "probe/cases/broken-handle-white.jpg";
const log = (...a) => console.log("[platform]", ...a);
const stamp = Date.now().toString(36);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const shot = async (name, p = page) => { await p.waitForTimeout(700); return p.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };

// 1. Sign up and set up, through the dashboard itself.
await page.goto(`${BASE}/dashboard`);
await page.waitForSelector("#auth:not(.hidden)");
await shot("1-dashboard-signup");
await page.fill("#s-name", "Acme Ceramics");
await page.fill("#s-email", `owner+${stamp}@acme-ceramics.test`);
await page.fill("#s-pass", "acme-ceramics-sandbox");
await page.click("#signup button[type=submit]");
await page.waitForSelector("#page:not(.hidden)");
await shot("2-dashboard-empty");
await page.fill("#pp-id", process.env.PAYPAL_CLIENT_ID);
await page.fill("#pp-secret", process.env.PAYPAL_CLIENT_SECRET);
await page.click("#pp-save");
await page.waitForSelector("#pp-connected:not(.hidden)", { timeout: 30_000 });
log("PayPal connected:", await page.textContent("#notice"));
await page.fill("#key-label", "Acme store server");
await page.click("#key-create");
await page.waitForSelector("#newkey:not(.hidden)");
const key = (await page.textContent("#newkey-value")).trim();
await shot("3-dashboard-key");
log("key", key.slice(0, 15) + "…");

// 2. Acme's own store, with its own checkout.
const store = spawn(process.execPath, ["examples/acme-store/server.js"], {
  env: { ...process.env, REFUND_RELAY_URL: BASE, REFUND_RELAY_KEY: key, ACME_PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID, ACME_PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET },
  stdio: "inherit",
});
try {
  for (let i = 0; i < 30; i++) { if (await fetch(ACME).then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 300)); }
  const checkout = await (await fetch(`${ACME}/api/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quantity: 2 }) })).json();
  const buyer = await ctx.newPage();
  await buyer.goto(checkout.approveUrl);
  if (await buyer.waitForSelector("#email", { timeout: 15_000 }).catch(() => null)) {
    await buyer.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
    await buyer.click("#btnNext");
    await buyer.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
    await buyer.click("#btnLogin");
  }
  const pay = buyer.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Continue")').first();
  await pay.waitFor({ timeout: 60_000 });
  await pay.click();
  await buyer.waitForTimeout(4000);
  let cap;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${ACME}/api/checkout/${checkout.id}/capture`, { method: "POST" });
    cap = await r.json();
    if (r.ok) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!cap.confirmation) throw new Error("Acme capture or registration failed: " + JSON.stringify(cap));
  log("Acme captured and registered PayPal order", checkout.id);

  // 3. The buyer reports the damage from Acme's confirmation page.
  await buyer.goto(ACME + cap.confirmation);
  await buyer.waitForFunction(() => document.querySelector("[data-refund-relay]")?.shadowRoot?.querySelector("a"));
  await shot("4-acme-confirmation", buyer);
  const [claimPage] = await Promise.all([ctx.waitForEvent("page"), buyer.locator("[data-refund-relay] a").click()]);
  await claimPage.waitForSelector("#form:not(.hidden)");
  log("claim page eyebrow:", await claimPage.textContent("#store"));
  await claimPage.fill("#statement", "One of the two mugs arrived with the handle snapped off.");
  await claimPage.setInputFiles("#photos", photo);
  await shot("5-buyer-claim", claimPage);
  await claimPage.click("#submit");
  await claimPage.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });
  const statusUrl = await claimPage.getAttribute("#status-link", "href");
  const claimId = new URL(BASE + statusUrl).searchParams.get("claim");

  // 4. Acme reviews and approves in its own console.
  await page.goto(`${BASE}/merchant/`);
  await page.waitForSelector("#inbox:not(.hidden)");
  await page.waitForTimeout(2500);
  await shot("6-acme-requests");
  await page.goto(`${BASE}/merchant/case?id=${claimId}`);
  await page.waitForSelector("#approve", { state: "attached", timeout: 90_000 });
  await shot("7-acme-case");
  log("approve button:", await page.textContent("#approve"));
  // A case the policy left to the merchant needs "Refund anyway" and a written reason.
  if (!(await page.isVisible("#approve"))) {
    log("policy left it to the merchant; refunding anyway with a reason");
    await page.click("summary:has-text('Refund anyway')");
  }
  if (await page.isVisible("#reason")) await page.fill("#reason", "Photo 1 clearly shows our mug's snapped handle");
  await page.click("#approve");
  await page.waitForSelector("h2:has-text(\"PayPal refund\")", { timeout: 60_000 });
  await shot("8-acme-refunded");
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const detail = await (await fetch(`${BASE}/api/merchant/claims/${claimId}`, { headers: { Cookie: cookie } })).json();
  log("findings", JSON.stringify({ breakage: detail.assessment.findings?.visible_breakage, kind: detail.assessment.findings?.damage_kind, design: detail.assessment.findings?.design_match }));
  log("refund", JSON.stringify(detail.refunds.map((r) => ({ id: r.providerRefundId, status: r.status, amount: r.amountCents }))));
  const order = await (await fetch(`${BASE}/v1/orders/${checkout.id}`, { headers: { Authorization: `Bearer ${key}` } })).json();
  log("GET /v1/orders", JSON.stringify({ amount: order.amount, requests: order.requests }));
  await claimPage.goto(BASE + statusUrl);
  await claimPage.waitForSelector("#card:not(.hidden)");
  await shot("9-buyer-status", claimPage);
  await page.goto(`${BASE}/dashboard`);
  await page.waitForSelector("#page:not(.hidden)");
  await shot("10-dashboard-done");
  log("checklist", await page.textContent("#progress"));
} finally {
  store.kill();
  await browser.close();
}
