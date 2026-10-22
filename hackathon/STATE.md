# Project state

Last updated 2026-10-22.

## Working flow (verified on the PayPal sandbox with live Jev)

$80 sandbox purchase (4 mugs) → buyer claims one broken mug with a photo → Jev findings (about 250 ms) → policy drafts $20 → merchant clicks "Approve $20.00 refund" → PayPal partial refund COMPLETED → buyer status shows "Merchant issued a refund".

Verified through the real UI with `scripts/e2e-sandbox.js` (Playwright, sandbox buyer login). Three sandbox refunds completed, each with one PayPal call, and each checked afterwards with `GET /v2/payments/refunds/{id}`: `49T36639R9467133H`, `4R6304365K5436101`, `9XT59558AV249645H`. The capture shows `PARTIALLY_REFUNDED`. A duplicate approval sent while the first was still in flight returned 409 with the existing operation, and no second refund was made.

A fourth live run got an item-match score of 0.79, just under the 0.8 threshold, so the case went to "needs your judgment" and approval required a written reason. That is the intended behaviour; see `GATE2_PROBE.md`.

Screenshots of the latest run are in `hackathon/screenshots/`.

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
- No video yet.

## Next executable task

Deploy to Render with a persistent disk, then record the 3-minute demo following spec section 15.
