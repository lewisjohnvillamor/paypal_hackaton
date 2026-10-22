// Live end-to-end run against the PayPal sandbox and Jev, driving the real UI with Playwright.
// Needs the app running (npm start), Playwright installed, and SANDBOX_BUYER_EMAIL / _PASSWORD in .env.
// Usage: node --env-file=.env scripts/e2e-sandbox.js [photo.jpg]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const photo = process.argv[2] || "probe/cases/broken-rocket-mug.jpg";
const shots = process.env.SHOTS_DIR || "hackathon/screenshots";
mkdirSync(shots, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const shot = async (name) => { await page.waitForTimeout(800); return page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };

// 0. Store page with the PayPal button rendered.
await page.goto(BASE);
await page.waitForSelector("#paypal-buttons iframe", { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot("0-store");

// 1. Server creates a priced order; the sandbox buyer approves it on PayPal.
const order = await (await fetch(`${BASE}/api/demo/orders`, { method: "POST" })).json();
log("order", order.paypalOrderId);
await page.goto(order.approveUrl);
await page.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
await page.click("#btnNext");
await page.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
await page.click("#btnLogin");
const pay = page.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Continue")').first();
await pay.waitFor({ timeout: 60_000 });
await pay.click();
await page.waitForURL((u) => !u.hostname.includes("paypal.com") || u.searchParams.has("token") && u.pathname.includes("return"), { timeout: 60_000 }).catch(() => {});
log("buyer approved");

// 2. Server captures and verifies; buyer gets a private claim link.
let cap;
for (let i = 0; i < 10; i++) {
  const r = await fetch(`${BASE}/api/demo/orders/${order.paypalOrderId}/capture`, { method: "POST" });
  cap = await r.json();
  if (r.ok) break;
  await new Promise((r) => setTimeout(r, 2000));
}
if (!cap.claimUrl) throw new Error("capture failed: " + JSON.stringify(cap));
log("captured", cap.captureId);

// 3. Buyer files the complaint with a photo.
await page.goto(BASE + cap.claimUrl);
await page.waitForSelector("#form:not(.hidden)");
await page.fill("#statement", "One of the four mugs arrived broken; the handle snapped off in the box.");
await page.setInputFiles("#photos", photo);
await shot("1-buyer-claim");
await page.click("#submit");
await page.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });
await shot("1b-claim-sent");
const statusUrl = await page.getAttribute("#status-link", "href");
log("claim sent", await page.textContent("#ref"));

// 4. Merchant signs in, reviews the case, approves the drafted refund.
await page.goto(`${BASE}/merchant/`);
await page.waitForSelector("#login:not(.hidden)");
await shot("1c-merchant-login");
await page.fill("#password", process.env.MERCHANT_PASSWORD);
await page.click("#login button[type=submit]");
await page.waitForSelector("#inbox:not(.hidden) a.inbox-row");
await shot("2-merchant-inbox");
await page.click("a.inbox-row");
await page.waitForSelector("#approve");
await shot("3-merchant-case");
log("approve button:", await page.textContent("#approve"));
await page.click("#approve");
await page.waitForSelector("h2:has-text(\"PayPal refund\")", { timeout: 60_000 });
await shot("4-refund-result");
const caseId = new URL(page.url()).searchParams.get("id");

// 5. Duplicate approval of the same case version is refused and sends nothing to PayPal.
const cookies = await page.context().cookies();
const detail = await (await fetch(`${BASE}/api/merchant/claims/${caseId}`, { headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } })).json();
const approval = detail.approvals[0];
const dup = await fetch(`${BASE}/api/merchant/claims/${caseId}/approve-refund`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Refund-Relay": "1", Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
  body: JSON.stringify({ claimVersion: approval.claim_version, proposalId: "x", amountCents: approval.amount_cents }),
});
log("duplicate approve ->", dup.status, (await dup.json()).duplicate ? "existing operation returned" : "");

// 6. Buyer status page.
await page.goto(BASE + statusUrl);
await page.waitForSelector("#card:not(.hidden)");
await shot("5-buyer-status");
log("refund", JSON.stringify(detail.refunds.map((r) => ({ id: r.providerRefundId, status: r.status, amount: r.amountCents }))));
log("findings", JSON.stringify(detail.assessment.findings), detail.assessment.latencyMs + "ms");
await browser.close();
