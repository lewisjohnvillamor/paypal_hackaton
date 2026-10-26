// Records a short captioned video of Claude Haiku's remedy suggestions on a live claim: the buyer
// reports a chipped mug, Jev reads the photo, Haiku suggests a listing, the merchant adds it, and
// the buyer picks it (one PayPal sandbox partial refund). The PayPal purchase happens off camera.
// Needs the app running with ANTHROPIC_API_KEY set.
// Usage: node --env-file=.env scripts/record-haiku.js [photo.jpg] [out-dir]
import { chromium } from "playwright";
import { mkdirSync, readdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const photo = process.argv[2] || "probe/cases/chipped-closeup.jpg";
const out = process.argv[3] || "data/haiku-video";
const size = { width: 1280, height: 800 };
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

// Off camera: the sandbox buyer pays $80 for four mugs.
const setup = await browser.newPage();
const order = await (await fetch(`${BASE}/api/demo/orders`, { method: "POST" })).json();
await setup.goto(order.approveUrl);
await setup.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
await setup.click("#btnNext");
await setup.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
await setup.click("#btnLogin");
const pay = setup.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Continue")').first();
await pay.waitFor({ timeout: 60_000 });
await pay.click();
await setup.waitForURL((u) => !u.hostname.includes("paypal.com"), { timeout: 60_000 }).catch(() => {});
let cap;
for (let i = 0; i < 10; i++) {
  const r = await fetch(`${BASE}/api/demo/orders/${order.paypalOrderId}/capture`, { method: "POST" });
  cap = await r.json();
  if (r.ok) break;
  await wait(2000);
}
if (!cap.claimUrl) throw new Error("capture failed: " + JSON.stringify(cap));
await setup.close();
log("paid and captured", cap.captureId);

const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
const page = await context.newPage();
async function say(text, ms = 3000) {
  await page.evaluate((text) => {
    let el = document.getElementById("__caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "__caption";
      el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:88%;" +
        "background:rgba(17,17,17,.88);color:#fff;font:600 20px/1.35 system-ui,sans-serif;padding:12px 20px;border-radius:12px;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.3);text-align:center;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = text;
  }, text).catch(() => {});
  await wait(ms);
}
const show = (sel) => page.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {});

// 1. Buyer reports the chipped mug.
await page.goto(BASE + cap.claimUrl);
await page.waitForSelector("#form:not(.hidden)");
await say("Live run: the buyer paid $80 in the PayPal sandbox. One mug arrived chipped.");
await page.fill("#statement", "One of the four mugs arrived with a chip on the rim.");
await page.setInputFiles("#photos", photo);
await say("They add a photo and send the request.", 2500);
await page.click("#submit");
await page.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });
const statusUrl = await page.getAttribute("#status-link", "href");
await say("Jev checks the photo, then Claude Haiku looks through the store's listings.", 2500);

// 2. Merchant opens the case and adds Haiku's suggestion.
await page.goto(`${BASE}/merchant/`);
await page.waitForSelector("#login:not(.hidden)");
await page.fill("#password", process.env.MERCHANT_PASSWORD);
await page.click("#login button[type=submit]");
await page.waitForSelector("#inbox:not(.hidden)");
await wait(1500);
const caseId = new URL(BASE + statusUrl).searchParams.get("claim");
await page.goto(`${BASE}/merchant/case?id=${encodeURIComponent(caseId)}`);
const t = Date.now();
await page.waitForSelector(".ai-suggest [data-approve]", { timeout: 90_000 });
log("suggestion visible after", Date.now() - t, "ms on the case page");
await show(".ai-suggest");
await say("Claude Haiku suggests a remedy from the store's own listings, with its reason.", 4500);
await say("Nothing reaches the buyer until the merchant adds it.", 3000);
await page.click(".ai-suggest [data-approve]");
await page.waitForSelector(".ai-suggest .pill.ok", { timeout: 30_000 });
await show(".offer-pitch");
await say("Added. It joins the buyer's choices next to the full refund.", 3500);
if (await page.isVisible("#reason")) await page.fill("#reason", "Same mug, chip is clear in the photo");
await page.click("#send-offer");
await page.waitForSelector("text=Waiting for the buyer to choose");
await say("The merchant lets the buyer choose.", 2500);

// 3. Buyer picks the Haiku suggestion.
await page.goto(BASE + statusUrl);
await page.waitForSelector("[data-option]");
await say("The buyer sees the options on their status page.", 3500);
const picked = page.locator("[data-option]", { hasText: /replacement|studio second/i }).first();
await picked.scrollIntoViewIfNeeded();
await say("They pick the suggestion Haiku found.", 2000);
await picked.click();
await page.waitForSelector(".option.chosen", { timeout: 60_000 });
await say("Done. The buyer's choice becomes one PayPal partial refund.", 4000);

// 4. Merchant's record of what happened.
await page.goto(`${BASE}/merchant/case?id=${encodeURIComponent(caseId)}`);
await page.waitForSelector("#approve, h2", { timeout: 30_000 });
await show("text=How this case was handled");
await say("The case timeline records Jev, Haiku, the merchant, the buyer and PayPal.", 4500);

const cookies = await context.cookies();
const d = await (await fetch(`${BASE}/api/merchant/claims/${caseId}`, { headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } })).json();
log("suggestions", JSON.stringify(d.proposal?.suggestions?.map((s) => ({ title: s.title, back: s.refundUnitCents, status: s.status }))));
log("offer", JSON.stringify(d.offer));
log("refunds", JSON.stringify(d.refunds.map((r) => ({ id: r.providerRefundId, status: r.status, amount: r.amountCents }))));
log("haiku", JSON.stringify(d.timeline?.filter?.((e) => /suggest/.test(e.type ?? "")) ?? null));
await context.close();
await browser.close();
console.log(readdirSync(out).filter((f) => f.endsWith(".webm")).map((f) => `${out}/${f}`).join("\n"));
