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
    a { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 20px; border-radius: 980px;
        font: 600 15px/1 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif; letter-spacing: -0.01em;
        text-decoration: none; background: #fff; color: #0060c0; border: 1px solid #d2d2d7; cursor: pointer;
        transition: background-color .15s ease, border-color .15s ease; }
    a:hover { background: #f5f5f7; border-color: #b8b8bd; }
    a:focus-visible { outline: 3px solid rgb(0 113 227 / .45); outline-offset: 2px; }
    :host([data-theme="dark"]) a { background: #1c1c1e; color: #4da3ff; border-color: #3a3a3c; }
    :host([data-theme="dark"]) a:hover { background: #2c2c2e; }
    svg { width: 18px; height: 18px; flex: none; }
    small { display: block; margin-top: 6px; font: 400 12px/1.4 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; color: #636366; }
    :host([data-theme="dark"]) small { color: #98989d; }
  `;
  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg>';

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
