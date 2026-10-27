// Agent-to-agent commerce on PayPal, end to end and live:
//   1. The merchant turns on a refund rule in plain English (through the shop's API).
//   2. The buyer pays for four mugs with PayPal (sandbox checkout in a real browser: the one step
//      only a person can take).
//   3. The buyer asks their own AI assistant to sort out a chipped mug. The assistant has only the
//      Refund Relay buyer MCP server (mcp/buyer.js) and the private claim link. It files the report
//      with the photo and waits for the shop.
//   4. The shop's refund agent checks the photo, finds the case inside the merchant's rule, and
//      refunds it through PayPal. No person on the shop's side clicks anything.
//   5. The merchant asks their own assistant what happened. It has the Refund Relay merchant MCP
//      server (mcp/merchant.js), which carries the PayPal Agent Toolkit's read-only tools, and
//      confirms the refund against PayPal's own record.
// Both assistants are a language model calling MCP tools in a loop; nothing they do is scripted.
//
// Needs the app running (npm start, REPEAT_CLAIM_LIMIT=0), the sandbox buyer and an Anthropic key in .env:
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node --env-file=.env scripts/agent-to-agent.js [photo.jpg]
// Writes the conversation to hackathon/AGENT_TO_AGENT_RUN.md (TRANSCRIPT=... to change).
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sandboxBuy } from "./lib/sandbox-buy.js";
import { HAIKU_MODEL } from "../src/ai/haiku.js";

const BASE = process.env.APP_BASE_URL || "http://localhost:8888";
const PHOTO = resolve(process.argv[2] || "demo-photos/1-kit-chipped-mug.jpg");
const RULE = process.env.AGENT_RULE || "Refund chipped mugs under $25 on your own. Ask me about anything above that.";
const OUT = process.env.TRANSCRIPT || "hackathon/AGENT_TO_AGENT_RUN.md";
const MODEL = process.env.ASSISTANT_MODEL || HAIKU_MODEL;
const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
const anthropic = new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});

const md = [`# Agent-to-agent run, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, ""];
// Sandbox account emails are half a sign-in; keep them out of the transcript.
const redact = (s) => s.replace(/sb-[\w.-]+@[\w.-]+/g, "sb-…@….example.com");
const say = (who, raw) => { const line = redact(raw); console.log(`\n[${who}] ${line}`); md.push(`**${who}:** ${line.replace(/\n/g, "  \n")}`, ""); };

// One assistant: a model, a system prompt, and the tools of one MCP server, in a loop until it answers.
async function assistant({ who, user, server, env, system, ask }) {
  say(user, ask.replace(/#t=[\w-]+/g, "#t=…"));
  const client = new Client({ name: who, version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, ...env }, stderr: "inherit" }));
  const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  say(who, `(connected to ${server}: ${tools.map((t) => t.name).join(", ")})`);
  const messages = [{ role: "user", content: ask }];
  try {
    for (let turn = 0; turn < 12; turn++) {
      const res = await anthropic.messages.create({ model: MODEL, max_tokens: 2000, system, tools, messages });
      messages.push({ role: "assistant", content: res.content });
      for (const b of res.content) if (b.type === "text" && b.text.trim()) say(who, b.text.trim());
      const calls = res.content.filter((b) => b.type === "tool_use");
      if (!calls.length) return;
      const results = [];
      for (const c of calls) {
        say(who, `→ ${c.name}(${JSON.stringify(c.input).replace(/"claim_link":"[^"]+"|"status_link":"[^"]+"/g, (m) => m.replace(/#t=[^"]+/, "#t=…"))})`);
        const r = await client.callTool({ name: c.name, arguments: c.input });
        const out = r.content.map((x) => x.text).join("\n");
        say(`${c.name} answered`, (out.length > 900 ? `${out.slice(0, 900)}…` : out).replace(/#t=[\w-]+/g, "#t=…"));
        results.push({ type: "tool_result", tool_use_id: c.id, content: out, is_error: !!r.isError });
      }
      messages.push({ role: "user", content: results });
    }
  } finally {
    await client.close();
  }
}

// 1. The merchant's rule.
const login = await fetch(`${BASE}/api/merchant/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: process.env.MERCHANT_PASSWORD }) });
if (!login.ok) throw new Error("merchant login failed");
const cookie = login.headers.get("set-cookie").split(";")[0];
const merchantApi = async (path, body) => {
  const r = await fetch(`${BASE}/api/merchant${path}`, { method: body ? "POST" : "GET", headers: { Cookie: cookie, "X-Refund-Relay": "1", "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message);
  return data;
};
const preview = await merchantApi("/agent/preview", { text: RULE });
await merchantApi("/agent", { text: RULE, rules: { rules: preview.rules, dailyLimitCents: preview.dailyLimitCents } });
md.push("## 1. The merchant's rule", "", `> ${RULE}`, "", "Read back and turned on:", "", ...preview.readback.map((l) => `- ${l}`), "");
console.log("rule on:", preview.readback[0]);

// 2. The buyer pays with PayPal.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const bought = await sandboxBuy(await browser.newPage(), BASE, [{ sku: "MUG-CLASSIC", quantity: 4 }]);
await browser.close();
md.push("## 2. The buyer pays with PayPal", "", `Four mugs, $80.00, PayPal sandbox order \`${bought.paypalOrderId}\`, capture \`${bought.captureId}\`.`, "");
console.log("paid:", bought.paypalOrderId, bought.captureId);

// 3 and 4. The buyer's assistant files the claim; the shop's refund agent decides.
md.push("## 3. The buyer's assistant files the claim, and the shop's refund agent decides", "");
await assistant({
  who: "Buyer's assistant",
  user: "Buyer",
  server: "mcp/buyer.js",
  system: "You are a personal shopping assistant acting for your user with online shops. Use the tools to deal with the shop. Be brief. Do not ask the user questions you can answer with the tools; when the shop offers choices, pick the full refund unless the user said otherwise.",
  ask: `Ugh, my Juniper Market order came today and one of the four mugs has a chip on the rim. Here's the link they sent me after I paid: ${bought.claimLink}\nPhoto of the chip: ${PHOTO}\nCan you sort it out and tell me when the money's back?`,
});

// 5. The merchant's assistant checks it against PayPal.
md.push("## 4. The merchant's assistant checks it against PayPal", "");
await assistant({
  who: "Merchant's assistant",
  user: "Merchant",
  server: "mcp/merchant.js",
  env: { REFUND_RELAY_URL: BASE },
  system: "You are the shop owner's assistant for Juniper Market. Use the tools. Be brief and concrete: name request numbers, amounts and PayPal ids.",
  ask: "Did my refund agent refund anything on its own just now? Check it against PayPal's own records and tell me if anything looks off.",
});

writeFileSync(OUT, md.join("\n"));
console.log(`\nTranscript: ${OUT}`);
