// Live run for the damage-marks screens: a real sandbox purchase, a claim with several real photos,
// then the merchant case page (light, dark, phone) and the enlarged photo. Stops before approving.
// Usage: node --env-file=.env scripts/damage-marks-shots.js [photo.jpg ...]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const photos = process.argv.slice(2).length ? process.argv.slice(2)
  : ["probe/cases/broken-handle-white.jpg", "probe/cases/chipped-closeup.jpg", "probe/cases/intact-milkglass-mug.jpg"];
const shots = process.env.SHOTS_DIR || "hackathon/screenshots/marks";
mkdirSync(shots, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const shot = async (p, name, full = true) => { await p.waitForTimeout(1200); await p.screenshot({ path: `${shots}/${name}.png`, fullPage: full }); };

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

let cap;
for (let i = 0; i < 10; i++) {
  const r = await fetch(`${BASE}/api/demo/orders/${order.paypalOrderId}/capture`, { method: "POST" });
  cap = await r.json();
  if (r.ok) break;
  await new Promise((r) => setTimeout(r, 2000));
}
if (!cap.claimUrl) throw new Error("capture failed: " + JSON.stringify(cap));
log("captured", cap.captureId);

await page.goto(BASE + cap.claimUrl);
await page.waitForSelector("#form:not(.hidden)");
await page.fill("#statement", "One of the four mugs arrived broken; the handle snapped off and another is chipped.");
await page.setInputFiles("#photos", photos);
await page.click("#submit");
await page.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });

await page.goto(`${BASE}/merchant/`);
await page.waitForSelector("#login:not(.hidden)");
await page.fill("#password", process.env.MERCHANT_PASSWORD);
await page.click("#login button[type=submit]");
await page.waitForSelector("#inbox:not(.hidden) a.inbox-row");
await page.click("a.inbox-row");
await page.waitForSelector("#approve", { timeout: 60_000 });
const caseUrl = page.url();
await shot(page, "case-light");
await page.click("[data-mark='0']");
await shot(page, "zoom-light", false);
await page.keyboard.press("Escape");
await page.click("[data-mark='1']");
await shot(page, "zoom-chip-light", false);
await page.keyboard.press("Escape");

const cookies = await ctx.cookies();
const detail = await (await fetch(caseUrl.replace("/merchant/case.html?id=", "/api/merchant/claims/").replace("/merchant/case?id=", "/api/merchant/claims/"), { headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") } })).json().catch(() => null);
if (detail?.evidence) log("marks", JSON.stringify(detail.evidence.map((e) => e.mark)), "findings", JSON.stringify(detail.assessment.findings?.visible_breakage), detail.assessment.latencyMs + "ms");

for (const [name, opts] of [["dark", { colorScheme: "dark", viewport: { width: 1280, height: 900 } }], ["phone-dark", { colorScheme: "dark", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }], ["phone-light", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }]]) {
  const c = await browser.newContext(opts);
  await c.addCookies(cookies);
  const p = await c.newPage();
  await p.goto(caseUrl);
  await p.waitForSelector("#approve");
  await shot(p, `case-${name}`, !name.startsWith("phone"));
  if (name === "dark") { await p.click("[data-mark='0']"); await shot(p, "zoom-dark", false); }
  await c.close();
}
log("case", caseUrl);
await browser.close();
