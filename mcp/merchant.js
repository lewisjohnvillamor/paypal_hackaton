// Refund Relay for the merchant's own AI assistant: an MCP server that lets it read the refund
// requests, what the refund agent did and why, and the agent's rules, and check any of it against
// PayPal's own records with the PayPal Agent Toolkit (orders, refunds, disputes, transactions).
//
// It moves no money. Refund Relay's refund gate stays the only path to a refund: the merchant's
// click, or the refund agent acting on rules the merchant turned on. So the PayPal Agent Toolkit
// is loaded with read-only actions only; create_refund and the other write tools are never
// registered here.
//
//   REFUND_RELAY_URL=http://localhost:8888 MERCHANT_PASSWORD=... PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node mcp/merchant.js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PayPalMCPToolkit } from "@paypal/agent-toolkit/mcp";
import { z } from "zod";

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 1) }] });

// PayPal Agent Toolkit actions this server allows: lookups only.
export const PAYPAL_READ_ONLY = {
  orders: { get: true },
  payments: { getRefunds: true },
  disputes: { list: true, get: true },
  transactions: { list: true },
};

// A signed-in session with the shop's merchant console, renewed when it lapses.
function shop(base, password) {
  let cookie = null;
  const login = async () => {
    const res = await fetch(`${base}/api/merchant/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (!res.ok) throw new Error("The shop refused the merchant password.");
    cookie = res.headers.get("set-cookie").split(";")[0];
  };
  return async function get(path, { method = "GET", body } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (!cookie) await login();
      const res = await fetch(`${base}/api/merchant${path}`, {
        method, body: body ? JSON.stringify(body) : undefined,
        headers: { Cookie: cookie, "X-Refund-Relay": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
      });
      if (res.status === 401 && attempt === 0) { cookie = null; continue; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `The shop answered ${res.status}`);
      return data;
    }
  };
}

// PayPal sandbox token for the Agent Toolkit, cached until shortly before it expires.
function paypalToken({ clientId, clientSecret }) {
  let cached = null;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64") },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error("PayPal sign-in failed; check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
    cached = { token: body.access_token, until: Date.now() + (body.expires_in - 120) * 1000 };
    return cached.token;
  };
}

function requestSummary(d) {
  const agent = [...d.timeline].reverse().find((s) => s.actor === "agent");
  const f = d.assessment?.findings;
  return {
    ref: d.claim.ref, id: d.claim.id, status: d.claim.status, item: `${d.claim.quantity} × ${d.line.title}`, paid_each: usd(d.line.unitCents),
    buyer_said: d.claim.statement,
    photo_check: f ? { damage_visible: f.visible_breakage, damage_type: f.damage_kind, same_product: f.product_consistency, photos_usable: f.evidence_usable } : (d.assessment?.error ?? "not yet"),
    policy: d.proposal && { route: d.proposal.route, amount: usd(d.proposal.amountCents), why: d.proposal.decidedByText, concerns: Object.values(d.proposal.reasonText ?? {}) },
    refund_agent: agent ? `${agent.title}: ${agent.detail}` : "no rules on, or not reviewed yet",
    refunds: d.refunds.map((r) => ({ paypal_refund_id: r.providerRefundId, status: r.status, amount: usd(r.amountCents) })),
    paypal: { order_id: d.payment.paypalOrderId, capture_id: d.payment.captureId, refundable_now: usd(d.payment.refundableCents) },
    timeline: d.timeline.map((s) => `${s.actor}: ${s.title}${s.detail ? ` (${s.detail})` : ""}`),
  };
}

export function merchantServer({ base, password, paypal }) {
  const get = shop(base, password);
  const server = new McpServer({ name: "refund-relay-merchant", version: "0.1.0" }, {
    instructions: "Tools for a shop owner's assistant: read damage reports and refunds, see what the shop's refund agent did and why, and check them against PayPal's own records. These tools never refund; refunds happen in Refund Relay, by the owner or by the refund agent under the owner's rules.",
  });

  server.registerTool("list_requests", {
    title: "List refund requests",
    description: "The shop's latest damage reports, newest first, with status, what the photo check saw, the amount refunded, and what the refund agent did.",
    inputSchema: { status: z.enum(["new", "ready", "needs_info", "offer_sent", "refund_processing", "refunded", "resolved", "closed"]).optional(), limit: z.number().int().min(1).max(50).default(20) },
    annotations: { readOnlyHint: true },
  }, async ({ status, limit }) => {
    const rows = (await get("/claims?limit=200")).filter((r) => !status || r.status === status).slice(0, limit);
    return text(rows.map((r) => ({
      ref: r.ref, id: r.id, status: r.status, item: `${r.quantity} × ${r.title}`, damage_type: r.damage_kind,
      drafted: r.proposed_cents ? usd(r.proposed_cents) : null, refunded: r.refunded_cents ? usd(r.refunded_cents) : null,
      refund_agent: r.agent ? `${r.agent === "acted" ? "acted" : "left it for you"}: ${r.agent_why ?? ""}` : null, reported: r.created_at,
    })));
  });

  server.registerTool("get_request", {
    title: "Read one request",
    description: "Everything on one damage report: the buyer's words, the photo check, the refund policy's draft and concerns, the refund agent's decision and why, PayPal refund ids, and the full timeline.",
    inputSchema: { request: z.string().describe("The request number (RR-...) or id") },
    annotations: { readOnlyHint: true },
  }, async ({ request }) => {
    let id = request;
    if (/^RR-/i.test(request)) {
      const row = (await get("/claims?limit=500")).find((r) => r.ref.toUpperCase() === request.toUpperCase());
      if (!row) throw new Error(`No request ${request}.`);
      id = row.id;
    }
    return text(requestSummary(await get(`/claims/${encodeURIComponent(id)}`)));
  });

  server.registerTool("get_agent_rules", {
    title: "Read the refund agent's rules",
    description: "The rules the shop's refund agent follows (as the owner approved them), what it sent in the last 24 hours, and its latest decisions.",
    annotations: { readOnlyHint: true },
  }, async () => {
    const a = await get("/agent");
    return text({
      on: !!a.mandate, owner_wrote: a.mandate?.text ?? null, rules: a.mandate?.readback ?? [],
      // The agent stops at the lower of its rules' daily limit and the refund policy's.
      sent_last_24h: usd(a.spentCents), daily_limit: a.mandate ? usd(Math.min(a.mandate.dailyLimitCents, a.policyDailyCents ?? Infinity)) : null,
      latest: a.recent.slice(0, 10).map((x) => `${x.ref} ${x.title}: ${x.acted ? x.act : "left for owner"} (${x.why})`),
    });
  });

  server.registerTool("preview_agent_rules", {
    title: "Preview new rules",
    description: "Read plain-English rules back as the refund agent would follow them, and what they would have done on recent requests. Nothing is turned on; the owner turns rules on in Refund Relay.",
    inputSchema: { text: z.string().min(8).max(1000) },
    annotations: { readOnlyHint: true },
  }, async ({ text: words }) => {
    const p = await get("/agent/preview", { method: "POST", body: { text: words } });
    return text({ rules: p.readback, not_understood: p.notUnderstood, would_have: p.replay.map((x) => `${x.ref} ${x.title} ${usd(x.amountCents)}: ${x.act ?? "left for owner"} (${x.why})`) });
  });

  // PayPal's own records, through the PayPal Agent Toolkit, read-only.
  if (paypal?.clientId && paypal?.clientSecret) {
    const token = paypalToken(paypal);
    const configuration = { actions: PAYPAL_READ_ONLY, context: { sandbox: true } };
    const tools = new PayPalMCPToolkit({ accessToken: "unused", configuration }).getTools();
    for (const tool of tools) {
      server.registerTool(tool.method, {
        title: `PayPal: ${tool.name}`,
        description: `${tool.description}\n(PayPal Agent Toolkit, sandbox, read-only.)`,
        inputSchema: tool.parameters.shape,
        annotations: { readOnlyHint: true },
      }, async (args) => {
        const api = new PayPalMCPToolkit({ accessToken: await token(), configuration }).getPaypalAPIService();
        return text(String(await api.run(tool.method, args)));
      });
    }
  }
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { REFUND_RELAY_URL: base = "http://localhost:8888", MERCHANT_PASSWORD: password, PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
  if (!password) throw new Error("Set MERCHANT_PASSWORD");
  await merchantServer({ base, password, paypal: { clientId, clientSecret } }).connect(new StdioServerTransport());
}
