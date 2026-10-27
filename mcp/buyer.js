// Refund Relay for shoppers' AI assistants: an MCP server a buyer adds to their own assistant
// (Claude Desktop, Cursor, any MCP host) so it can report a damaged item, send the photos, follow
// the request, and pick how it is put right, all on the buyer's behalf. On the other side, the
// shop's refund agent decides under the merchant's rules and PayPal moves the money.
//
// It holds no secrets. The buyer hands their assistant the private claim link the shop gave them
// after checkout; that link is the only permission it has, exactly as in the browser. The buyer's
// words go to the shop as they are and are never shown to an AI model there.
//
// Each link names its own shop, so the server needs no configuration:   node mcp/buyer.js
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const SETTLED = ["offer_sent", "resolved", "needs_info", "refunded", "closed"];

// A claim or status link: the page URL with the token after "#t=". The link names its own shop.
function parseLink(link, param) {
  let u;
  try { u = new URL(String(link)); } catch { throw new Error("Paste the whole link the shop sent, starting with https://"); }
  const id = u.searchParams.get(param);
  const token = new URLSearchParams(u.hash.slice(1)).get("t");
  if (!id || !token) throw new Error(`That doesn't look like the shop's ${param === "order" ? "claim" : "status"} link.`);
  return { base: u.origin, id, token };
}

async function call(base, path, { method = "GET", token, body, form } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "X-Claim-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `The shop answered ${res.status}`);
  return data;
}

async function photoForm(paths) {
  if (!paths?.length) throw new Error("Add at least one photo of the damage (a path to an image file).");
  const form = new FormData();
  for (const p of paths) form.append("photos", new Blob([await readFile(p)], { type: "image/jpeg" }), basename(p));
  return form;
}

// What the assistant reads back to the buyer: plain facts, the shop's own wording.
function statusText(s, statusLink) {
  const lines = [`Request ${s.ref} for ${s.quantity} × ${s.item}: ${s.message}`];
  if (s.refund) lines.push(`Refund: ${usd(s.refund.amountCents)} through PayPal, ${s.refund.state}${s.refund.refundId ? ` (PayPal refund ${s.refund.refundId})` : ""}.`);
  if (s.infoRequest) lines.push(`The shop asks: "${s.infoRequest}". Send more photos with add_photos.`);
  if (s.closeReason) lines.push(`The shop's reason: ${s.closeReason}`);
  if (s.offer?.open) {
    lines.push("The shop offers these choices (pick one with choose_option, after asking the buyer):");
    for (const o of s.offer.options) lines.push(`- ${o.id}: ${o.kind === "refund" ? `Full refund, ${usd(o.refundCents)} back` : `${o.title}: ${o.refundCents ? `${usd(o.refundCents)} back, plus ` : ""}${o.item ?? ""}`}`);
  } else if (s.offer?.chosen) lines.push(`Chosen: ${s.offer.options.find((o) => o.id === s.offer.chosen)?.title ?? s.offer.chosen}.`);
  if (statusLink) lines.push(`Status link: ${statusLink}`);
  return lines.join("\n");
}

const text = (t) => ({ content: [{ type: "text", text: t }] });

export function buyerServer() {
  const server = new McpServer({ name: "refund-relay-buyer", version: "0.1.0" }, {
    instructions: "Tools for reporting a damaged item from an online order to the shop that sold it, and following the request until it is refunded or put right. You need the private claim link the shop sent after checkout. Always describe the problem in the buyer's own words, never promise an outcome, and ask the buyer before choosing an option for them.",
  });

  server.registerTool("get_order", {
    title: "Look up the order",
    description: "Read the order behind a claim link: the items, quantities and prices paid, and whether a request is already open. Call this first to find the item id for report_damage.",
    inputSchema: { claim_link: z.string().describe("The private claim link the shop sent after checkout (https://.../claim?order=...#t=...)") },
    annotations: { readOnlyHint: true },
  }, async ({ claim_link }) => {
    const { base, id, token } = parseLink(claim_link, "order");
    const o = await call(base, `/api/claim-link/${encodeURIComponent(id)}`, { token });
    return text([
      `Order paid with PayPal: ${usd(o.amountCents)}.`,
      ...o.lines.map((l) => `- item ${l.id}: ${l.title}, ${l.quantity} × ${usd(l.unit_cents)}`),
      o.openClaimRef ? `A request is already open on this order: ${o.openClaimRef}.` : "No request is open on this order.",
    ].join("\n"));
  });

  server.registerTool("report_damage", {
    title: "Report a damaged item",
    description: "File a damage report with the shop for one item on the order, with photos of the damage. The shop's refund agent reviews it, usually within a minute. Returns the request number and a status link to follow it with check_request.",
    inputSchema: {
      claim_link: z.string().describe("The private claim link from checkout"),
      item_id: z.string().describe("The item id from get_order"),
      quantity: z.number().int().min(1).default(1).describe("How many of that item are damaged"),
      description: z.string().min(5).max(1000).describe("What happened, in the buyer's own words"),
      photo_paths: z.array(z.string()).min(1).max(20).describe("Paths to photos of the damage on this computer"),
    },
  }, async ({ claim_link, item_id, quantity, description, photo_paths }) => {
    const { base, id, token } = parseLink(claim_link, "order");
    const form = await photoForm(photo_paths);
    form.set("orderId", id);
    form.set("lineId", item_id);
    form.set("quantity", String(quantity));
    form.set("statement", description);
    const r = await call(base, "/api/claims", { method: "POST", token, form });
    const statusLink = base + r.statusUrl;
    return text(`Reported. Request ${r.ref}. The shop is checking the photos now; call check_request with wait_seconds to hear back.\nStatus link (keep it; it is the buyer's private link): ${statusLink}`);
  });

  server.registerTool("check_request", {
    title: "Check on a request",
    description: "Read where a damage report stands: being reviewed, refunded (with the PayPal refund id), choices to pick from, or more photos needed. wait_seconds waits for the shop's next decision instead of returning at once.",
    inputSchema: {
      status_link: z.string().describe("The status link report_damage returned"),
      wait_seconds: z.number().int().min(0).max(90).default(0).describe("Wait up to this long for the shop to decide"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ status_link, wait_seconds }) => {
    const { base, id, token } = parseLink(status_link, "claim");
    const until = Date.now() + wait_seconds * 1000;
    let s;
    for (;;) {
      s = await call(base, `/api/claims/${encodeURIComponent(id)}/status`, { token });
      const done = SETTLED.includes(s.status) && !(s.status === "refunded" && s.refund?.state !== "issued");
      if (done || Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return text(statusText(s, status_link));
  });

  server.registerTool("choose_option", {
    title: "Pick how it is put right",
    description: "When the shop offers choices (a full refund, a repair kit with part of the money back, a replacement), pick the one the buyer chose. Ask the buyer first. Any refund goes back through PayPal at once.",
    inputSchema: {
      status_link: z.string().describe("The status link report_damage returned"),
      option_id: z.string().describe("The id of the option, as check_request lists it"),
    },
  }, async ({ status_link, option_id }) => {
    const { base, id, token } = parseLink(status_link, "claim");
    const s = await call(base, `/api/claims/${encodeURIComponent(id)}/status`, { token });
    if (!s.offer?.open) throw new Error("There are no open choices on this request.");
    const after = await call(base, `/api/claims/${encodeURIComponent(id)}/choose`, { method: "POST", token, body: { offerId: s.offer.id, optionId: option_id } });
    return text(statusText(after, status_link));
  });

  server.registerTool("add_photos", {
    title: "Send more photos",
    description: "Send more photos when the shop asked for them (check_request says so).",
    inputSchema: { status_link: z.string(), photo_paths: z.array(z.string()).min(1).max(20) },
  }, async ({ status_link, photo_paths }) => {
    const { base, id, token } = parseLink(status_link, "claim");
    const s = await call(base, `/api/claims/${encodeURIComponent(id)}/evidence`, { method: "POST", token, form: await photoForm(photo_paths) });
    return text(statusText(s, status_link));
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buyerServer().connect(new StdioServerTransport());
}
