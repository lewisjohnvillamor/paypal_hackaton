// Shared browser helpers.
export const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

export async function api(path, { method = "GET", body, form, token, merchant } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["X-Claim-Token"] = token;
  if (merchant && method !== "GET") headers["X-Refund-Relay"] = "1";
  const res = await fetch(path, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined), credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

export const hashToken = () => new URLSearchParams(location.hash.slice(1)).get("t");

export const STATUS = {
  new: ["New", "info"],
  needs_info: ["Needs information", "warn"],
  ready: ["Ready for review", "info"],
  refund_processing: ["Refund processing", "warn"],
  refunded: ["Refunded", "ok"],
  closed: ["Closed", ""],
};
export const pill = (status) => {
  const [label, tone] = STATUS[status] || [status, ""];
  return `<span class="pill ${tone}">${esc(label)}</span>`;
};
