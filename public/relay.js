/* Refund Relay button for a store's order page or receipt.
 *
 *   <script src="https://YOUR-REFUND-RELAY/relay.js" defer></script>
 *   <div data-refund-relay data-claim-url="CLAIM_URL_FROM_POST_/v1/orders"></div>
 *
 * Optional attributes: data-label="Report a problem", data-theme="dark".
 * Or from code: RefundRelay.mount(element, { claimUrl, label, theme }).
 * The button lives in a shadow root, so the store's CSS cannot restyle it and its CSS cannot leak
 * into the store. It only ever links to the Refund Relay server this script came from.
 */
(() => {
  const script = document.currentScript;
  const origin = script ? new URL(script.src, location.href).origin : location.origin;

  const css = `
    :host { all: initial; display: inline-block; }
    a { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 16px 0 8px; border-radius: 8px;
        font: 600 15px/1 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: -0.005em;
        text-decoration: none; background: #fff; color: #171614; border: 1px solid #cdc9c1; cursor: pointer;
        transition: background-color .15s ease, border-color .15s ease; }
    a:hover { background: #f3f2ef; border-color: #171614; }
    a:focus-visible { outline: 2px solid #171614; outline-offset: 2px; }
    :host([data-theme="dark"]) a { background: #1b1a19; color: #f1efea; border-color: #44413c; }
    :host([data-theme="dark"]) a:hover { background: #252422; border-color: #f1efea; }
    i { width: 28px; height: 28px; border-radius: 6px; background: #ffd21f; color: #1f1a00; display: grid; place-items: center; flex: none; }
    svg { width: 16px; height: 16px; }
    small { display: block; margin-top: 6px; font: 400 12px/1.4 system-ui, -apple-system, sans-serif; color: #5f5b54; }
    :host([data-theme="dark"]) small { color: #a7a29a; }
  `;
  const icon = '<i aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg></i>';

  function mount(el, { claimUrl, label, theme } = {}) {
    let url;
    try { url = new URL(claimUrl || el.dataset.claimUrl || "", location.href); } catch { url = null; }
    if (!url || url.origin !== origin || url.pathname !== "/claim") {
      console.warn("[Refund Relay] data-claim-url must be the claim_url returned by POST /v1/orders on", origin);
      return null;
    }
    if (theme) el.dataset.theme = theme;
    const root = el.shadowRoot || el.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${css}</style><a part="button" target="_blank" rel="noopener"></a><small part="note">Damaged or broken? Send a photo and the shop will put it right.</small>`;
    const a = root.querySelector("a");
    a.href = url.href;
    a.innerHTML = icon;
    a.append(document.createTextNode(label || el.dataset.label || "Report a problem with this order"));
    return a;
  }

  const scan = () => document.querySelectorAll("[data-refund-relay]").forEach((el) => el.shadowRoot || mount(el));
  window.RefundRelay = { mount, scan };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
