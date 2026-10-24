// Records the full marketing walkthrough: one store, one PayPal checkout, and every way a damaged
// order gets put right, from both sides (buyer and shop). Captions describe what happens in plain
// words; no model or vendor names appear on screen (technical details stay collapsed).
//
// Paths shown:
//   1. Repair kit      chipped mug      -> the shop lets the buyer choose -> kintsugi kit + partial refund
//   2. Store pick      cracked vase     -> AI suggests an in-stock listing -> buyer takes it + partial refund
//   3. Wrong product   printed mug      -> remedies held back, the shop asks for a label photo
//   4. Unclear photo   blurry mug       -> the shop asks for a clearer photo -> re-checked -> free replacement
//   5. Straight refund mug in pieces    -> one click, one PayPal partial refund
//
// Needs the app running on a fresh database with REPEAT_CLAIM_LIMIT=0 and the live keys.
// Usage: CHROMIUM_PATH=/opt/pw-browsers/chromium node --env-file=.env scripts/record-marketing.js [out-dir]
// PREVIEW=1 runs against a server with test doubles (no PayPal popup; the checkout scene is skipped).
// Then: node scripts/stitch-marketing.js [out-dir]  ->  <out-dir>/refund-relay-marketing.mp4
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const PREVIEW = process.env.PREVIEW === "1";
const PACE = Number(process.env.PACE || 0.85); // caption hold time multiplier
const out = process.argv[2] || "data/marketing";
const size = { width: 1280, height: 800 };
const C = "probe/cases/", P = "probe/products/";
// Photos per path. DEMO_PHOTOS=<dir> swaps in <dir>/<name>.jpg (or .png) where present, e.g. damaged
// versions of the store's own catalog photos; 4a is blurred from 4b when only 4b is given.
const DEMO = process.env.DEMO_PHOTOS ?? (existsSync("demo-photos") ? "demo-photos" : undefined);
const PHOTO = Object.fromEntries(Object.entries({
  "1-kit-chipped-mug": C + "chipped-closeup.jpg",
  "2-vase-cracked": P + "vase-cracked.jpg",
  "3-wrong-product-mug": C + "broken-rocket-mug.jpg",
  "4a-blurry-mug": C + "blurred-broken-mug.jpg",
  "4b-clear-mug-handle-off": C + "broken-handle-white.jpg",
  "5-mug-in-pieces": C + "broken-shards-bubblewrap.jpg",
}).map(([k, f]) => [k, (DEMO && [".jpg", ".jpeg", ".png"].map((x) => `${DEMO}/${k}${x}`).find(existsSync)) || f]));
if (DEMO && !["4a-blurry-mug"].some((k) => PHOTO[k].startsWith(DEMO)) && PHOTO["4b-clear-mug-handle-off"].startsWith(DEMO)) {
  PHOTO["4a-blurry-mug"] = `${out}/4a-blurry-mug.jpg`;
  mkdirSync(out, { recursive: true });
  writeFileSync(PHOTO["4a-blurry-mug"], await sharp(PHOTO["4b-clear-mug-handle-off"]).blur(30).jpeg({ quality: 85 }).toBuffer());
}
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

// ---- Off camera: orders, claims and the merchant session -------------------------------------
async function json(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(body)}`);
  return { body, res };
}
const post = (path, body, headers = {}) => json(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const login = await post("/api/merchant/login", { password: process.env.MERCHANT_PASSWORD });
const cookie = login.res.headers.get("set-cookie").split(";")[0];
const merchant = (path) => json(`/api/merchant${path}`, { headers: { Cookie: cookie } }).then((r) => r.body);

// Pays a cart with the sandbox buyer in a separate, unrecorded browser.
async function buy(items) {
  const { body: order } = await post("/api/demo/orders", { items });
  if (!PREVIEW) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(order.approveUrl);
    await p.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
    await p.click("#btnNext");
    await p.waitForSelector("#password:visible", { timeout: 30_000 });
    await p.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
    await p.click("#btnLogin");
    const pay = p.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Continue")').first();
    await pay.waitFor({ timeout: 60_000 });
    await pay.click();
    await p.waitForURL((u) => !u.hostname.includes("paypal.com"), { timeout: 60_000 }).catch(() => {});
    await ctx.close();
  }
  for (let i = 0; ; i++) {
    const r = await fetch(`${BASE}/api/demo/orders/${order.paypalOrderId}/capture`, { method: "POST" });
    const cap = await r.json();
    if (r.ok && cap.claimUrl) return cap;
    if (i > 10) throw new Error("capture failed: " + JSON.stringify(cap));
    await wait(2000);
  }
}
const claimToken = (cap) => cap.claimUrl.split("#t=")[1];
const claimPath = (cap, sku) => {
  const [path, hash] = cap.claimUrl.split("#");
  return `${path}&line=${encodeURIComponent(cap.lines.find((l) => l.sku === sku).id)}#${hash}`;
};

async function fileClaim(cap, sku, photos, statement) {
  const form = new FormData();
  form.set("orderId", cap.orderId);
  form.set("lineId", cap.lines.find((l) => l.sku === sku).id);
  form.set("quantity", "1");
  form.set("statement", statement);
  for (const f of photos) form.append("photos", new Blob([readFileSync(f)], { type: f.endsWith(".png") ? "image/png" : "image/jpeg" }), f.split("/").pop());
  for (let i = 0; ; i++) {
    const r = await fetch(`${BASE}/api/claims`, { method: "POST", body: form, headers: { "X-Claim-Token": claimToken(cap) } });
    const body = await r.json();
    if (r.ok) return { id: body.claimId, statusUrl: body.statusUrl };
    if (r.status !== 429 || i > 6) throw new Error("claim failed: " + JSON.stringify(body));
    await wait(15_000); // the buyer endpoint allows a few requests a minute
  }
}
async function assessed(id) {
  for (let i = 0; i < 90; i++) {
    const d = await merchant(`/claims/${id}`);
    if (d.proposal?.current) return d;
    await wait(1000);
  }
  throw new Error(`claim ${id} was not assessed`);
}

log("setting up orders and requests off camera");
const STORE_CART = [{ sku: "MUG-CLASSIC", quantity: 2 }, { sku: "VASE-GLASS", quantity: 1 }, { sku: "TEE-ORGANIC", quantity: 1 }];
const setup = {};
setup.refund = await fileClaim(await buy([{ sku: "MUG-CLASSIC", quantity: 4 }]), "MUG-CLASSIC", [PHOTO["5-mug-in-pieces"]], "One of the four mugs arrived in pieces.");
setup.blurry = await fileClaim(await buy([{ sku: "MUG-CLASSIC", quantity: 1 }]), "MUG-CLASSIC", [PHOTO["4a-blurry-mug"]], "The handle snapped off in the post.");
setup.wrong = await fileClaim(await buy([{ sku: "MUG-CLASSIC", quantity: 1 }]), "MUG-CLASSIC", [PHOTO["3-wrong-product-mug"]], "My mug arrived broken.");
setup.vase = await fileClaim(await buy([{ sku: "VASE-GLASS", quantity: 1 }, { sku: "TEE-ORGANIC", quantity: 2 }]), "VASE-GLASS", [PHOTO["2-vase-cracked"]], "The vase arrived with a long crack down from the rim.");
// Other products, left for the shop to review: they fill the inbox shown at the end.
if (DEMO) {
  const extra = [["TEE-ORGANIC", "7-tee-stained", "The T-shirt arrived with a brown stain on the front."],
    ["HEADPHONES-OVER", "8-headphones-cushion-torn", "One ear cushion is torn open."],
    ["HEADPHONES-OVER", "10-headphones-headband-snapped", "The headband is snapped in two."]];
  for (const [sku, name, text] of extra) {
    const f = [".jpg", ".png"].map((x) => `${DEMO}/${name}${x}`).find(existsSync);
    if (f) setup[name] = await fileClaim(await buy([{ sku, quantity: 1 }]), sku, [f], text);
  }
}
const kitOrder = PREVIEW ? await buy(STORE_CART) : null; // live: bought on camera below
log("photos", JSON.stringify(PHOTO));
for (const [k, c] of Object.entries(setup)) log(k, (await assessed(c.id)).proposal.route);

// ---- On camera ------------------------------------------------------------------------------
const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
await context.addCookies([{ name: cookie.split("=")[0], value: cookie.slice(cookie.indexOf("=") + 1), url: BASE }]);
// A visible cursor and a soft click ring, so viewers can follow every action.
await context.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.id = "__cursor";
    c.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;" +
      "transition:transform .55s cubic-bezier(.22,1,.36,1);transform:translate(640px,460px)";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l16 9.5-7 1.5-3.8 6.5z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const st = document.createElement("style");
    st.textContent = ".demo-note{display:none!important}";
    document.head.appendChild(st);
    const pos = sessionStorage.getItem("__cursor");
    if (pos) c.style.transform = pos;
  });
});
const page = await context.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const cuts = [];
let cutFrom = null;
const cutStart = () => { cutFrom = now(); };
const cutEnd = () => { cuts.push([cutFrom, now()]); cutFrom = null; };

async function say(text, ms = 3000, p = page) {
  ms = Math.round(ms * PACE);
  await p.evaluate((text) => {
    let el = document.getElementById("__caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "__caption";
      el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483646;max-width:86%;" +
        "background:rgba(20,20,22,.86);backdrop-filter:blur(12px);color:#fff;font:600 21px/1.35 Inter,system-ui,sans-serif;" +
        "letter-spacing:-.01em;padding:13px 22px;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.28);text-align:center;" +
        "pointer-events:none;transition:opacity .3s ease;opacity:0";
      document.body.appendChild(el);
    }
    el.style.opacity = 0;
    setTimeout(() => { el.textContent = text; el.style.opacity = text ? 1 : 0; }, text && el.textContent ? 250 : 0);
  }, text).catch(() => {});
  await wait(ms);
}
// Page loads (blank frames, photos popping in) are cut from the video.
async function go(url) {
  cutStart();
  await page.goto(url);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  cutEnd();
}
async function moveTo(locator, p = page) {
  const box = await locator.boundingBox();
  if (!box) return;
  const t = `translate(${box.x + box.width / 2 - 4}px,${box.y + box.height / 2 - 2}px)`;
  await p.evaluate((t) => { const c = document.getElementById("__cursor"); if (c) { c.style.transform = t; sessionStorage.setItem("__cursor", t); } }, t);
  await wait(600);
}
async function tap(selector, p = page) {
  const l = p.locator(selector).first();
  await l.scrollIntoViewIfNeeded();
  await moveTo(l, p);
  await l.click();
  await wait(250);
}
// A case outside the one-click route needs a written reason before anything is sent.
async function giveReason(text) {
  if (await page.isVisible("#reason")) await page.fill("#reason", text);
}
async function glide(selector, block = "center") {
  await page.locator(selector).first().evaluate((el, block) => el.scrollIntoView({ behavior: "smooth", block }), block).catch(() => {});
  await wait(900);
}
async function slowType(selector, text) {
  await tap(selector);
  await page.locator(selector).first().pressSequentially(text, { delay: 28 });
}
async function card(title, sub, ms = 3600) {
  await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700&display=swap">
    <style>body{margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% 40%,#1b2a4a,#05070d);color:#fff;font-family:Inter,system-ui,sans-serif;text-align:center}
    .m{width:64px;height:64px;border-radius:16px;background:linear-gradient(145deg,#0a84ff,#5e5ce6);display:grid;place-items:center;margin:0 auto 26px;animation:p .6s cubic-bezier(.22,1,.36,1) both}
    h1{font-size:60px;letter-spacing:-.04em;margin:0 0 14px;animation:r .7s .1s cubic-bezier(.22,1,.36,1) both}
    p{font-size:25px;color:#b9c3d6;margin:0;letter-spacing:-.01em;max-width:900px;line-height:1.4;animation:r .7s .25s cubic-bezier(.22,1,.36,1) both}
    #__cursor{display:none}@keyframes r{from{opacity:0;transform:translateY(14px)}} @keyframes p{from{opacity:0;transform:scale(.8)}}</style></head>
    <body><div><div class="m"><svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg></div>
    <h1>${title}</h1><p>${sub}</p></div></body></html>`);
  await wait(ms);
}
const caseUrl = (id) => `${BASE}/merchant/case?id=${encodeURIComponent(id)}`;
async function openCase(id, settle = "#approve, #send-offer, #request-info, .ask-block") {
  await go(caseUrl(id));
  await page.waitForSelector(settle, { timeout: 90_000 });
  await wait(700);
}

// 0. Title
await card("Refund Relay", "Something arrived broken? Snap a photo, and the shop puts it right in minutes, paid back through PayPal.", 4200);

// 1. The store and the PayPal checkout
await go(BASE);
await page.waitForSelector(".tile");
await say("Meet Juniper Market: mugs, vases, T-shirts and headphones.", 3000);
for (const { sku, quantity } of STORE_CART) for (let i = 0; i < quantity; i++) { await tap(`[data-tile="${sku}"] [data-d="1"]`); await wait(350); }
await say("Pick what you like, and it drops into your bag.", 2600);
let kitCap = kitOrder, popupInfo = null;
if (!PREVIEW) {
  await page.waitForSelector("#paypal-buttons iframe", { timeout: 30_000 });
  await say("They check out with PayPal.", 1800);
  const frame = page.frameLocator("#paypal-buttons iframe").first();
  await moveTo(page.locator("#paypal-buttons iframe").first());
  const [popup] = await Promise.all([page.waitForEvent("popup"), frame.locator('[data-funding-source="paypal"]').first().click()]);
  const popupOpen = now();
  await popup.setViewportSize(size).catch(() => {});
  await popup.waitForSelector("#email", { timeout: 60_000 });
  const loginFrom = (Date.now() - t0) / 1000 - popupOpen; // sign-in is cut from the video
  await popup.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
  await popup.click("#btnNext");
  await popup.waitForSelector("#password:visible", { timeout: 30_000 });
  await popup.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
  await popup.click("#btnLogin");
  const pay = popup.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Pay")').first();
  await pay.waitFor({ timeout: 60_000 });
  await wait(1500);
  const loginTo = now() - popupOpen;
  await say("", 0, popup);
  await say("Paid in a couple of taps with PayPal.", 2600, popup);
  const closed = popup.waitForEvent("close", { timeout: 90_000 });
  await pay.click();
  await closed;
  popupInfo = { video: popup.video(), open: popupOpen, close: now(), cut: [loginFrom, loginTo] };
  cutStart(); // PayPal's "return to the shop" overlay while the capture finishes
  await page.waitForSelector("#done:not(.hidden)", { timeout: 60_000 });
  await wait(300);
  cutEnd();
  await wait(800);
  await say("Order confirmed. If anything goes wrong, every item has its own “Report a problem” link.", 3400);
  const href = await page.locator('[data-report]').first().getAttribute("href");
  const orderId = new URL(BASE + href).searchParams.get("order");
  kitCap = { orderId, claimUrl: href };
  await tap("[data-report]");
} else {
  await say("They check out with PayPal.", 1800);
  await go(BASE + claimPath(kitCap, "MUG-CLASSIC"));
}

// 2. Path 1: chipped mug -> repair kit
await page.waitForSelector("#form:not(.hidden)");
await say("One mug arrived chipped. Just say what happened…", 3000);
await slowType("#statement", "One mug has a chip in the rim.");
await moveTo(page.locator("#drop"));
await page.setInputFiles("#photos", PHOTO["1-kit-chipped-mug"]);
await say("…and add a photo.", 1600);
await tap("#submit");
await page.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });
const kitStatus = await page.getAttribute("#status-link", "href");
const kitId = new URL(BASE + kitStatus).searchParams.get("claim");
await say("Sent. The shop has it in seconds.", 2600);

await go(`${BASE}/merchant`);
await page.waitForSelector(".ag-row", { timeout: 30_000 }).catch(() => {});
await wait(600);
await say("Over at the shop, every request lands in one inbox, already checked.", 3600);
await tap('.ag-center-cols-container .ag-row[row-index="0"]');
await page.waitForSelector(".card", { timeout: 30_000 });
await say("The photo is compared with the shop's own product photo…", 1500);
cutStart();
await page.waitForSelector("#send-offer", { timeout: 90_000 });
cutEnd();
await wait(500);
await say("…and the damage is outlined.", 3000);
await glide(".finding:nth-of-type(4)");
await say("It's the same mug the shop sold, and the photo is clear.", 3600);
await glide(".offer-pitch");
await say("A small chip can be mended, so the shop's own repair kits are ready to offer.", 3600);
await giveReason("Chip is clear in the photo");
await tap("#send-offer");
await page.waitForSelector("text=Waiting for the buyer", { timeout: 30_000 });
await say("One click, and the customer gets to choose.", 3200);

await go(BASE + kitStatus);
await page.waitForSelector("[data-option]");
await say("The customer sees every option, including a full refund.", 3000);
await tap('[data-option="kintsugi"]');
await say("They keep the mug, mend it with a kintsugi kit, and take $12 back.", 3000);
await tap("#confirm");
await page.waitForSelector(".option.chosen", { timeout: 60_000 });
await wait(600);
await say("$12 is back in their PayPal account straight away. The kit ships free.", 3600);

// 3. Path 2: cracked vase -> an in-stock listing the AI suggests
await openCase(setup.vase.id);
await say("A cracked vase this time…", 2600);
await glide(".ai-suggest");
await say("…and the shop is shown something else it has in stock that would make up for it.", 3600);
const add = page.locator(".ai-suggest [data-approve]").first();
if (await add.count()) {
  await tap(".ai-suggest [data-approve]");
  await page.waitForSelector(".ai-suggest .pill.ok", { timeout: 30_000 });
  await say("The shop adds it to the choices with one click. Nothing goes out without the shop's OK.", 3400);
}
await giveReason("Crack is clear in the photo");
await tap("#send-offer");
await page.waitForSelector("text=Waiting for the buyer", { timeout: 30_000 });
await go(BASE + setup.vase.statusUrl);
await page.waitForSelector("[data-option]");
const pick = (await page.locator('[data-option^="ai_"]').count()) ? '[data-option^="ai_"]' : '[data-option]:nth-child(2)';
await tap(pick);
await say("The customer takes the shop's suggestion.", 2800);
await tap("#confirm");
await page.waitForSelector(".option.chosen", { timeout: 60_000 });
await wait(1800);

// 4. Path 3: a different product -> remedies held, the shop asks for a label photo
await openCase(setup.wrong.id);
await say("This photo shows a printed mug, but the shop sold a plain white one.", 3200);
await glide(".finding:nth-of-type(4)");
await say("It's flagged as a different product…", 3000);
await glide(".ask-block");
await say("…so nothing is offered yet, and the shop simply asks for a photo of the label.", 3400);
await tap("#request-info");
await page.waitForSelector("text=You asked the buyer", { timeout: 30_000 });
await go(BASE + setup.wrong.statusUrl);
await page.waitForSelector("#more:not(.hidden)");
await say("The customer sees exactly what the shop needs.", 3000);

// 5. Path 4: an unclear photo -> clearer photo -> re-checked -> free replacement
await openCase(setup.blurry.id);
await say("This photo is too blurry to tell, so the shop asks for a clearer one.", 3200);
await tap("#request-info");
await page.waitForSelector("text=You asked the buyer", { timeout: 30_000 });
await go(BASE + setup.blurry.statusUrl);
await page.waitForSelector("#more:not(.hidden)");
await say("The customer sends a clear photo from their phone.", 2400);
await moveTo(page.locator("#drop"));
await page.setInputFiles("#photos", PHOTO["4b-clear-mug-handle-off"]);
await wait(700);
await tap("#send");
await page.waitForSelector("#flash .notice", { timeout: 30_000 });
await wait(1200);
await go(caseUrl(setup.blurry.id));
await page.waitForSelector(".card");
cutStart();
await page.waitForSelector("#send-offer, #approve", { timeout: 90_000 });
cutEnd();
await wait(500);
await say("Checked again in seconds: the handle snapped off, so a new mug is the best fix.", 3400);
if (await page.isVisible("#send-offer")) {
  await giveReason("Snapped handle is clear in the new photo");
  await tap("#send-offer");
  await page.waitForSelector("text=Waiting for the buyer", { timeout: 30_000 });
  await go(BASE + setup.blurry.statusUrl);
  await page.waitForSelector("[data-option]");
  const replacement = (await page.locator('[data-option="replacement"]').count()) ? '[data-option="replacement"]' : "[data-option]";
  await tap(replacement);
  await tap("#confirm");
  await page.waitForSelector(".option.chosen", { timeout: 60_000 });
  await wait(600);
  await say("A free replacement is on its way.", 3400);
}

// 6. Path 5: a mug in pieces -> one-click PayPal refund
await openCase(setup.refund.id);
await say("And sometimes a straight refund is simplest.", 2600);
await glide("#approve");
if (await page.isVisible("#reason")) await slowType("#reason", "Mug clearly in pieces");
await tap("#approve");
await page.waitForSelector("text=PayPal refund completed", { timeout: 60_000 });
await wait(600);
await say("One click, and the money is back with the customer through PayPal.", 3600);
await glide("text=How this case was handled", "start");
await say("Every step is on record: who did what, and why.", 3600);

// 7. The shop's overview and the remedy library
await go(`${BASE}/merchant`);
await page.waitForSelector(".ag-row", { timeout: 30_000 }).catch(() => {});
await wait(600);
await say(Object.keys(setup).length > 4 ? "Mugs, glass, clothing, electronics: each product gets its own damage checks." : "Five requests, five fair outcomes, and the shop stayed in control of every one.", 4000);
await go(`${BASE}/merchant/remedies`);
await wait(1500);
await say("Shops set their own remedies in plain words, and only those are ever offered.", 4000);

await card("Turn a broken order into the next sale.", "Refund Relay · built on PayPal", 3800);

const mainVideo = page.video();
await context.close();
const kit = await merchant(`/claims/${kitId}`);
log("kit refunds", JSON.stringify(kit.refunds.map((r) => [r.providerRefundId, r.status, r.amountCents])));
for (const [k, c] of Object.entries(setup)) {
  const d = await merchant(`/claims/${c.id}`);
  log(k, d.claim.status, JSON.stringify(d.refunds.map((r) => [r.providerRefundId, r.status, r.amountCents])));
}
writeFileSync(`${out}/timeline.json`, JSON.stringify({
  main: { file: await mainVideo.path(), cuts },
  popup: popupInfo && { file: await popupInfo.video.path(), open: popupInfo.open, close: popupInfo.close, cut: popupInfo.cut },
}, null, 2));
await browser.close();
log("recorded", out);
