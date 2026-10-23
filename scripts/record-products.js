// Records a short captioned video of a multi-product order: the buyer fills a bag with a vase, a
// T-shirt and headphones, pays in the PayPal sandbox (the PayPal login happens off camera), then
// reports a stained T-shirt. Jev reads it with the T-shirt questions, Claude Haiku suggests an
// in-stock listing, the merchant adds it and the buyer picks it: one PayPal partial refund.
// Needs the app running with TYPESAFE_API_KEY and ANTHROPIC_API_KEY set.
// Usage: CHROMIUM_PATH=... node --env-file=.env scripts/record-products.js [photo.jpg] [out-dir]
import { chromium } from "playwright";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const photo = process.argv[2] || "probe/products/tee-stained.jpg";
const out = process.argv[3] || "data/products-video";
const CLAIM_SKU = process.env.CLAIM_SKU || "TEE-ORGANIC";
const ITEMS = [{ sku: "VASE-GLASS", quantity: 1 }, { sku: "TEE-ORGANIC", quantity: 2 }, { sku: "HEADPHONES-OVER", quantity: 1 }];
const size = { width: 1280, height: 800 };
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
const page = await context.newPage();
const t0 = Date.now();
const cut = {}; // the off-camera payment, cut from the video afterwards (see the ffmpeg line below)
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

// 1. The store: four very different products. The bag starts with two mugs; swap for the demo cart.
await page.goto(BASE);
await page.waitForSelector(".tile");
await say("A demo store with four very different products, paid with PayPal.", 3500);
for (let i = 0; i < 2; i++) await page.click('[data-sku="MUG-CLASSIC"][data-d="-1"]');
for (const { sku, quantity } of ITEMS) for (let i = 0; i < quantity; i++) { await page.click(`[data-sku="${sku}"][data-d="1"]`); await wait(350); }
await say("The buyer adds a glass vase, two T-shirts and headphones.", 3500);

// Off camera: the same cart is paid with the sandbox buyer account.
cut.from = (Date.now() - t0) / 1000;
const setup = await browser.newPage();
const order = await (await fetch(`${BASE}/api/demo/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: ITEMS }) })).json();
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
await page.goto("about:blank");
cut.to = (Date.now() - t0) / 1000;
log("paid and captured", cap.captureId, `$${(cap.amount / 100).toFixed(2)}`);

// 2. Buyer reports the T-shirt.
const line = cap.lines.find((l) => l.sku === CLAIM_SKU);
const [path, hash] = cap.claimUrl.split("#");
await page.goto(`${BASE}${path}&line=${encodeURIComponent(line.id)}#${hash}`);
await page.waitForSelector("#form:not(.hidden)");
await say(`Paid $${(cap.amount / 100).toFixed(2)} in the PayPal sandbox. One T-shirt arrived stained.`, 3500);
await page.fill("#statement", "One of the two T-shirts arrived with yellow stains on the front.");
await page.setInputFiles("#photos", photo);
await say("They add a photo and send the request.", 2500);
await page.click("#submit");
await page.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });
const statusUrl = await page.getAttribute("#status-link", "href");
await say("Jev checks the photo with T-shirt questions: stains, tears, seams.", 3000);

// 3. Merchant: inbox, case, Haiku's suggestion.
await page.goto(`${BASE}/merchant/`);
await page.waitForSelector("#login:not(.hidden)");
await page.fill("#password", process.env.MERCHANT_PASSWORD);
await page.click("#login button[type=submit]");
await page.waitForSelector("#inbox:not(.hidden)");
await wait(1500);
const caseId = new URL(BASE + statusUrl).searchParams.get("claim");
await page.goto(`${BASE}/merchant/case?id=${encodeURIComponent(caseId)}`);
await page.waitForSelector(".ai-suggest [data-approve]", { timeout: 90_000 });
await say("Jev found a stain and matched the shop's stain-remover remedy.", 3500);
await show(".ai-suggest");
await say("Claude Haiku suggests from listings that are in stock, with its reason.", 4500);
await page.click(".ai-suggest [data-approve]");
await page.waitForSelector(".ai-suggest .pill.ok", { timeout: 30_000 });
await show(".offer-pitch");
await say("The merchant adds it to the buyer's choices.", 3000);
if (await page.isVisible("#reason")) await page.fill("#reason", "Stains are clear in the photo; offering choices");
await page.click("#send-offer");
await page.waitForSelector("text=Waiting for the buyer to choose");

// 4. Buyer picks Haiku's suggestion.
await page.goto(BASE + statusUrl);
await page.waitForSelector("[data-option]");
await say("The buyer sees every option, including the full refund.", 3500);
const picked = page.locator('[data-option^="ai_"]').first();
await picked.scrollIntoViewIfNeeded();
await say("They pick the one Haiku found.", 2000);
await picked.click();
await page.waitForSelector(".option.chosen", { timeout: 60_000 });
await say("Done: one PayPal partial refund, on an order with three different products.", 4500);

const cookies = await context.cookies();
const d = await (await fetch(`${BASE}/api/merchant/claims/${caseId}`, { headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } })).json();
log("findings", JSON.stringify({ damage: d.assessment?.findings?.damage_kind, breakage: d.assessment?.findings?.visible_breakage, route: d.proposal?.route }));
log("suggestions", JSON.stringify(d.proposal?.suggestions?.map((s) => ({ listing: s.listingId, title: s.title, back: s.refundUnitCents, status: s.status }))));
log("offer", JSON.stringify(d.offer?.options?.map((o) => `${o.title} ${o.refundCents}`)), "chosen", d.offer?.chosen);
log("refunds", JSON.stringify(d.refunds.map((r) => ({ id: r.providerRefundId, status: r.status, amount: r.amountCents }))));
await context.close();
await browser.close();
writeFileSync(`${out}/cut.json`, JSON.stringify(cut));
// To drop the payment wait: ffmpeg -i <clip>.webm -vf "select='not(between(t,FROM,TO))',setpts=N/FRAME_RATE/TB" out.mp4
console.log(readdirSync(out).filter((f) => f.endsWith(".webm")).map((f) => `${out}/${f}`).join("\n"));
