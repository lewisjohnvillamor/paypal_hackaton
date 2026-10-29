// Live run of the refund policy against the PayPal sandbox and the real photo check: each request
// should land in exactly one of auto-refund, manual review or no refund, and the agent should only
// move money on the first. Five requests, paid by the sandbox buyer in a real browser:
//   1. scuffed $120 headphones   -> partial refund ($24.00, cosmetic damage at 20%), sent by the agent
//   2. chipped $20 mug           -> full refund ($20.00), sent by the agent
//   3. snapped $120 headphones   -> manual review: $120.00 is over the $50.00 automatic limit
//   4. a mug reported 30 days after delivery -> closed by the agent, no PayPal call
//   5. with the daily limit lowered to $50, a mug with a snapped handle -> manual review
// Needs the app running (npm start) with REPEAT_CLAIM_LIMIT=0, a fresh DATABASE_PATH, and the
// sandbox buyer in .env. The script reads the same database file to backdate one delivery (the
// demo store's delivery date is a synthetic fixture), and asks PayPal for every refund it made.
// Usage: node --env-file=.env scripts/e2e-policy.js
import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { sandboxBuy } from "./lib/sandbox-buy.js";
import * as paypal from "../src/paypal/client.js";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const cookie = async () => (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
const merchant = async (method, path, body) => {
  const res = await fetch(`${BASE}/api/merchant${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { Cookie: await cookie(), "X-Refund-Relay": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
};

await page.goto(`${BASE}/merchant/`);
await page.waitForSelector("#login:not(.hidden)");
await page.fill("#password", process.env.MERCHANT_PASSWORD);
await page.click("#login button[type=submit]");
await page.waitForSelector("#inbox:not(.hidden)");
// The agent may refund any product with any damage up to $200 a request; the policy is what holds it back.
await merchant("POST", "/agent", { text: "Refund any damage up to $200 on your own; up to $300 a day.",
  rules: { rules: [{ skus: [], damage: [], maxRefundCents: 20000, action: "refund" }], dailyLimitCents: 30000 } });
await merchant("PUT", "/policy", (await merchant("GET", "/policy")).defaults);

async function report(sku, photo, statement, before) {
  const { claimUrl } = await sandboxBuy(page, BASE, [{ sku, quantity: 1 }]);
  const orderId = new URL(BASE + claimUrl).searchParams.get("order");
  before?.(orderId);
  await page.goto(BASE + claimUrl);
  await page.waitForSelector("#form:not(.hidden)");
  await page.fill("#statement", statement);
  await page.setInputFiles("#photos", photo);
  await page.click("#submit");
  await page.waitForSelector("#sent:not(.hidden)", { timeout: 60_000 });
  const claimId = new URL(BASE + await page.getAttribute("#status-link", "href")).searchParams.get("claim");
  for (let i = 0; i < 60; i++) {
    const d = await merchant("GET", `/claims/${claimId}`);
    if (!["new", "refund_processing"].includes(d.claim.status) && d.timeline.some((s) => s.actor === "agent")) return d;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`claim ${claimId} did not settle`);
}

const results = [];
async function run(label, expect, sku, photo, statement, before) {
  const d = await report(sku, photo, statement, before);
  const f = d.assessment?.findings;
  const refund = d.refunds.at(-1);
  let paypalSays = null;
  if (refund?.providerRefundId) {
    const r = await paypal.getRefund(refund.providerRefundId);
    paypalSays = `${r.body.status} ${r.body.amount?.value}`;
  }
  const row = {
    label, expect, route: d.proposal.route, decidedBy: d.proposal.decidedBy, amount: d.proposal.amountCents, status: d.claim.status,
    damage: f && `${f.damage_kind} ${f.signals?.damage_kind?.confidence?.toFixed(2)} seen ${f.signals?.visible_breakage?.toFixed(2)}`,
    refundId: refund?.providerRefundId ?? null, paypal: paypalSays,
    agent: d.timeline.filter((s) => s.actor === "agent").map((s) => s.title + (s.detail ? `: ${s.detail}` : "")).join(" | "),
  };
  results.push(row);
  log(JSON.stringify(row));
}

await run("scuffed headphones", "auto_refund $24.00", "HEADPHONES-OVER", "demo-photos/9-headphones-scuffed.jpg", "Arrived with scuffs and scratches all over the ear cups.");
await run("chipped mug", "auto_refund $20.00", "MUG-CLASSIC", "demo-photos/1-kit-chipped-mug.jpg", "The rim of my mug arrived chipped.");
await run("snapped headphones", "manual_review OVER_AUTO_REFUND_LIMIT", "HEADPHONES-OVER", "demo-photos/10-headphones-headband-snapped.jpg", "The headband snapped in the box.");
await run("late report", "reject OUTSIDE_CLAIM_WINDOW, closed by the agent", "MUG-CLASSIC", "demo-photos/5-mug-in-pieces.jpg", "The mug was in pieces when I opened it.", (orderId) => {
  const db = new DatabaseSync(process.env.DATABASE_PATH);
  db.prepare("UPDATE orders SET delivered_at = ? WHERE id = ?").run(new Date(Date.now() - 30 * 86400e3).toISOString(), orderId);
  db.close();
});
const tight = await merchant("PUT", "/policy", { ...(await merchant("GET", "/policy")).policy, dailyAutoRefundCents: 5000 });
log("daily limit now", tight.policy.dailyAutoRefundCents, "spent", tight.spentCents);
await run("over the daily limit", "manual_review DAILY_AUTO_LIMIT_REACHED", "MUG-CLASSIC", "demo-photos/4b-clear-mug-handle-off.jpg", "The handle came off in transit.");

console.log("\nRESULTS");
console.table(results.map(({ label, expect, route, decidedBy, amount, status, refundId, paypal: p }) => ({ label, expect, got: `${route} ${decidedBy} $${(amount / 100).toFixed(2)}`, status, refundId, paypal: p })));
await browser.close();
