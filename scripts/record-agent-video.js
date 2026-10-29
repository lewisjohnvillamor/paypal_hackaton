// Records the hackathon video (under 3 minutes): the shop's refund agent and the shopper's own
// assistant, on top of the store, the PayPal checkout and the shop's remedies. Captions describe
// what happens in plain words; no model or vendor names appear on screen.
//
// Scenes:
//   1. The owner tells the refund agent the rules in plain English, checks the read-back, turns it on.
//   2. A shopper buys with PayPal, reports a chipped mug, and is refunded by the agent with no click.
//   3. Another shopper's own assistant reports a mug with a snapped handle through the shop's MCP server; the
//      agent refunds it. Both assistants run live; waits for the model and the shop are cut.
//   4. A cracked vase: outside the rules, so the agent leaves it with a reason. The owner adds an
//      in-stock suggestion and the shopper picks it.
//   5. A different product in the photo: the agent holds back, the owner asks for a label photo.
//   6. The agent's log and the inbox.
//
// Needs the app running on a fresh database with REPEAT_CLAIM_LIMIT=0 and the live keys.
// Usage: CHROMIUM_PATH=/opt/pw-browsers/chromium node --env-file=.env scripts/record-agent-video.js [out-dir]
// Then: node scripts/stitch-marketing.js [out-dir]  ->  <out-dir>/refund-relay-marketing.mp4
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { HAIKU_MODEL } from "../src/ai/haiku.js";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const out = process.argv[2] || "data/agent-video";
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
  tee: await buy([{ sku: "TEE-ORGANIC", quantity: 1 }]),
  phones: await buy([{ sku: "HEADPHONES-OVER", quantity: 1 }]),
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
    document.body.appendChild(c);
    const st = document.createElement("style");
    st.textContent = ".demo-note,.kv-row .footnote{display:none!important}";
    document.head.appendChild(st);
    const mk = document.createElement("div");
    mk.id = "__mark";
    mk.style.cssText = "position:fixed;left:0;top:0;width:10px;height:10px;z-index:2147483647;pointer-events:none;background:" + (sessionStorage.getItem("__mark") || "transparent");
    document.body.appendChild(mk);
    const pos = sessionStorage.getItem("__cursor");
    if (pos) c.style.transform = pos;
  });
});
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
    sessionStorage.setItem("__mark", color);
    let mk = document.getElementById("__mark");
    if (!mk) {
      mk = document.createElement("div");
      mk.id = "__mark";
      mk.style.cssText = "position:fixed;left:0;top:0;width:10px;height:10px;z-index:2147483647;pointer-events:none";
      document.body.appendChild(mk);
    }
    mk.style.background = color;
  }, color).catch(() => {});
  await wait(150);
}
// Pages made with setContent get the marker back in the colour it last had.
const remark = () => page.evaluate((color) => {
  const mk = document.createElement("div");
  mk.id = "__mark";
  mk.style.cssText = `position:fixed;left:0;top:0;width:10px;height:10px;z-index:2147483647;pointer-events:none;background:${color}`;
  document.body.appendChild(mk);
}, marks.length ? MARK_COLORS[(marks.length - 1) % 3] : "transparent").catch(() => {});
const cutStart = async () => { await mark(); cutFrom = now(); };
const cutEnd = async () => { await mark(); cuts.push([cutFrom, now()]); cutFrom = null; };

// Each caption is a line of the voiceover: shown on screen and held until the voice clip ends.
// The time each line starts is logged, so the stitcher can lay the voice under the cut video.
const LINES = JSON.parse(readFileSync(process.env.LINES || "scripts/voice/agent-video-lines.json", "utf8"));
const VOICE = process.env.VOICE_DIR || "data/voice";
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
const MARK = `<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg>`;
async function card(title, sub, key) {
  await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700&display=swap">
    <style>body{margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% 40%,#1b2a4a,#05070d);color:#fff;font-family:Inter,system-ui,sans-serif;text-align:center}
    .m{width:64px;height:64px;border-radius:16px;background:linear-gradient(145deg,#0a84ff,#5e5ce6);display:grid;place-items:center;margin:0 auto 26px;animation:p .6s cubic-bezier(.22,1,.36,1) both}
    h1{font-size:60px;letter-spacing:-.04em;margin:0 0 14px;animation:r .7s .1s cubic-bezier(.22,1,.36,1) both}
    p{font-size:25px;color:#b9c3d6;margin:0 auto;letter-spacing:-.01em;max-width:900px;line-height:1.4;animation:r .7s .25s cubic-bezier(.22,1,.36,1) both}
    #__cursor{display:none}@keyframes r{from{opacity:0;transform:translateY(14px)}} @keyframes p{from{opacity:0;transform:scale(.8)}}</style></head>
    <body><div><div class="m">${MARK}</div><h1>${title}</h1><p>${sub}</p></div></body></html>`);
  await remark();
  await wait(600);
  await wait((await voice(key)) + 600);
}
const caseUrl = (id) => `${BASE}/merchant/case?id=${encodeURIComponent(id)}`;
async function openCase(id, settle = ".timeline") {
  await go(caseUrl(id));
  await page.waitForSelector(settle, { timeout: 90_000 });
  await wait(700);
}

// 0. Title
await card("Refund Relay", "The refund agent for stores that take PayPal. Something arrived broken? Snap a photo, and it's put right in seconds.", "title");

// 1. The owner sets the agent's rules in plain English
await go(`${BASE}/merchant/agent`);
await page.waitForSelector("#page:not(.hidden)");
await say("rule1");
await page.fill("#text", "");
await slowType("#text", RULE, 22);
await wait(400);
await tap("#read");
await cutStart();
await page.waitForSelector("#turn-on", { timeout: 60_000 });
await cutEnd();
await glide("#preview", "start");
await say("rule2");
await tap("#turn-on");
await page.waitForSelector("#on:not(.hidden)");
await wait(500);
await glide("#on", "start");
await say("rule3");

// Reports that land once the agent is on: it reads each one after the photo check.
const later = {
  vase: fileClaim(orders.vase, "VASE-GLASS", [PHOTO.vase], "The vase arrived with a long crack down from the rim."),
  wrong: fileClaim(orders.wrong, "MUG-CLASSIC", [PHOTO.wrong], "My mug arrived broken."),
  tee: existsSync(`${DEMO}/7-tee-stained.jpg`) && fileClaim(orders.tee, "TEE-ORGANIC", [`${DEMO}/7-tee-stained.jpg`], "The T-shirt arrived with a brown stain on the front."),
  phones: existsSync(`${DEMO}/8-headphones-cushion-torn.jpg`) && fileClaim(orders.phones, "HEADPHONES-OVER", [`${DEMO}/8-headphones-cushion-torn.jpg`], "One ear cushion is torn open."),
};

// 2. A shopper buys with PayPal and reports a chipped mug; the agent refunds it
const STORE_CART = [{ sku: "MUG-CLASSIC", quantity: 2 }, { sku: "VASE-GLASS", quantity: 1 }];
await go(BASE);
await page.waitForSelector(".tile");
await say("store1");
for (const { sku, quantity } of STORE_CART) for (let i = 0; i < quantity; i++) { await tap(`[data-tile="${sku}"] [data-d="1"]`); await wait(300); }
await page.waitForSelector("#paypal-buttons iframe", { timeout: 30_000 });
await say("store2");
await say("", 300);
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
await say("", 0, popup);
await say("paid", 0, popup);
const closed = popup.waitForEvent("close", { timeout: 90_000 });
await pay.click();
await closed;
const popupInfo = { video: popup.video(), open: popupOpen, close: now(), cut: [loginFrom, loginTo] };
await cutStart(); // PayPal's "return to the shop" overlay while the capture finishes
await page.waitForSelector("#done:not(.hidden)", { timeout: 60_000 });
await wait(300);
await cutEnd();
await wait(600);
await say("report");
await tap("[data-report]");
await page.waitForSelector("#form:not(.hidden)");
await say("chip1");
await slowType("#statement", "One mug has a chip in the rim.");
await moveTo(page.locator("#drop"));
await page.setInputFiles("#photos", PHOTO.chip);
await wait(600);
await tap("#submit");
await page.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });
const chipStatus = await page.getAttribute("#status-link", "href");
const chipId = new URL(BASE + chipStatus).searchParams.get("claim");
await say("chip2");
await go(BASE + chipStatus);
await page.waitForSelector("#card:not(.hidden)");
await cutStart();
await settled(chipId);
await page.reload();
await page.waitForSelector("#card .amount", { timeout: 30_000 });
await wait(800);
await cutEnd();
await say("refunded");
await openCase(chipId);
await glide(".timeline", "start");
await say("case");

// 3. A shopper's own assistant reports a broken mug; the agent refunds it
const MODEL = process.env.ASSISTANT_MODEL || HAIKU_MODEL;
const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
const anthropic = new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
const piecesImg = `data:image/jpeg;base64,${readFileSync(PHOTO.pieces).toString("base64")}`;
await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
  <style>body{margin:0;height:100vh;background:radial-gradient(1200px 700px at 50% 30%,#1b2a4a,#05070d);font-family:Inter,system-ui,sans-serif;display:grid;place-items:center}
  .phone{width:560px;height:700px;background:#f5f5f7;border-radius:34px;box-shadow:0 30px 80px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden}
  .head{padding:22px 24px 14px;border-bottom:1px solid #e3e3e8;display:flex;gap:12px;align-items:center;background:#fff}
  .av{width:38px;height:38px;border-radius:50%;background:linear-gradient(145deg,#ff9f0a,#ff375f);display:grid;place-items:center;color:#fff;font-weight:700}
  .head b{display:block;font-size:17px;letter-spacing:-.01em}.head span{font-size:13px;color:#6e6e73}
  #log{flex:1;overflow:hidden;padding:18px 18px 90px;display:flex;flex-direction:column;gap:10px;justify-content:flex-end}
  .msg{max-width:82%;padding:11px 15px;border-radius:20px;font-size:16px;line-height:1.4;animation:in .35s cubic-bezier(.22,1,.36,1) both;white-space:pre-wrap}
  .me{align-self:flex-end;background:#0a84ff;color:#fff;border-bottom-right-radius:6px}
  .bot{align-self:flex-start;background:#fff;color:#1d1d1f;border-bottom-left-radius:6px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
  .me img{display:block;width:150px;border-radius:12px;margin-top:8px}
  .link{display:inline-block;margin-top:8px;padding:6px 10px;border-radius:10px;background:rgba(255,255,255,.2);font-size:14px}
  .step{align-self:flex-start;font-size:13.5px;color:#6e6e73;display:flex;gap:8px;align-items:center;padding:2px 6px;animation:in .3s ease both}
  .step i{width:8px;height:8px;border-radius:50%;background:#30d158;flex:none}.step.wait i{background:#ff9f0a;animation:pulse 1s infinite}
  @keyframes in{from{opacity:0;transform:translateY(8px)}} @keyframes pulse{50%{opacity:.3}}</style></head>
  <body><div class="phone"><div class="head"><div class="av">✦</div><div><b>My assistant</b><span>Can use: my Juniper Market order link</span></div></div><div id="log"></div></div></body></html>`);
await remark();
const add = (cls, html) => page.evaluate(([cls, html]) => {
  const log = document.getElementById("log");
  const el = document.createElement("div");
  el.className = cls;
  el.innerHTML = html;
  log.appendChild(el);
  while (log.scrollHeight > log.clientHeight && log.children.length > 1) log.firstElementChild.remove();
}, [cls, html]);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
await wait(600);
await say("asst0");
await add("msg me", `The handle snapped off one of my four Juniper Market mugs. Can you sort it out?<br><span class="link">🔗 Juniper Market order link</span><img src="${piecesImg}">`);
await wait(1800);
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
        await wait(900);
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
await say("asst1");
await say("asst2");

// 4. A cracked vase: outside the rules, so the agent leaves it for the owner
const filed = Object.fromEntries(await Promise.all(Object.entries(later).filter(([, p]) => p).map(async ([k, p]) => [k, await p])));
for (const [k, c] of Object.entries(filed)) {
  const d = await settled(c.id);
  log(k, d.claim.status, "|", d.timeline.find((s) => s.actor === "agent")?.detail);
}
await openCase(filed.vase.id, "#send-offer, #approve, #request-info");
await glide(".timeline", "start");
await say("vase1");
await glide(".ai-suggest");
await say("vase2");
if (await page.locator(".ai-suggest [data-approve]").count()) {
  await tap(".ai-suggest [data-approve]");
  await page.waitForSelector(".ai-suggest .pill.ok", { timeout: 30_000 });
}
await giveReason("Crack is clear in the photo");
await tap("#send-offer");
await page.waitForSelector("text=Waiting for the buyer", { timeout: 30_000 });
await say("vase3");
await go(BASE + filed.vase.statusUrl);
await page.waitForSelector("[data-option]");
await say("vase4");
const pick = (await page.locator('[data-option^="ai_"]').count()) ? '[data-option^="ai_"]' : '[data-option]:nth-child(2)';
await tap(pick);
await say("vase5");
await tap("#confirm");
await page.waitForSelector(".option.chosen", { timeout: 60_000 });
await wait(2200);

// 5. A different product in the photo: the agent holds back
await openCase(filed.wrong.id, "#request-info");
await glide(".finding:nth-of-type(4)");
await say("wrong1");
await glide(".ask-block");
await say("wrong2");
await tap("#request-info");
await page.waitForSelector("text=You asked the buyer", { timeout: 30_000 });
await wait(800);

// 6. The agent's log and the inbox
await go(`${BASE}/merchant/agent`);
await page.waitForSelector("#activity:not(.hidden)", { timeout: 30_000 });
await glide("#activity", "start");
await say("log");
await go(`${BASE}/merchant`);
await page.waitForSelector(".ag-row", { timeout: 30_000 }).catch(() => {});
await wait(600);
await say("inbox");

await card("Turn a broken order into the next sale.", "Refund Relay · built on PayPal", "end");

const mainVideo = page.video();
await context.close();
const piecesId = piecesStatus && new URL(BASE + piecesStatus).searchParams.get("claim");
for (const [k, id] of [["chip", chipId], ["pieces", piecesId], ...Object.entries(filed).map(([k, c]) => [k, c.id])]) {
  if (!id) continue;
  const d = await merchant(`/claims/${id}`);
  log(k, d.claim.status, JSON.stringify(d.refunds.map((r) => [r.providerRefundId, r.status, r.amountCents])));
}
writeFileSync(`${out}/timeline.json`, JSON.stringify({
  main: { file: await mainVideo.path(), cuts },
  voice: { dir: VOICE, lines: spoken },
  marks,
  popup: { file: await popupInfo.video.path(), open: popupInfo.open, close: popupInfo.close, cut: popupInfo.cut },
}, null, 2));
await browser.close();
log("recorded", out);
