// Records the walkthrough video (under 3 minutes): how a shop sets up Refund Relay, how it plugs into
// the store and PayPal, and how it performs on three live damage reports. Narrated by the shop owner;
// no model or vendor names appear on screen. Styled in the Refund Relay brand (hackathon/DESIGN.md):
// Schibsted Grotesk, ink on stone, marker yellow for the damage box.
//
// Acts: hook (the yellow box finds the chip), Set up (account, PayPal, key), Plug in (one call after
// checkout, the button), See it work (rules, a chipped mug refunded by the agent, a shopper's own
// assistant, a cracked vase left to the owner, a wrong-product photo held), Stay in control (inbox,
// agent log, off switch), end card.
//
// Needs the app running on a fresh database with REPEAT_CLAIM_LIMIT=0 and the live keys.
// Usage: CHROMIUM_PATH=/opt/pw-browsers/chromium node --env-file=.env scripts/record-walkthrough-video.js [out-dir]
// Voice first: python3 scripts/voice/tts.py scripts/voice/walkthrough-lines.json data/voice-walk <kokoro-dir>
// Then: node scripts/stitch-agent-video.js [out-dir] Inspired.mp3
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { HAIKU_MODEL } from "../src/ai/haiku.js";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const out = process.argv[2] || "data/walkthrough-video";
const size = { width: 1280, height: 800 };
const RULE = process.env.AGENT_RULE || "Refund mugs that arrive chipped or with a snapped handle, under $25, on your own. Ask me about anything above that.";
const DEMO = process.env.DEMO_PHOTOS || "demo-photos";
const photo = (name, fallback) => [".jpg", ".png"].map((x) => `${DEMO}/${name}${x}`).find(existsSync) || fallback;
const PHOTO = {
  chip: photo("1-kit-chipped-mug"),
  pieces: resolve(photo("4b-clear-mug-handle-off")),
  vase: photo("2-vase-cracked"),
  wrong: photo("3-wrong-product-mug", "probe/cases/broken-rocket-mug.jpg"),
};
mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

// ---- Off camera: orders and the merchant session -----------------------------------------------
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
await json("/api/merchant/agent", { method: "DELETE", headers: { Cookie: cookie, "X-Refund-Relay": "1" } }).catch(() => {});

// Pays a cart with the sandbox buyer in a separate, unrecorded browser.
async function buy(items) {
  const { body: order } = await post("/api/demo/orders", { items });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(order.approveUrl);
  if (await p.waitForSelector("#email", { timeout: 15_000 }).catch(() => null)) {
    await p.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
    await p.click("#btnNext");
    await p.waitForSelector("#password:visible", { timeout: 30_000 });
    await p.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
    await p.click("#btnLogin");
  }
  const pay = p.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Continue")').first();
  await pay.waitFor({ timeout: 60_000 });
  await pay.click();
  await p.waitForURL((u) => !u.hostname.includes("paypal.com"), { timeout: 60_000 }).catch(() => {});
  await ctx.close();
  log("paid", order.paypalOrderId);
  for (let i = 0; ; i++) {
    const r = await fetch(`${BASE}/api/demo/orders/${order.paypalOrderId}/capture`, { method: "POST" });
    const cap = await r.json();
    if (r.ok && cap.claimUrl) return cap;
    if (i > 10) throw new Error("capture failed: " + JSON.stringify(cap));
    await wait(2000);
  }
}
const claimToken = (cap) => cap.claimUrl.split("#t=")[1];

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
// Waits until the photo check is done and, with the agent on, until the agent has had its say.
async function settled(id) {
  for (let i = 0; i < 90; i++) {
    const d = await merchant(`/claims/${id}`);
    if (!["new", "refund_processing"].includes(d.claim.status) && d.timeline.some((s) => s.actor === "agent")) return d;
    await wait(1500);
  }
  throw new Error(`claim ${id} was not settled`);
}

log("paying for the orders off camera");
const orders = {
  pieces: await buy([{ sku: "MUG-CLASSIC", quantity: 4 }]),
  vase: await buy([{ sku: "VASE-GLASS", quantity: 1 }, { sku: "TEE-ORGANIC", quantity: 2 }]),
  wrong: await buy([{ sku: "MUG-CLASSIC", quantity: 1 }]),
};
log("photos", JSON.stringify(PHOTO));

// ---- On camera ------------------------------------------------------------------------------
const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
await context.addCookies([{ name: cookie.split("=")[0], value: cookie.slice(cookie.indexOf("=") + 1), url: BASE }]);
// A visible cursor, so viewers can follow every action.
await context.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const c = document.createElement("div");
    c.id = "__cursor";
    c.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;" +
      "transition:transform .55s cubic-bezier(.22,1,.36,1);transform:translate(640px,460px)";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l16 9.5-7 1.5-3.8 6.5z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const st = document.createElement("style");
    st.textContent = ".demo-note,.kv-row .footnote,.tech{display:none!important}" +
      "body{transition:transform 1.4s cubic-bezier(.22,1,.36,1)}" +
      "#pp-id,#pp-secret,#newkey .mono,#newkey-value{filter:blur(6px)}";
    document.head.appendChild(st);
    const mk = document.createElement("div");
    mk.id = "__mark";
    mk.style.cssText = "position:fixed;left:0;top:0;width:10px;height:10px;z-index:2147483647;pointer-events:none;background:" + (sessionStorage.getItem("__mark") || "transparent");
    document.documentElement.appendChild(mk);
    const pos = sessionStorage.getItem("__cursor");
    if (pos) c.style.transform = pos;
  });
});
// The setup snippets name the server they were made on; when recording on this machine, show the
// shop's real address instead of localhost.
const PUBLIC_URL = process.env.PUBLIC_URL || "https://refund-relay.onrender.com";
if (!BASE.startsWith("https://")) await context.addInitScript(([from, to]) => {
  const fix = () => { for (const el of document.querySelectorAll("pre.code")) if (el.textContent.includes(from)) el.textContent = el.textContent.replaceAll(from, to); };
  addEventListener("DOMContentLoaded", () => { fix(); new MutationObserver(fix).observe(document.body, { childList: true, subtree: true, characterData: true }); });
}, [BASE, PUBLIC_URL]);
const page = await context.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const cuts = [];
let cutFrom = null;
// Playwright's video drifts from the wall clock (seconds over a long take), so every cut and line
// also flips a 10 px corner square through red, green and blue. The stitcher finds the flips in
// the video and maps each wall-clock moment onto the video's own time.
const MARK_COLORS = ["#ff0000", "#00ff00", "#0000ff"];
const marks = [];
async function mark(p = page) {
  const color = MARK_COLORS[marks.length % 3];
  marks.push(now());
  await p.evaluate((color) => {
    try { sessionStorage.setItem("__mark", color); } catch {} // about:blank pages have no storage
    let mk = document.getElementById("__mark");
    if (!mk) {
      mk = document.createElement("div");
      mk.id = "__mark";
      mk.style.cssText = "position:fixed;left:0;top:0;width:10px;height:10px;z-index:2147483647;pointer-events:none";
      document.documentElement.appendChild(mk);
    }
    mk.style.background = color;
  }, color).catch(() => {});
  await wait(150);
}
// Pages made with setContent get the marker back in the colour it last had.
const remark = () => page.evaluate((color) => {
  // Reuse the marker the init script made, so only one square is ever on screen.
  const mk = document.getElementById("__mark") || document.createElement("div");
  mk.id = "__mark";
  mk.style.cssText = `position:fixed;left:0;top:0;width:10px;height:10px;z-index:2147483647;pointer-events:none;background:${color}`;
  document.documentElement.appendChild(mk);
}, marks.length ? MARK_COLORS[(marks.length - 1) % 3] : "transparent").catch(() => {});
const cutStart = async () => { await mark(); cutFrom = now(); };
const cutEnd = async () => { await mark(); cuts.push([cutFrom, now()]); cutFrom = null; };

// Each caption is a line of the voiceover: shown on screen and held until the voice clip ends.
// The time each line starts is logged, so the stitcher can lay the voice under the cut video.
const LINES = JSON.parse(readFileSync(process.env.LINES || "scripts/voice/walkthrough-lines.json", "utf8"));
const VOICE = process.env.VOICE_DIR || "data/voice-walk";
const DURATIONS = existsSync(`${VOICE}/durations.json`) ? JSON.parse(readFileSync(`${VOICE}/durations.json`, "utf8")) : {};
const spoken = [];
const voice = async (key, p = page) => { if (p === page) await mark(); spoken.push({ key, at: now() }); return Math.round(((DURATIONS[key] ?? LINES[key].split(" ").length / 2.6) + 0.45) * 1000); };
async function say(key, min = 0, p = page) {
  const text = key ? LINES[key] : "";
  const ms = key ? Math.max(min, await voice(key, p)) : min;
  await p.evaluate((text) => {
    let el = document.getElementById("__caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "__caption";
      el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483646;max-width:86%;" +
        "background:#171614;color:#f3f2ef;font:600 21px/1.35 'Schibsted Grotesk',system-ui,sans-serif;" +
        "letter-spacing:-.01em;padding:12px 22px 12px 20px;border-radius:10px;border-left:5px solid #ffd21f;text-align:left;" +
        "pointer-events:none;transition:opacity .3s ease;opacity:0";
      document.documentElement.appendChild(el);
    }
    el.style.opacity = 0;
    setTimeout(() => { el.textContent = text; el.style.opacity = text ? 1 : 0; }, text && el.textContent ? 250 : 0);
  }, text).catch(() => {});
  await wait(ms);
}
// Page loads (blank frames, photos popping in) are cut from the video.
async function go(url) {
  await cutStart();
  await page.goto(url);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await cutEnd();
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
async function giveReason(text) {
  if (await page.isVisible("#reason")) await page.fill("#reason", text);
}
async function glide(selector, block = "center") {
  await page.locator(selector).first().evaluate((el, block) => el.scrollIntoView({ behavior: "smooth", block }), block).catch(() => {});
  await wait(900);
}
async function slowType(selector, text, delay = 28) {
  await tap(selector);
  await page.locator(selector).first().pressSequentially(text, { delay });
}
const FONT = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@500;600;700;800&display=swap">`;
const MARK_SVG = (s = 40) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="#1f1a00" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg>`;
const BASE_CSS = `body{margin:0;height:100vh;display:grid;place-items:center;background:#f3f2ef;color:#171614;font-family:'Schibsted Grotesk',system-ui,sans-serif;text-align:center;overflow:hidden}
  .m{width:72px;height:72px;border-radius:16px;background:#ffd21f;display:grid;place-items:center;margin:0 auto 28px}
  #__cursor{display:none} @keyframes r{from{opacity:0;transform:translateY(14px)}} @keyframes p{from{opacity:0;transform:scale(.85)}}`;
async function setPage(html) {
  await page.setContent(`<!doctype html><html><head>${FONT}<style>${BASE_CSS}</style></head><body>${html}</body></html>`);
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
  await remark();
}
// A one-second act title: the act name in ink, a yellow box drawn around it.
async function act(n, title) {
  await setPage(`<style>.a{position:relative;display:inline-block;padding:18px 34px}
    .a small{display:block;font-size:20px;font-weight:600;color:#5f5b54;letter-spacing:.02em;margin-bottom:8px;animation:r .5s both}
    .a h1{margin:0;font-size:76px;font-weight:800;letter-spacing:-.04em;animation:r .55s .05s both}
    .a svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
    .a rect{fill:none;stroke:#ffd21f;stroke-width:6;stroke-dasharray:1400;stroke-dashoffset:1400;animation:d .9s .15s cubic-bezier(.22,1,.36,1) forwards}
    @keyframes d{to{stroke-dashoffset:0}}</style>
    <div class="a"><small>${n}</small><h1>${title}</h1><svg><rect x="0" y="0" width="100%" height="100%" rx="10"/></svg></div>`);
  await wait(1400);
}
const caseUrl = (id) => `${BASE}/merchant/case?id=${encodeURIComponent(id)}`;
async function openCase(id, settle = ".timeline") {
  await go(caseUrl(id));
  await page.waitForSelector(settle, { timeout: 90_000 });
  await wait(700);
}

// Slow zoom onto one part of the page (scale 1 resets). Cursor and captions sit outside <body>, so they stay put.
async function zoom(selector, scale = 1.5) {
  if (scale === 1) { await page.evaluate(() => { document.body.style.transform = ""; }); await wait(1400); return; }
  await page.locator(selector).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  await wait(300);
  await page.locator(selector).first().evaluate((el, scale) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2 + scrollX, y = r.top + r.height / 2 + scrollY;
    document.body.style.transformOrigin = `${x}px ${y}px`;
    document.body.style.transform = `scale(${scale})`;
  }, scale);
  await wait(1400);
}

// ---- Hook: the yellow box finds the chip ---------------------------------------------------------
const chipImg = `data:image/jpeg;base64,${readFileSync(PHOTO.chip).toString("base64")}`;
await setPage(`<style>.ph{position:relative;width:900px;height:600px;border-radius:14px;overflow:hidden;animation:p 1s cubic-bezier(.22,1,.36,1) both}
  .ph img{width:100%;height:100%;object-fit:cover;transform:scale(1.04);animation:z 9s linear forwards}
  .ph svg{position:absolute;inset:0;width:100%;height:100%}
  .ph rect{fill:none;stroke:#ffd21f;stroke-width:5;stroke-dasharray:600;stroke-dashoffset:600;animation:d 1.1s 1.4s cubic-bezier(.22,1,.36,1) forwards}
  .tag{position:absolute;left:calc(33% - 2px);top:calc(21.5% - 34px);background:#ffd21f;color:#1f1a00;font-weight:700;font-size:15px;padding:5px 10px;border-radius:6px 6px 6px 0;opacity:0;animation:r .5s 2.3s forwards}
  .brand{position:absolute;left:36px;top:30px;display:flex;gap:12px;align-items:center;font-weight:700;font-size:22px;opacity:0;animation:r .6s 6s forwards}
  .brand i{width:38px;height:38px;border-radius:8px;background:#ffd21f;display:grid;place-items:center}
  @keyframes d{to{stroke-dashoffset:0}} @keyframes z{to{transform:scale(1.12)}} @keyframes r{to{opacity:1;transform:none}}</style>
  <div class="brand"><i>${MARK_SVG(22)}</i>Refund Relay</div>
  <div class="ph"><img src="${chipImg}"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><rect x="33" y="21.5" width="9.5" height="9" rx="1" vector-effect="non-scaling-stroke"/></svg><div class="tag">Chip in the rim</div></div>`);
await wait(500);
await say("hook");

// ---- Act 1: Set up ------------------------------------------------------------------------------
await act("1", "Set up");
await context.clearCookies(); // a new shop signs up; the console session comes back after act 2
await go(`${BASE}/dashboard`);
await page.waitForSelector("#auth:not(.hidden)");
// Lines play while the hands work; each is finished before anything that is cut from the video.
const setup1 = say("setup1");
await slowType("#s-name", "Juniper Market", 30);
await tap("#s-email");
await page.fill("#s-email", `owner+${Date.now().toString(36)}@junipermarket.shop`);
await tap("#s-pass");
await page.fill("#s-pass", `Juniper-${Date.now()}`);
await setup1;
await tap('#signup button[type="submit"]');
await cutStart();
await page.waitForSelector("#page:not(.hidden)", { timeout: 30_000 });
await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
await cutEnd();
await wait(500);
await glide("#step-paypal", "start");
const setup2 = say("setup2");
await tap("#pp-id");
await page.fill("#pp-id", process.env.PAYPAL_CLIENT_ID);
await tap("#pp-secret");
await page.fill("#pp-secret", process.env.PAYPAL_CLIENT_SECRET);
await setup2;
await tap("#pp-save");
await cutStart();
await page.waitForSelector("#pp-connected:not(.hidden)", { timeout: 30_000 });
await cutEnd();
await wait(500);
await glide("#step-key", "start");
await slowType("#key-label", "Store server", 40);
await tap("#key-create");
await page.waitForSelector("#newkey:not(.hidden)", { timeout: 15_000 });
await say("setup3", 300);

// ---- Act 2: Plug in -----------------------------------------------------------------------------
await act("2", "Plug in");
await go(`${BASE}/dashboard`);
await page.waitForSelector("#page:not(.hidden)");
await page.locator("#step-order").evaluate((el) => el.scrollIntoView({ block: "start" }));
await wait(500);
await zoom("#snippet", 1.35);
await say("plug1");
await zoom(null, 1);
await glide("#step-button", "start");
await moveTo(page.locator("#button-preview"));
await zoom("#button-preview", 1.6);
await say("plug2");
await zoom(null, 1);

// Back to the shop's own console for the rest.
await context.addCookies([{ name: cookie.split("=")[0], value: cookie.slice(cookie.indexOf("=") + 1), url: BASE }]);

// ---- Act 3: See it work -------------------------------------------------------------------------
await act("3", "See it work");
await go(`${BASE}/merchant/agent`);
await page.waitForSelector("#page:not(.hidden)");
const rule1 = say("rule1");
await page.fill("#text", "");
await slowType("#text", RULE, 12);
await rule1;
await tap("#read");
await cutStart();
await page.waitForSelector("#turn-on", { timeout: 60_000 });
await cutEnd();
await glide("#preview", "start");
await say("rule2");
await tap("#turn-on");
await page.waitForSelector("#on:not(.hidden)");
await wait(900);

// Reports that land once the agent is on: it reads each one after the photo check.
// One after the other, so the photo check is never asked about both at once.
const vaseFiled = fileClaim(orders.vase, "VASE-GLASS", [PHOTO.vase], "The vase arrived with a long crack down from the rim.");
const later = {
  vase: vaseFiled,
  wrong: vaseFiled.then((c) => settled(c.id)).then(() => fileClaim(orders.wrong, "MUG-CLASSIC", [PHOTO.wrong], "My mug arrived broken.")),
};

// A shopper buys with PayPal and reports a chipped mug; the agent refunds it.
const STORE_CART = [{ sku: "MUG-CLASSIC", quantity: 2 }, { sku: "VASE-GLASS", quantity: 1 }];
await go(BASE);
await page.waitForSelector(".tile");
const storeLine = say("store");
for (const { sku, quantity } of STORE_CART) for (let i = 0; i < quantity; i++) { await tap(`[data-tile="${sku}"] [data-d="1"]`); await wait(200); }
await page.waitForSelector("#paypal-buttons iframe", { timeout: 30_000 });
await storeLine;
const frame = page.frameLocator("#paypal-buttons iframe").first();
await moveTo(page.locator("#paypal-buttons iframe").first());
const [popup] = await Promise.all([page.waitForEvent("popup"), frame.locator('[data-funding-source="paypal"]').first().click()]);
const popupOpen = now();
await popup.setViewportSize(size).catch(() => {});
await popup.waitForSelector("#email", { timeout: 60_000 });
const loginFrom = now() - popupOpen; // sign-in is cut from the video
await popup.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
await popup.click("#btnNext");
await popup.waitForSelector("#password:visible", { timeout: 30_000 });
await popup.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
await popup.click("#btnLogin");
const pay = popup.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Pay")').first();
await pay.waitFor({ timeout: 60_000 });
await wait(1500);
const loginTo = now() - popupOpen;
await say("", 1200, popup);
const closed = popup.waitForEvent("close", { timeout: 90_000 });
await pay.click();
await closed;
const popupInfo = { video: popup.video(), open: popupOpen, close: now(), cut: [loginFrom, loginTo] };
await cutStart(); // PayPal's "return to the shop" overlay while the capture finishes
await page.waitForSelector("#done:not(.hidden)", { timeout: 60_000 });
await wait(300);
await cutEnd();
await wait(500);
await tap("[data-report]");
await page.waitForSelector("#form:not(.hidden)");
const chip1 = say("chip1");
await slowType("#statement", "One mug has a chip in the rim.", 20);
await moveTo(page.locator("#drop"));
await page.setInputFiles("#photos", PHOTO.chip);
await chip1;
await tap("#submit");
const sentAt = Date.now();
await page.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });
const chipStatus = await page.getAttribute("#status-link", "href");
const chipId = new URL(BASE + chipStatus).searchParams.get("claim");
await go(BASE + chipStatus);
await page.waitForSelector("#card:not(.hidden)");
await cutStart();
await settled(chipId);
const chipSeconds = (Date.now() - sentAt) / 1000;
log("chipped mug: report to refund", chipSeconds.toFixed(1), "s");
await page.reload();
await page.waitForSelector("#card .amount", { timeout: 30_000 });
await wait(800);
await cutEnd();
await say("refunded");
await openCase(chipId);
await glide(".timeline", "start");
await say("case");

// A shopper's own assistant reports a mug with a snapped handle; the agent refunds it.
const MODEL = process.env.ASSISTANT_MODEL || HAIKU_MODEL;
const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
const anthropic = new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
const piecesImg = `data:image/jpeg;base64,${readFileSync(PHOTO.pieces).toString("base64")}`;
await setPage(`<style>body{display:grid;place-items:center;text-align:left}
  .phone{width:540px;height:690px;background:#fff;border-radius:30px;border:1px solid #e0ddd7;display:flex;flex-direction:column;overflow:hidden}
  .head{padding:20px 22px 14px;border-bottom:1px solid #ebe8e3;display:flex;gap:12px;align-items:center}
  .av{width:38px;height:38px;border-radius:50%;background:#171614;display:grid;place-items:center;color:#f3f2ef;font-weight:700}
  .head b{display:block;font-size:17px;letter-spacing:-.01em}.head span{font-size:13px;color:#5f5b54}
  #log{flex:1;overflow:hidden;padding:18px 18px 90px;display:flex;flex-direction:column;gap:10px;justify-content:flex-end;background:#f3f2ef}
  .msg{max-width:82%;padding:11px 15px;border-radius:18px;font-size:16px;line-height:1.4;animation:r .35s cubic-bezier(.22,1,.36,1) both;white-space:pre-wrap}
  .me{align-self:flex-end;background:#171614;color:#f3f2ef;border-bottom-right-radius:5px}
  .bot{align-self:flex-start;background:#fff;color:#171614;border-bottom-left-radius:5px;border:1px solid #e0ddd7}
  .me img{display:block;width:150px;border-radius:10px;margin-top:8px}
  .link{display:inline-block;margin-top:8px;padding:5px 10px;border-radius:8px;background:rgba(255,255,255,.14);font-size:14px}
  .step{align-self:flex-start;font-size:13.5px;color:#5f5b54;display:flex;gap:8px;align-items:center;padding:2px 6px;animation:r .3s ease both}
  .step i{width:8px;height:8px;border-radius:2px;background:#1d6b3f;flex:none}.step.wait i{background:#ffd21f;animation:pulse 1s infinite}
  @keyframes pulse{50%{opacity:.3}}</style>
  <div class="phone"><div class="head"><div class="av">A</div><div><b>My assistant</b><span>Can use: my Juniper Market order link</span></div></div><div id="log"></div></div>`);
const add = (cls, html) => page.evaluate(([cls, html]) => {
  const log = document.getElementById("log");
  const el = document.createElement("div");
  el.className = cls;
  el.innerHTML = html;
  log.appendChild(el);
  while (log.scrollHeight > log.clientHeight && log.children.length > 1) log.firstElementChild.remove();
}, [cls, html]);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
await wait(400);
await add("msg me", `The handle snapped off one of my four Juniper Market mugs. Can you sort it out?<br><span class="link">Juniper Market order link</span><img src="${piecesImg}">`);
await say("asst1");
const STEP = { get_order: "Opened your Juniper Market order", report_damage: "Reported the broken mug to the shop, with your photo", check_request: "Waiting to hear back from the shop", choose_option: "Picked an option", add_photos: "Sent more photos" };
let piecesStatus = null;
{
  const client = new Client({ name: "shopper-assistant", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["mcp/buyer.js"], env: { ...process.env }, stderr: "inherit" }));
  const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const messages = [{ role: "user", content: `The handle snapped off one of the four mugs in my Juniper Market order. Here's the link they sent me after I paid: ${BASE}${orders.pieces.claimUrl}\nPhoto: ${PHOTO.pieces}\nCan you sort it out and tell me when the money's back?` }];
  const system = "You are a personal shopping assistant acting for your user with online shops. Use the tools to deal with the shop. Be brief: your final reply is at most two short sentences, with no ids, reference numbers or links. Do not ask the user questions you can answer with the tools; when the shop offers choices, pick the full refund unless the user said otherwise.";
  try {
    for (let turn = 0; turn < 12; turn++) {
      await cutStart();
      const res = await anthropic.messages.create({ model: MODEL, max_tokens: 1000, system, tools, messages });
      await cutEnd();
      messages.push({ role: "assistant", content: res.content });
      const calls = res.content.filter((b) => b.type === "tool_use");
      if (!calls.length) {
        const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        await add("msg bot", esc(text));
        log("assistant:", text);
        break;
      }
      const results = [];
      for (const c of calls) {
        const waiting = c.name === "check_request";
        await add(`step${waiting ? " wait" : ""}`, `<i></i>${STEP[c.name] || c.name}…`);
        await wait(700);
        if (waiting) await cutStart();
        const r = await client.callTool({ name: c.name, arguments: c.input }, undefined, { timeout: 180_000 });
        if (waiting) await cutEnd();
        const text = r.content.map((x) => x.text).join("\n");
        log(c.name, "->", text.slice(0, 200).replace(/\n/g, " | "));
        piecesStatus ??= text.match(/\/status\?claim=[^\s#]+#t=[\w-]+/)?.[0];
        if (waiting) await page.evaluate(() => { const s = [...document.querySelectorAll(".step.wait")].pop(); if (s) s.className = "step"; });
        results.push({ type: "tool_result", tool_use_id: c.id, content: text, is_error: !!r.isError });
      }
      messages.push({ role: "user", content: results });
    }
  } finally {
    await client.close();
  }
}
// The take is only worth keeping if the agent really paid the assistant's request.
const piecesClaim = piecesStatus && new URL(BASE + piecesStatus).searchParams.get("claim");
const piecesCase = piecesClaim && (await merchant(`/claims/${piecesClaim}`));
if (!piecesCase?.refunds.some((r) => r.status === "COMPLETED")) throw new Error(`the agent did not refund the assistant's request: ${piecesCase?.timeline.find((s) => s.actor === "agent")?.detail}`);
await say("asst2", 1500);

// A cracked vase: outside the rules, so the agent leaves it for the owner.
const filed = Object.fromEntries(await Promise.all(Object.entries(later).map(async ([k, p]) => [k, await p])));
for (const [k, c] of Object.entries(filed)) {
  const d = await settled(c.id);
  log(k, d.claim.status, "|", d.timeline.find((s) => s.actor === "agent")?.detail);
  if (d.timeline.some((s) => /could not review/.test(s.title))) throw new Error(`the photo check failed on the ${k} report; take again`);
}
await openCase(filed.vase.id, "#send-offer, #approve, #request-info");
await glide(".timeline", "start");
const vase1 = say("vase1");
await wait(2500);
await glide(".ai-suggest");
await wait(400);
if (await page.locator(".ai-suggest [data-approve]").count()) {
  await tap(".ai-suggest [data-approve]");
  await page.waitForSelector(".ai-suggest .pill.ok", { timeout: 30_000 });
}
await giveReason("Crack is clear in the photo");
await vase1;
await tap("#send-offer");
await page.waitForSelector("text=Waiting for the buyer", { timeout: 30_000 });
await wait(300);
await go(BASE + filed.vase.statusUrl);
await page.waitForSelector("[data-option]");
const vaseLine = say("vase2");
await wait(900);
const pick = (await page.locator('[data-option^="ai_"]').count()) ? '[data-option^="ai_"]' : '[data-option]:nth-child(2)';
await tap(pick);
await wait(500);
await tap("#confirm");
await page.waitForSelector(".option.chosen", { timeout: 60_000 });
await vaseLine;
await wait(600);

// A different product in the photo: the agent holds back.
await openCase(filed.wrong.id, "#request-info");
const wrong1 = say("wrong1");
await glide(".finding:nth-of-type(4)");
await wrong1;
await glide(".ask-block");
const wrongLine = say("wrong2");
await wait(800);
await tap("#request-info");
await page.waitForSelector("text=You asked the buyer", { timeout: 30_000 });
await wrongLine;
await wait(500);

// ---- Act 4: Stay in control ---------------------------------------------------------------------
await act("4", "Stay in control");
await go(`${BASE}/merchant`);
await page.waitForSelector(".ag-row", { timeout: 30_000 }).catch(() => {});
await wait(500);
if (await page.isVisible("#impact")) await zoom("#impact", 1.25);
await say("inbox", 900);
await zoom(null, 1);
await go(`${BASE}/merchant/agent`);
await page.waitForSelector("#activity:not(.hidden)", { timeout: 30_000 });
await glide("#activity", "start");
const logLine = say("log");
await wait(2600);
if (await page.locator("#off").count()) { await page.locator("#off").scrollIntoViewIfNeeded(); await moveTo(page.locator("#off")); await page.hover("#off"); }
await logLine;

// ---- End card: the refund the buyer saw becomes the mark -----------------------------------------
await setPage(`<style>.e{position:relative}
  .amt{display:inline-block;background:#ffd21f;color:#1f1a00;font-size:84px;font-weight:800;letter-spacing:-.04em;padding:10px 30px;border-radius:12px;animation:p .6s cubic-bezier(.22,1,.36,1) both, out .5s 2.2s forwards}
  .amt small{display:block;font-size:24px;font-weight:600;letter-spacing:0;margin-top:-4px}
  .fin{position:absolute;inset:0;display:grid;place-items:center;opacity:0;animation:r .7s 2.6s cubic-bezier(.22,1,.36,1) forwards}
  .fin h1{font-size:64px;font-weight:800;letter-spacing:-.04em;margin:0 0 12px}
  .fin p{font-size:28px;margin:0 0 26px;color:#171614}.fin u{font-size:20px;color:#5f5b54;text-decoration:none}
  @keyframes out{to{opacity:0;transform:scale(.4)}} @keyframes r{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}</style>
  <div class="e"><div class="amt">$20.00<small>Refund sent</small></div></div>
  <div class="fin"><div><div class="m">${MARK_SVG(40)}</div><h1>Refund Relay</h1><p>Turn a broken order into the next sale.</p><u>refund-relay.onrender.com</u></div></div>`);
await wait(2400);
await say("end", 1500);
await wait(800);

const mainVideo = page.video();
await context.close();
for (const [k, id] of [["chip", chipId], ["pieces", piecesClaim], ...Object.entries(filed).map(([k, c]) => [k, c.id])]) {
  if (!id) continue;
  const d = await merchant(`/claims/${id}`);
  log(k, d.claim.status, JSON.stringify(d.refunds.map((r) => [r.providerRefundId, r.status, r.amountCents])));
}
writeFileSync(`${out}/timeline.json`, JSON.stringify({
  main: { file: await mainVideo.path(), cuts },
  voice: { dir: VOICE, lines: spoken },
  marks,
  chipSeconds,
  popup: { file: await popupInfo.video.path(), open: popupInfo.open, close: popupInfo.close, cut: popupInfo.cut },
}, null, 2));
await browser.close();
log("recorded", out);
