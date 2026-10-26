# Refund Relay

A small shop gets a "this arrived damaged" message with photos: a broken mug, a cracked vase, a stained T-shirt, snapped headphones. Refund Relay links that message to the original PayPal payment, has an AI model check the photos, drafts a refund from the shop's policy, and sends the refund through PayPal once the merchant approves it.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). It runs on the PayPal **sandbox** only. This is a prototype, not production software.

![Merchant case view](hackathon/screenshots/3-merchant-case.png)

## What happens

1. **Purchase.** The buyer fills a bag from four very different products (mug, glass vase, T-shirt, headphones) and pays with PayPal Checkout. The server sets the price from its catalog, captures the payment, checks the amount, currency and payee, and gives the buyer a private claim link.
2. **Complaint.** The buyer clicks "Report a problem" next to an item, picks the quantity, describes the problem, and uploads up to 100 photos. The page shrinks them in the browser before sending.
3. **Evidence check.** [Jev](https://docs.typesafe.ai) (TypeSafe, `jev-1.14.0`) answers narrow typed questions about the photos: are they usable, is damage visible, what kind of damage, is it the same kind of product as the catalog photo. The questions and damage types come from the product kind (`src/kinds.js`), so a T-shirt is checked for stains and tears and headphones for a snapped headband or torn cushion. See [hackathon/PRODUCTS.md](hackathon/PRODUCTS.md). Only the photos go to the model, never the buyer's text, so a complaint cannot talk the model into anything.
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
- Sample damage photos for the vase, T-shirt and headphones are in `probe/products/`; mug photos are in `probe/cases/`. `broken-handle-white.jpg` usually gets a one-click proposal; `damage-not-shown.jpg` goes to manual review, and `broken-rocket-mug.jpg` is flagged as a different design from the catalog mug.

### Hosted demo for judges

Set `PUBLIC_DEMO=1` to print the sandbox sign-ins on the pages themselves: the merchant password on the merchant sign-in screen, and `DEMO_BUYER_EMAIL` / `DEMO_BUYER_PASSWORD` (a sandbox **Personal** account) under the PayPal button. It is off by default and the app refuses to run outside the PayPal sandbox, so nothing real can be refunded. Judges can also skip the PayPal sign-in and use **Debit or Credit Card** with a test card from PayPal's [card generator](https://developer.paypal.com/tools/sandbox/card-testing/).

The store keeps each buyer's private claim and tracking links in the browser, so a reload after paying does not lose them.

### Tests and checks

```sh
npm test                                     # 51 tests: money, policy, duplicate/concurrent approvals, tampering,
                                             # stale approvals, timeouts, restart recovery, access control, edge cases
npm run probe                                # live Jev run over 19 labelled photos (uses your API key)
npm run probe:stability -- 5                 # each photo 5 times: does the refund route ever change between runs?
node --env-file=.env scripts/e2e-sandbox.js  # full live run in a headless browser (needs the app running and Playwright)
```

Tests use a fake PayPal and a fake Jev and are labelled as such. The probe and the end-to-end script call the real services.

Every edge case, abuse attempt and failure mode the app handles, and the known limits, are listed in [`hackathon/EDGE_CASES.md`](hackathon/EDGE_CASES.md).

## How well the AI does

On 18 labelled photos ([full write-up](hackathon/GATE2_PROBE.md)):

- Visible breakage: 7 right, 1 wrong, 2 unsure.
- No intact mug was called broken.
- Every blurred or dark photo was flagged as unusable.
- Median latency was 194 ms.

The weak spot is matching shattered pieces to the catalog photo. Those cases go to the merchant instead of getting a one-click proposal. This is a small feasibility check, not an accuracy benchmark.

## Scale and operations

- A claim can carry 100 photos. Jev looks at the 8 clearest (newest upload first, near-duplicates skipped) as 1024 px copies, which keeps each call inside its token budget; the merchant sees all of them.
- Assessment runs in a bounded background queue (`JEV_CONCURRENCY`), so a burst of claims never opens dozens of model calls, and it resumes after a restart.
- `GET /healthz`, one JSON log line per API request with an `X-Request-Id`, graceful shutdown on SIGTERM, and `npm run backup` (or `BACKUP_INTERVAL_HOURS`) for online database copies.
- `render.yaml` deploys one web service with a persistent disk.
- `npm run bench` load-tests the app with a stub Jev. Before and after numbers are in [bench/RESULTS.md](bench/RESULTS.md); the production review and roadmap are in [hackathon/PRODUCTION.md](hackathon/PRODUCTION.md).

## Project layout

```text
src/server.js               routes
src/paypal/client.js        OAuth, Orders v2, captures, refunds (sandbox only)
src/ai/jev.js               Jev questions and normalised findings
src/policy/refundPolicy.js  pure refund policy
src/refunds/execute.js      approval, reservation, submission, reconciliation
src/claims.js, orders.js    workflow
src/ai/select.js            which photos the model sees
src/queue.js                bounded assessment queue
src/photoIndex.js           fast reused-photo lookup
public/                     store, claim form, buyer status, merchant console
probe/                      Gate 2 photo set, runner, results
tests/                      node:test suites
bench/                      load tests, live Jev samples, results
hackathon/                  state, probe report, screenshots
```

## Tools

- **PayPal:** Orders v2 (create and capture), Payments v2 (capture lookup, partial refund with `PayPal-Request-Id`, refund lookup), JavaScript SDK Checkout buttons. Sandbox only.
- **AI:** Jev `jev-1.14.0` (`jev-preview`) by TypeSafe, through `@typesafe-ai/sdk`, using image inputs, Noul and Choice questions.
- **Stack:** Node.js 22, Express, `node:sqlite`, Sharp, Multer, Playwright (end-to-end script only).

## Limits

- Single merchant, USD only, sandbox only, one active request per order.
- Delivery date is a labelled synthetic value (the capture time), not carrier data.
- Refunds made outside the app are detected before every refund and block the case until reconciled; formal PayPal disputes are not detected. Ordinary refund requests are not PayPal disputes, and buyers keep PayPal's own resolution options.
- Photos are not proof of fraud, cause, or liability. The model helps the merchant review; the merchant decides.

## Credits

Photos in `probe/cases/`, `probe/products/` and the catalog photos are Creative Commons or CC0 works (`probe/products/sources.json` for the newer ones). Authors, licences and sources are listed in [`probe/cases.json`](probe/cases.json). The two blurred cases are modified copies made for the probe.

## Licence

MIT. See [LICENSE](LICENSE). Bundled photos keep their own licences.
