# Project state

Last updated 2026-10-22.

## Working flow (verified on the PayPal sandbox with live Jev)

$80 sandbox purchase (4 mugs) → buyer claims one broken mug with a photo → Jev findings (about 250 ms) → policy drafts $20 → merchant clicks "Approve $20.00 refund" → PayPal partial refund COMPLETED → buyer status shows "Merchant issued a refund".

Verified through the real UI with `scripts/e2e-sandbox.js` (Playwright, sandbox buyer login). Three sandbox refunds completed, each with one PayPal call, and each checked afterwards with `GET /v2/payments/refunds/{id}`: `49T36639R9467133H`, `4R6304365K5436101`, `9XT59558AV249645H`. The capture shows `PARTIALLY_REFUNDED`. A duplicate approval sent while the first was still in flight returned 409 with the existing operation, and no second refund was made.

A fourth live run got an item-match score of 0.79, just under the 0.8 threshold, so the case went to "needs your judgment" and approval required a written reason. That is the intended behaviour; see `GATE2_PROBE.md`.

Screenshots of the latest run are in `hackathon/screenshots/` (desktop and `m-*` mobile, light and dark), with the pre-redesign set in `hackathon/screenshots/before/`.

## UI

Apple-style redesign across store, claim, tracking and merchant screens (PR #2). Tokens and rationale: `DESIGN.md`. axe WCAG AA: 0 violations on store, inbox and case pages in both themes. The walkthrough video was re-recorded with the new UI.

## Damage boxes (2026-10-22)

Each photo Jev sees also gets its own small call with a `box` question ("where is the damage?") and a
per-photo damage check. The merchant case page outlines the damage on the thumbnails, in the
enlarged photo, and in a large photo at the top of "What Jev saw". A box is drawn only when that
call is at least 0.7 sure the photo shows damage, because Jev returns a box even for an intact mug
(four live runs each: chip 0.85-0.87, intact mugs 0.43-0.55). Boxes over 85% of the photo are
dropped, and hairline ones are widened to 8%.
Boxes are display only; policy never reads them. Live check (jev-1.14.0): snapped handle, chip and
cracked glass were all outlined in the right place, intact mugs got no box, about 300-600 ms for
the whole assessment. Screenshots: `screenshots/6-damage-boxes.png`, `6b-damage-zoom.png`.

## Kintsugi repair offers (2026-10-22)

When Jev reads the damage as a chip, crack or snapped handle (damage-type confidence 0.5 or more,
visible breakage "yes"), the proposal carries three options the merchant can send instead of
deciding alone: full refund ($20), keep it with a free kintsugi kit ($12 back), or the 24k
gold-leaf kit ($3 back: the $9 kit price comes off the refund, so the buyer never pays twice).
The merchant clicks "Let the buyer choose"; that approves every amount on the list. The buyer
picks on the status page, and the pick becomes one PayPal partial refund through the same gate as
a direct approval (`reserve` in `src/refunds/execute.js`, `src/offers.js`). A shattered mug, or an
unsure damage type, gets the plain refund only. Amounts live in `src/catalog.js` under `repair`.

Live sandbox run (`E2E_OFFER=1 node --env-file=.env scripts/e2e-sandbox.js probe/cases/chipped-closeup.jpg`):
buyer picked the gold-leaf kit, refund `0XM259959W007021K` for $3.00 COMPLETED. Screenshots
`screenshots/7-*.png` to `9-*.png`. Not built yet: real kit fulfilment (the merchant sees "Send:
<kit>" on the case), and offering a replacement.

## Agent timeline and AG Grid inbox (2026-10-22)

- Case page: "How this case was handled" lists every step with who acted (buyer, Jev, refund
  policy, merchant, PayPal), what Jev saw with its confidences and latency, what the policy
  drafted and why, the buyer's pick, and PayPal's refund ID. Built from the audit log and stored
  assessments in `src/timeline.js`; nothing is shown that was not recorded.
- Merchant inbox is an AG Grid Community 32.3.3 grid (CDN): outlined-photo thumbnails, status,
  Jev's damage type, breakage confidence meter, concern count, a Kintsugi tag on repairable
  cases, drafted and refunded amounts, outcome; sort, column filters, quick search, status
  segments, CSV export, Enter or click opens a case. Falls back to the old list if the CDN fails.
  Screenshots `screenshots/10-*.png`, `11-agent-timeline.png`.

## Gates

- Gate 1 (financial loop): done, in an earlier thread and again here.
- Gate 2 (Jev on photos): done. See `GATE2_PROBE.md`.
- Gate 3 (vertical slice): done. The three must-haves, immutable approvals, reservations, idempotency and reconciliation are all in place.
- Gate 4 (verify and polish): started. `npm test` passes 20 tests (invariants, using a fake PayPal and a fake Jev).

## Unresolved

- Item-match threshold sits on Jev's run-to-run variance (about 0.1). Recalibrate with `evidence-v2`.
- No hosted demo yet; Render is the candidate (it has a sponsor prize). The upload folder and SQLite file need a persistent disk.
- Judge access: decide whether to publish a sandbox buyer login and a merchant password, with rate and amount caps.
- Verified webhooks are not implemented. Reconciliation polls PayPal every 60 s and on server start.
- Walkthrough video re-recorded with the new UI (101 s, captioned); the final judged video (spec section 15) is still to do.

## Scale and production work (2026-10-22, separate PR)

Up to 100 photos per claim, Jev sees the best 8 at 1024 px, background assessment queue, indexes,
fast reused-photo index, health check, request logs, backups, graceful shutdown and `render.yaml`.
Numbers in `bench/RESULTS.md`; review and roadmap in `PRODUCTION.md`.

## Next executable task

Deploy to Render with a persistent disk, then record the 3-minute demo following spec section 15.
