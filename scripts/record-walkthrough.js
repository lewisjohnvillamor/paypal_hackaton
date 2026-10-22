// Records a captioned video walkthrough of the live flow (PayPal sandbox + Jev) with Playwright.
// Needs the app running (npm start) and SANDBOX_BUYER_EMAIL / _PASSWORD, MERCHANT_PASSWORD in .env.
// Usage: node --env-file=.env scripts/record-walkthrough.js [out-dir]
// Writes raw .webm clips plus timeline.json; scripts/stitch-walkthrough.sh turns them into one mp4.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const out = process.argv[2] || "data/walkthrough";
const size = { width: 1280, height: 800 };
mkdirSync(out, { recursive: true });

const t0 = Date.now();
const timeline = [];
const mark = (label) => timeline.push({ label, t: (Date.now() - t0) / 1000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function caption(page, text) {
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
}
const say = async (page, text, ms = 3200) => { await caption(page, text); await wait(ms); };
const scrollTo = (page, sel) => page.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
const page = await context.newPage();
const mainStart = (Date.now() - t0) / 1000;

// 1. Store
await page.goto(BASE);
await page.waitForSelector("#paypal-buttons iframe", { timeout: 30_000 });
await wait(1500);
await say(page, "Refund Relay demo: a small mug shop that takes PayPal (sandbox).", 3500);
await say(page, "The buyer orders four $20 mugs. The server sets the $80 price, not the browser.", 3500);

// 2. PayPal checkout in the popup
const frame = page.frameLocator("#paypal-buttons iframe").first();
const [popup] = await Promise.all([
  page.waitForEvent("popup"),
  frame.locator('[data-funding-source="paypal"]').first().click(),
]);
const popupStart = (Date.now() - t0) / 1000;
mark("popup-open");
await popup.waitForLoadState("domcontentloaded");
await popup.waitForSelector("#email", { timeout: 60_000 });
await say(popup, "PayPal Checkout opens. The buyer signs in with a sandbox Personal account.", 2500);
await popup.locator("#email").pressSequentially(process.env.SANDBOX_BUYER_EMAIL, { delay: 30 });
await popup.click("#btnNext");
await popup.waitForSelector("#password:visible", { timeout: 30_000 });
await popup.locator("#password").pressSequentially(process.env.SANDBOX_BUYER_PASSWORD, { delay: 30 });
await popup.click("#btnLogin");
const pay = popup.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Pay")').first();
await pay.waitFor({ timeout: 60_000 });
await wait(1200);
await say(popup, "The buyer reviews and pays $80.00.", 2500);
const popupClosed = popup.waitForEvent("close", { timeout: 90_000 });
await pay.click();
await popupClosed;
mark("popup-closed");

// 3. Receipt with capture
await page.waitForSelector("#done:not(.hidden)", { timeout: 60_000 });
await page.bringToFront();
await say(page, "The server captures the payment and checks amount, currency and payee with PayPal.", 4000);
await say(page, "The buyer gets a private link to report a problem with this order.", 3000);

// 4. Claim form
await page.click("#claim-link");
await page.waitForSelector("#form:not(.hidden)");
await say(page, "A few days later: one mug arrived broken. The buyer opens the claim link.", 3200);
await page.locator("#statement").pressSequentially("One of the four mugs arrived broken. The handle snapped off in the box.", { delay: 18 });
await page.setInputFiles("#photos", "probe/cases/broken-handle-white.jpg");
await scrollTo(page, "#submit");
await say(page, "They pick the item and quantity, describe it, and attach a photo.", 3200);
await page.click("#submit");
await page.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });
await say(page, "Sent. Jev (TypeSafe's model) has already checked the photo, in about a quarter second.", 3500);
const statusUrl = await page.getAttribute("#status-link", "href");

// 5. Merchant
await page.goto(`${BASE}/merchant/`);
await page.waitForSelector("#login:not(.hidden)");
await say(page, "Now the merchant's side. Refund powers sit behind a merchant sign-in.", 2800);
await page.locator("#password").pressSequentially(process.env.MERCHANT_PASSWORD, { delay: 25 });
await page.click("#login button[type=submit]");
await page.waitForSelector("#inbox:not(.hidden) a.inbox-row");
await say(page, "The inbox shows the new request and the policy's suggested refund.", 3500);
await page.click("a.inbox-row");
await page.waitForSelector("#approve");
await say(page, "Purple: what the customer says. Blue: what the model observed in the photo.", 4000);
await scrollTo(page, ".voice.model");
await say(page, "Jev: photo usable, breakage visible, same kind of item as the catalog photo. The buyer's text never goes to the model.", 5000);
await scrollTo(page, "h2:has-text('PayPal payment')");
await say(page, "The case is tied to the real PayPal capture and its refundable balance.", 3500);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await wait(800);
await scrollTo(page, "#approve");
await say(page, "The shop's policy drafts 1 × $20.00 = $20.00. Nothing moves until the merchant approves.", 4500);
await page.locator("#approve").hover();
await wait(600);
await page.click("#approve");
await page.waitForSelector("h2:has-text('PayPal refund')", { timeout: 60_000 });
await scrollTo(page, "h2:has-text('PayPal refund')");
await say(page, "One partial refund goes to PayPal against the original capture, with a stored idempotency key.", 4500);
await say(page, "PayPal reports COMPLETED with a real refund ID. Clicking again can't refund twice.", 4500);
await scrollTo(page, "h2:has-text('PayPal payment')");
await say(page, "Refundable balance drops from $80.00 to $60.00.", 3200);

// 6. Buyer status
await page.goto(BASE + statusUrl);
await page.waitForSelector("#card:not(.hidden)");
await say(page, "The buyer's tracking page: refunded through PayPal, with the refund ID.", 4500);
await say(page, "Refund Relay: PayPal anchors the payment and the refund. AI only helps the merchant review.", 4500);

const mainVideo = page.video();
const popupVideo = popup.video();
await context.close();
await browser.close();
const end = (Date.now() - t0) / 1000;
writeFileSync(`${out}/timeline.json`, JSON.stringify({
  main: { file: await mainVideo.path(), start: mainStart },
  popup: { file: await popupVideo.path(), start: popupStart },
  marks: timeline, end,
}, null, 2));
console.log("recorded", end.toFixed(1), "s");
