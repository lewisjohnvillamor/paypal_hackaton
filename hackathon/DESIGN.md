# Design notes

Goal: one product that reads as designed on purpose, not as the average of every AI-made app. Buyer, merchant and setup screens share one brand system.

## How it was made (2026-11-02)

The redesign follows **tasteskill v2** ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill), MIT), vendored at `.claude/skills/taste-skill` so every Claude Code session on this repo uses it for front-end work. Merchant screens follow its app-screen chapter (`references/app-screens.md`); the store and buyer pages follow its page rules.

What the skill flagged in the old UI, and what replaced it:

| AI tell in the old UI | Replaced with |
|---|---|
| Blue-to-violet gradient logo, blue on every button and link | Flat marker-yellow mark, ink primary buttons, ink links with an underline |
| Translucent blurred nav bar | A plain bar on the ground with a 1px rule |
| Store name as a grey eyebrow above every title | The store name next to the product mark in the header (product plus scope) |
| 40px landing-page titles on working screens | 30px noun titles; the store is the only page with a display headline |
| White cards with soft shadows stacked down every settings page | Settings in two columns (title and note left, controls right) split by rules |
| Four KPI tiles | One divided panel, figure over label, one figure highlighted |
| Pill segmented control, pills with dots, uppercase tracked labels | Underline tabs, small pale status marks, sentence case everywhere |
| Gold gradient text and gradient offer boxes | Flat fills only |
| Buyer purple and AI blue avatars | Pale identity tints; the photo check takes the brand yellow |
| Inter / SF system type | One face with character, Schibsted Grotesk |

## System

All tokens live at the top of `public/app.css`, with dark-mode values. Older token names (`--blue`, `--tint-*`) are aliases so page scripts keep working.

- **Idea:** the photo check draws a box around the damage. That box, in marker yellow, is the brand: it is the logo, the outline on every damage photo, the highlight on the one figure that matters, and the refund amount on the buyer's result.
- **Type:** Schibsted Grotesk 400/500/600/700, one face. Monospace only for IDs and code. Title 30/700, section 19/600, body 16, small 14, footnote 12.5. No tabular figures (the face's tabular period is too wide for prices).
- **Colour:** stone ground `#f3f2ef`, white surfaces, ink `#171614`, muted `#5f5b54`, rules `#e0ddd7`. Brand `#ffd21f` with ink `#1f1a00` on it, never as text colour. Status as pale tints with dark text of the same hue (ok green, warn amber, bad red, info slate). No violet, no gradients, no glass.
- **Shape:** cards 10px with a 1px edge and no shadow, controls 8px, status marks 6px. Shadows only on what floats (the phone bag bar, the lightbox).
- **Buttons:** ink primary, outlined secondary, 40px (50px for the one main action). The approve button is ink too: the amount on it carries the meaning.
- **Motion:** a 6px fade-up on first paint, the damage box scaling into place, the check drawing on success. All off under `prefers-reduced-motion`.
- **The relay.js button** a store embeds uses the same mark, ink text and 8px corners, inside its shadow root.

## PayPal button

Rendered by the PayPal JS SDK with official style options only (`color: gold`, `shape: pill`, `label: paypal`, `height: 50`). We never restyle or overlay the iframe, and keep "Powered by PayPal".

## AG Grid

AG Grid Community (quartz theme) on the requests and remedies screens, themed through its CSS variables: no header band, 13px grey sentence-case headers, row rules only, the brand font, ink checkboxes, yellow-tint selection.

## Accessibility

Ink on stone and every status tint pass WCAG AA. Focus is a 2px ink outline on every control. Labels on all inputs (the sign-in password label is now visible), `role="alert"` on errors, `aria-live` on the tracker. The earlier axe-core notes still apply: one finding remains inside AG Grid itself (`scrollable-region-focusable`).

## Naming

- **Refund Relay** is the product: the refund agent for stores that take PayPal. Tagline: *Turn a broken order into the next sale.*
- **Juniper Market** is the demo store, one merchant on Refund Relay. Its storefront shows its own name and a plain monogram, never the Refund Relay mark.
- Buyer pages (claim, status) are hosted by Refund Relay for whichever store sold the order: the store's name leads the header, and "Returns by Refund Relay" signs it on the right. They never hard-code a store name.
- Merchant pages (console, dashboard) carry the Refund Relay mark; the signed-in store's name sits next to the mark in the header (`data-store`), never as an eyebrow above the title.
