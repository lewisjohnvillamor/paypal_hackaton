# Refund Relay

A small shop gets a "my mug arrived broken" message with photos. Refund Relay links that message to the original PayPal payment, has an AI model check the photos, drafts a refund from the shop's policy, and sends the refund through PayPal once the merchant approves it.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). It runs on the PayPal **sandbox** only. This is a prototype, not production software.

![Merchant case view](hackathon/screenshots/3-merchant-case.png)

## What happens

1. **Purchase.** The buyer pays $80 for four $20 mugs with PayPal Checkout. The server sets the price, captures the payment, checks the amount, currency and payee, and gives the buyer a private claim link.
2. **Complaint.** The buyer picks the item and quantity, describes the problem, and uploads up to three photos.
3. **Evidence check.** [Jev](https://docs.typesafe.ai) (TypeSafe, `jev-1.14.0`) answers narrow typed questions about the photos: are they usable, is breakage visible, is it the same kind of product as the catalog photo. Only the photos go to the model, never the buyer's text, so a complaint cannot talk the model into anything.
4. **Policy.** A pure function turns the findings into a draft: "propose $20.00", "needs your judgment", or "ask for better photos". A negative finding never denies a claim by itself.
5. **Approval.** The merchant sees the customer's words, the model's observations and the PayPal payment side by side, and clicks **Approve $20.00 refund**. A different amount, or approving a case the policy did not propose, requires a written reason.
6. **Refund.** One idempotent PayPal partial refund runs against the original capture. The app shows PayPal's real refund ID and status.

## Money safety

- Amounts are integer cents. Decimal strings appear only in PayPal requests.
- The refund code is the only path that moves money. The AI adapter has no PayPal access.
- Funds are reserved in the database before PayPal is called, and no database transaction stays open during a network call.
- Every logical refund has a stored `PayPal-Request-Id`. A timeout is recorded as UNKNOWN, not FAILED, and the funds stay reserved. A retry reuses the same request ID, so PayPal returns the original refund instead of making a second one.
- Database constraints allow one open refund per capture, one approval per case version, and one active request per order. Duplicate clicks get the existing operation back.
- New photos or a status change bump the case version, so an earlier approval goes stale.
- Open refunds are reconciled with PayPal when the server starts and every 60 seconds.

## Run it

Requires Node.js 22.15 or newer, a [PayPal sandbox app](https://developer.paypal.com/dashboard/applications/sandbox), and a [TypeSafe](https://typesafe.ai) API key.

```sh
npm install
cp .env.example .env    # fill in PayPal sandbox keys, TYPESAFE_API_KEY, MERCHANT_PASSWORD, SESSION_SECRET
npm start               # http://localhost:8888
```

- Store: `http://localhost:8888`. Pay with a sandbox **Personal** account.
- Merchant console: `http://localhost:8888/merchant`. Sign in with `MERCHANT_PASSWORD`.
- Sample damage photos for the claim form are in `probe/cases/`. `broken-rocket-mug.jpg` usually gets a one-click proposal; `damage-not-shown.jpg` goes to manual review.

### Tests and checks

```sh
npm test                                     # 20 tests: money, policy, duplicate/concurrent approvals, tampering,
                                             # stale approvals, timeouts, restart recovery, access control
npm run probe                                # live Jev run over 18 labelled photos (uses your API key)
node --env-file=.env scripts/e2e-sandbox.js  # full live run in a headless browser (needs the app running and Playwright)
```

Tests use a fake PayPal and a fake Jev and are labelled as such. The probe and the end-to-end script call the real services.

## How well the AI does

On 18 labelled photos ([full write-up](hackathon/GATE2_PROBE.md)):

- Visible breakage: 7 right, 1 wrong, 2 unsure.
- No intact mug was called broken.
- Every blurred or dark photo was flagged as unusable.
- Median latency was 194 ms.

The weak spot is matching shattered pieces to the catalog photo. Those cases go to the merchant instead of getting a one-click proposal. This is a small feasibility check, not an accuracy benchmark.

## Project layout

```text
src/server.js               routes
src/paypal/client.js        OAuth, Orders v2, captures, refunds (sandbox only)
src/ai/jev.js               Jev questions and normalised findings
src/policy/refundPolicy.js  pure refund policy
src/refunds/execute.js      approval, reservation, submission, reconciliation
src/claims.js, orders.js    workflow
public/                     store, claim form, buyer status, merchant console
probe/                      Gate 2 photo set, runner, results
tests/                      node:test suites
hackathon/                  state, probe report, screenshots
```

## Tools

- **PayPal:** Orders v2 (create and capture), Payments v2 (capture lookup, partial refund with `PayPal-Request-Id`, refund lookup), JavaScript SDK Checkout buttons. Sandbox only.
- **AI:** Jev `jev-1.14.0` (`jev-preview`) by TypeSafe, through `@typesafe-ai/sdk`, using image inputs, Noul and Choice questions.
- **Stack:** Node.js 22, Express, `node:sqlite`, Sharp, Multer, Playwright (end-to-end script only).

## Limits

- Single merchant, USD only, sandbox only, one active request per order.
- Delivery date is a labelled synthetic value (the capture time), not carrier data.
- Refunds made outside the app, and formal PayPal disputes, are not reconciled. Ordinary refund requests are not PayPal disputes, and buyers keep PayPal's own resolution options.
- Photos are not proof of fraud, cause, or liability. The model helps the merchant review; the merchant decides.

## Credits

Photos in `probe/cases/` and the catalog photo are Creative Commons or CC0 works. Authors, licences and sources are listed in [`probe/cases.json`](probe/cases.json). The two blurred cases are modified copies made for the probe.

## Licence

MIT. See [LICENSE](LICENSE). Bundled photos keep their own licences.
