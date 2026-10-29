# Design notes

Goal: buyer, merchant and tracking screens that feel like one Apple-quality product, and read clearly in a 3-minute demo video.

## Critique of the previous UI (2026-10-22)

| Finding | Severity | Fix |
|---|---|---|
| Warm beige background, uppercase eyebrows and uppercase status pills read as a generic admin dashboard. | Moderate | Apple grouped-background palette (#f5f5f7 / white cards), sentence-case labels, tinted badges. |
| No success moment. A $20 refund, the climax of the demo, was a small table row. | Critical for the video | Hero result: animated check, 56px amount, plain-language headline on both the merchant and buyer screens. |
| Claim form used the browser's raw file input and a number field for quantity. | Moderate | Photo drop zone with thumbnails, iOS-style stepper, one full-width primary action. |
| Merchant history showed raw event names (`claim.submitted`). | Moderate | Human sentences ("Jev reviewed the photos") with actor-coloured dots. |
| Inbox rows were clickable `<tr>`s (mouse only) and filters were plain buttons. | Moderate (a11y) | Real links with thumbnails and chevrons; segmented control with `aria-pressed`. |
| Buyer status was one card with a pill; no sense of progress. | Moderate | Order-tracker style three-step progress (Sent → Shop reviews → Refunded/Closed). |
| Cards re-rendered every poll. | Minor | Fade-in only on first paint; polls only re-render on change. |

What worked and was kept: who-said-what colour coding (buyer purple, model blue, merchant green), the two-column case layout, the explicit "photos only, the buyer's words never reach the model" note, the visible PayPal IDs.

## System

All tokens live at the top of `public/app.css` and have dark-mode values.

- **Type:** `-apple-system` / SF Pro on Apple devices, Inter elsewhere (loaded from Google Fonts so the Linux-recorded video matches). Large title 40/700/-0.035em, title 22/600, body 17, footnote 12. Tabular numerals for money.
- **Colour:** Apple system colours, darkened where text sits on tints so every badge passes WCAG AA (4.5:1). Blue `#0071e3` for actions, `#0066cc` for blue text.
- **Shape:** cards 18px radius, controls 12px, buttons are pills with 44px minimum height (52px for primary actions).
- **Chrome:** sticky translucent nav bar with blur and a hairline separator.
- **Motion:** 0.45s ease fade-up on first paint, check-mark draw on success, press scale 0.98. All disabled under `prefers-reduced-motion`.

## PayPal button

Rendered by the PayPal JS SDK with official style options only (`color: gold`, `shape: pill`, `label: paypal`, `height: 50`). We never restyle or overlay the iframe, and keep "Powered by PayPal".

## Polish pass (2026-10-22)

- Inbox grid fits a 1440 px screen without sideways scrolling, grows with its rows (pages of 20), and shows remedies as a gold "N fit" pill (library matches) next to a clay "N AI" pill (Claude Haiku suggestions still open or added). The drafted amount stays in the CSV.
- Case page: one offer block holds the library matches, then Claude Haiku's suggestions with "Add to the offer" and "Dismiss", then "Let the buyer choose". When no library remedy fits, the block says so and shows Haiku's suggestions alone.
- Claude Haiku has its own colour (clay, `--claude`) in the timeline and pills, apart from Jev's blue.
- Buyer success headline is short: "Refund sent. A 24k gold-leaf kintsugi kit is on its way."
- Contrast: filled buttons use `--action` (#0071e3) in both themes so white text stays above 4.5:1; link-blue, secondary grey, red, gold and clay text darkened (light) or lightened (dark) to pass AA on their tints.

## Accessibility check

axe-core 4.10 (WCAG 2 A/AA rules), re-run 2026-10-22 on the store, claim form, inbox, remedies, eight case states and eight buyer status states, light, dark and phone: no colour or labelling violations. One remains inside AG Grid itself (`scrollable-region-focusable` on its viewports); the grid cells are keyboard-navigable through AG Grid's own focus handling, and forcing a tabindex on the viewport broke its ARIA roles, so it is left as is. Focus rings on every control, labels on all inputs, `role="alert"` on errors, `aria-live` on the tracker.

## Naming

- **Refund Relay** is the product: the refund agent for stores that take PayPal. Tagline: *Turn a broken order into the next sale.*
- **Juniper Market** is the demo store, one merchant on Refund Relay. Its storefront shows its own name and a plain monogram, never the Refund Relay mark.
- Buyer pages (claim, status) are hosted by Refund Relay for whichever store sold the order: the store's name leads the header, and "Returns by Refund Relay" signs it on the right. They never hard-code a store name.
- Merchant pages (console, dashboard) carry the Refund Relay mark; the signed-in store's name fills the `data-store` eyebrow.
