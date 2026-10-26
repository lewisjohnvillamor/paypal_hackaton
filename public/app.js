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
  needs_info: ["Waiting on buyer", "warn"],
  ready: ["To review", "info"],
  offer_sent: ["Buyer choosing", "info"],
  resolved: ["Resolved", "ok"],
  refund_processing: ["Refunding", "warn"],
  refunded: ["Refunded", "ok"],
  closed: ["Closed", ""],
};
export const pill = (status) => {
  const [label, tone] = STATUS[status] || [status, ""];
  return `<span class="pill ${tone}">${esc(label)}</span>`;
};

// SF Symbols-style line icons, inherit currentColor.
const svg = (d, w = 1.8) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.6),
  person: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>'),
  store: svg('<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9v11h16V9"/><path d="M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3"/>'),
  photo: svg('<rect x="3" y="5" width="18" height="15" rx="3"/><circle cx="9" cy="10.5" r="1.8"/><path d="M21 16l-5-5-8 9"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  box: svg('<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 018 0v3"/>'),
  chevron: `<svg class="chev" viewBox="0 0 8 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 1.5l5 5-5 5"/></svg>`,
};
export const checkBadge = (tone = "") => `<div class="check ${tone}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>`;

// Button busy state that keeps the button's width stable.
export function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(label || btn.dataset.label)}`; btn.setAttribute("aria-busy", "true"); }
  else { btn.disabled = false; btn.textContent = btn.dataset.label || label || ""; btn.removeAttribute("aria-busy"); }
}

// Cards fade in on first paint only; later re-renders (polling, actions) stay still.
export const settle = () => setTimeout(() => document.body.classList.add("settled"), 700);

// Private links (claim and status) kept on this device, so a reload or a closed tab does not lose
// them: the server shows each link once and stores only its hash. Storage can be blocked
// (private windows), so every access is guarded and the pages work without it.
const MINE = "rr.orders";
export function myOrders() {
  try { return JSON.parse(localStorage.getItem(MINE)) || []; } catch { return []; }
}
export function rememberOrder(orderId, fields) {
  try {
    const all = myOrders().filter((o) => o.orderId !== orderId);
    const prev = myOrders().find((o) => o.orderId === orderId);
    all.unshift({ ...prev, ...fields, orderId, at: prev?.at ?? new Date().toISOString() });
    localStorage.setItem(MINE, JSON.stringify(all.slice(0, 10)));
  } catch {}
}
// Wording for a resolution option, shared by the buyer's choice and the merchant's case page.
// Remedy titles and items are the merchant's own words from their remedy library.
export function optionText(o) {
  if (o.kind === "refund") return { title: "Full refund", detail: `${usd(o.refundCents)} back to your PayPal account. No need to send anything back.` };
  const item = o.item ? o.item.charAt(0).toUpperCase() + o.item.slice(1) : "";
  return { title: o.title, detail: o.refundCents > 0 ? `${usd(o.refundCents)} back, plus ${o.item}.` : `${item}.` };
}
// Kintsugi kits get the kintsugi picture; anything else a generic icon.
// The amount column: a remedy that refunds nothing says so instead of "$0.00".
export const optionAmount = (o) => (o.refundCents > 0 ? usd(o.refundCents) : "No refund");
export const optionArt = (o) => o.kind === "refund" ? ICON.check : /kintsugi|gold leaf/i.test(`${o.title} ${o.item}`) ? `<img src="/assets/kintsugi.svg" alt="">` : ICON.box;
