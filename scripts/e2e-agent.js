// Live run of the refund agent against the PayPal sandbox, the photo check and the rule reader,
// through the real UI. The merchant writes a rule in plain English and turns it on; a chipped mug
// is then refunded by the agent with no click, and a cracked vase (no rule covers it) is left for
// the merchant. Needs the app running (npm start) with REPEAT_CLAIM_LIMIT=0, and the sandbox buyer
// in .env. Usage: node --env-file=.env scripts/e2e-agent.js
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const shots = process.env.SHOTS_DIR || "hackathon/screenshots";
const RULE = process.env.AGENT_RULE || "Refund chipped mugs under $25 on your own. Ask me about anything above that.";
mkdirSync(shots, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const shot = async (name) => { await page.waitForTimeout(800); return page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
const cookie = async () => (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
const merchantApi = async (path) => (await fetch(`${BASE}/api/merchant${path}`, { headers: { Cookie: await cookie() } })).json();

// 1. The merchant writes the rule, reads it back, turns it on.
await page.goto(`${BASE}/merchant/`);
await page.waitForSelector("#login:not(.hidden)");
await page.fill("#password", process.env.MERCHANT_PASSWORD);
await page.click("#login button[type=submit]");
await page.waitForSelector("#inbox:not(.hidden)");
await page.goto(`${BASE}/merchant/agent`);
await page.waitForSelector("#page:not(.hidden)");
if (await page.isVisible("#off")) { await page.click("#off"); await page.waitForSelector("#on.hidden", { state: "attached" }); }
await page.fill("#text", RULE);
await shot("20-agent-write");
await page.click("#read");
await page.waitForSelector("#turn-on", { timeout: 30_000 });
log("read-back:", (await page.locator("#preview .agent-rules li").allTextContents()).join(" | "));
await shot("21-agent-readback");
await page.click("#turn-on");
await page.waitForSelector("#on:not(.hidden)");
await shot("22-agent-on");

// 2. A buyer pays through the PayPal sandbox and reports damage with a photo.
async function buyAndReport(items, photo, statement) {
  const order = await (await fetch(`${BASE}/api/demo/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) })).json();
  await page.goto(order.approveUrl);
  // PayPal remembers the sandbox buyer after the first purchase and skips the sign-in.
  if (await page.waitForSelector("#email", { timeout: 15_000 }).catch(() => null)) {
    await page.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
    await page.click("#btnNext");
    await page.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
    await page.click("#btnLogin");
  }
  const pay = page.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Continue")').first();
  await pay.waitFor({ timeout: 60_000 });
  await pay.click();
  await page.waitForURL((u) => !u.hostname.includes("paypal.com"), { timeout: 60_000 }).catch(() => {});
  let cap;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${BASE}/api/demo/orders/${order.paypalOrderId}/capture`, { method: "POST" });
    cap = await r.json();
    if (r.ok) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!cap.claimUrl) throw new Error("capture failed: " + JSON.stringify(cap));
  log("paid", order.paypalOrderId, "capture", cap.captureId);
  await page.goto(BASE + cap.claimUrl);
  await page.waitForSelector("#form:not(.hidden)");
  await page.fill("#statement", statement);
  await page.setInputFiles("#photos", photo);
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });
  const statusUrl = await page.getAttribute("#status-link", "href");
  return { statusUrl, claimId: new URL(BASE + statusUrl).searchParams.get("claim") };
}

async function settled(claimId) {
  for (let i = 0; i < 60; i++) {
    const d = await merchantApi(`/claims/${claimId}`);
    if (!["new", "refund_processing"].includes(d.claim.status) && d.timeline.some((s) => s.actor === "agent")) return d;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("the agent did not act in time");
}

// 3. A chipped mug: inside the rule, so the agent refunds it.
const mug = await buyAndReport([{ sku: "MUG-CLASSIC", quantity: 4 }], "demo-photos/1-kit-chipped-mug.jpg", "One of the mugs arrived with a chip on the rim.");
const m = await settled(mug.claimId);
log("mug:", m.claim.status, "|", m.timeline.find((s) => s.actor === "agent").detail);
log("mug refund:", JSON.stringify(m.refunds.map((r) => ({ id: r.providerRefundId, status: r.status, amount: r.amountCents }))));
log("mug findings:", m.assessment.findings?.damage_kind, JSON.stringify(m.assessment.findings?.signals?.damage_kind), "route", m.proposal.route, JSON.stringify(m.proposal.reasons));
await page.goto(`${BASE}/merchant/case?id=${mug.claimId}`);
await page.waitForSelector(".timeline");
await shot("23-agent-refunded-case");
await page.goto(BASE + mug.statusUrl);
await page.waitForSelector("#card:not(.hidden)");
await shot("24-agent-buyer-status");

// 4. A cracked vase: no rule covers it, so the agent leaves it for the merchant.
const vase = await buyAndReport([{ sku: "VASE-GLASS", quantity: 1 }], "demo-photos/2-vase-cracked.jpg", "The vase arrived with a crack down the side.");
const v = await settled(vase.claimId);
log("vase:", v.claim.status, "|", v.timeline.find((s) => s.actor === "agent").detail);
await page.goto(`${BASE}/merchant/case?id=${vase.claimId}`);
await page.waitForSelector(".timeline");
await shot("25-agent-left-case");

await page.goto(`${BASE}/merchant/`);
await page.waitForTimeout(2500);
await shot("26-agent-inbox");
await page.goto(`${BASE}/merchant/agent`);
await page.waitForSelector("#activity:not(.hidden)");
await shot("27-agent-activity");
await browser.close();
