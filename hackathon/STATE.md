# Project state

Last updated 2026-10-22.

## Working flow (verified on the PayPal sandbox with live Jev)

$80 sandbox purchase (4 mugs) → buyer claims one broken mug with a photo → Jev findings (about 250 ms) → policy drafts $20 → merchant clicks "Approve $20.00 refund" → PayPal partial refund COMPLETED → buyer status shows "Merchant issued a refund".

Verified through the real UI with `scripts/e2e-sandbox.js` (Playwright, sandbox buyer login). Three sandbox refunds completed, each with one PayPal call, and each checked afterwards with `GET /v2/payments/refunds/{id}`: `49T36639R9467133H`, `4R6304365K5436101`, `9XT59558AV249645H`. The capture shows `PARTIALLY_REFUNDED`. A duplicate approval sent while the first was still in flight returned 409 with the existing operation, and no second refund was made.

A fourth live run got an item-match score of 0.79, just under the 0.8 threshold, so the case went to "needs your judgment" and approval required a written reason. That is the intended behaviour; see `GATE2_PROBE.md`.

Screenshots of the latest run are in `hackathon/screenshots/` (desktop and `m-*` mobile, light and dark), with the pre-redesign set in `hackathon/screenshots/before/`.

## UI

Apple-style redesign across store, claim, tracking and merchant screens (PR #2). Tokens and rationale: `DESIGN.md`. axe WCAG AA: 0 violations on store, inbox and case pages in both themes. The walkthrough video was re-recorded with the new UI.

## Gates

- Gate 1 (financial loop): done, in an earlier thread and again here.
- Gate 2 (Jev on photos): done. See `GATE2_PROBE.md`.
- Gate 3 (vertical slice): done. The three must-haves, immutable approvals, reservations, idempotency and reconciliation are all in place.
- Gate 4 (verify and polish): started. `npm test` passes 20 tests (invariants, using a fake PayPal and a fake Jev).

## Unresolved

- No hosted demo yet; Render is the candidate (it has a sponsor prize). The upload folder and SQLite file need a persistent disk. `render.yaml` turns on `PUBLIC_DEMO`, so set `DEMO_BUYER_EMAIL` / `DEMO_BUYER_PASSWORD` to a sandbox Personal account when deploying.
- Formal PayPal disputes are not detected (needs the Disputes API permission).
- Verified webhooks are not implemented. Reconciliation polls PayPal every 60 s and on server start.
- Walkthrough video re-recorded with the new UI (101 s, captioned); the final judged video (spec section 15) is still to do.

## Scale and production work (2026-10-22, separate PR)

Up to 100 photos per claim, Jev sees the best 8 at 1024 px, background assessment queue, indexes,
fast reused-photo index, health check, request logs, backups, graceful shutdown and `render.yaml`.
Numbers in `bench/RESULTS.md`; review and roadmap in `PRODUCTION.md`.

## Remaining-risks pass (2026-10-22)

- Item-match wobble measured live (`npm run probe:stability`): 19 photos, 5 runs each. Individual
  findings still flip between "consistent" and "uncertain" on photos scoring near 0.5, but the
  refund route never changed in 95 assessments, and the demo photo got the one-click proposal 5 of 5
  times. Median-of-three Jev calls was tried and dropped: no fewer flips, three times the tokens.
- Re-ran `scripts/e2e-sandbox.js` on merged main: refund `10W17237YR456000U` COMPLETED, duplicate
  approval returned 409.
- Store and claim pages keep the private claim and tracking links in the browser; a reload after
  paying no longer loses them.
- `PUBLIC_DEMO=1` prints the sandbox sign-ins for judges. The case page explains a refund PayPal
  declined. The capture endpoint is rate-limited.

## Next executable task

Deploy to Render with a persistent disk, then record the 3-minute demo following spec section 15.
