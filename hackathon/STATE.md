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
unsure damage type, gets the plain refund only. Superseded by the remedy library below.

Live sandbox run (`E2E_OFFER=1 node --env-file=.env scripts/e2e-sandbox.js probe/cases/chipped-closeup.jpg`):
buyer picked the gold-leaf kit, refund `0XM259959W007021K` for $3.00 COMPLETED. Screenshots
`screenshots/7-*.png` to `9-*.png`. Not built yet: real kit fulfilment (the merchant sees "Send:
<kit>" on the case), and offering a replacement.

## Remedy library: Jev suggests the remedy (2026-10-22)

The fixed kintsugi rule above is replaced by a merchant-owned remedy library (`remedies` table,
`src/remedies.js`, page `/merchant/remedies`, an editable AG Grid). Each remedy has a title, what
the merchant sends, a refund per item (always below the price paid), a kind (repair kit, spare
part, replacement, other) and a plain-language "when it fits" sentence. On every review Jev gets
one yes/no question per active remedy ("does the damage in the photos match this description?",
`rankRemedies` in `src/ai/jev.js`, run in parallel with the main call); remedies scoring 0.5 or
more are offered, best fit first, at most 3, next to the full refund (`resolutionOptions`). The AI
picks from the merchant's list, so it can never invent an item or an amount. Only merchant-written
text goes to Jev with the photos; the buyer's words still never do. Seeded from `src/catalog.js`:
kintsugi kit ($12 back), 24k gold-leaf kit ($3 back), replacement (no refund).

A replacement settles the case with no PayPal call (status `resolved`; the order line counts as
handled for later claims). Live Jev fits, two runs each: chip, kintsugi 0.81-0.83 and replacement
0.83-0.84; snapped handle, replacement 0.97 and kintsugi 0.08 or less; shards, replacement
0.52-0.65; broken-in-packing, replacement 0.43-0.80 (noisy around the 0.5 cut); intact mug, 0.16
or less. Screenshots `screenshots/12-*.png` to `16-*.png` (fit numbers in those are recorded
values played back through the test double). Free-form AI suggestions outside the library are
deliberately not built before the deadline.

## Claude Haiku remedy suggestions (2026-10-22)

Beyond the merchant's library, Claude Haiku 5.5 (`src/ai/haiku.js`) can suggest other store
listings as remedies. The server first narrows the listings (`LISTINGS` in `src/catalog.js`) to the
ordered product's category and the damage Jev saw (`src/suggest/candidates.js`, at most 12); Haiku
gets the photos, Jev's reading and that list, never the buyer's words, and its answer is a JSON
schema whose listing id must be one of the candidates (effort low). The server re-checks every
suggestion (`checkSuggestions`: known id, integer refund, listing price plus refund at or under the
price paid, at most 2) and stores it as pending. The merchant adds or dismisses each one on the
case page; only added ones join the buyer's choices (`offerOptions`), and a pick is refunded through
the same gate. Runs only when Jev clearly saw damage on usable photos; a Haiku failure is logged on
the timeline and never blocks the review. Off unless `ANTHROPIC_API_KEY` is set. Pricing (checked
2026-10-22): $0.10 / $0.50 per MTok, about $1 per 1,000 claims. Not yet run against the live API;
screenshots `screenshots/17-*.png` to `19-*.png` use the test double.

## Agent timeline and AG Grid inbox (2026-10-22)

- Case page: "How this case was handled" lists every step with who acted (buyer, Jev, refund
  policy, merchant, PayPal), what Jev saw with its confidences and latency, what the policy
  drafted and why, the buyer's pick, and PayPal's refund ID. Built from the audit log and stored
  assessments in `src/timeline.js`; nothing is shown that was not recorded.
- Merchant inbox is an AG Grid Community 32.3.3 grid (CDN): outlined-photo thumbnails, status,
  Jev's damage type, breakage confidence meter, concern count, how many remedies fit, drafted and refunded amounts, outcome; sort, column filters, quick search, status
  segments, CSV export, Enter or click opens a case. Falls back to the old list if the CDN fails.
  Screenshots `screenshots/10-*.png`, `11-agent-timeline.png`.

## Gates

- Gate 1 (financial loop): done, in an earlier thread and again here.
- Gate 2 (Jev on photos): done. See `GATE2_PROBE.md`.
- Gate 3 (vertical slice): done. The three must-haves, immutable approvals, reservations, idempotency and reconciliation are all in place.
- Gate 4 (verify and polish): started. `npm test` passes 20 tests (invariants, using a fake PayPal and a fake Jev).

## Refund agent: the merchant's rules in plain English (2026-10-26)

The merchant writes standing rules on `/merchant/agent` ("Refund chipped mugs under $25 on your
own. Ask me about anything above that."). Claude Haiku turns the words into `{ rules: [{ skus,
damage, maxRefundCents, action }], dailyLimitCents }` (`parseRules` in `src/ai/haiku.js`); the server
checks it (`checkRules`: known products, damage that product can have, a limit on every rule, $200
ceiling, daily limit at least the largest rule, $100 default) and writes the read-back itself
(`describeRules`), with a replay of what the rules would have done on the latest 12 requests. Only
the checked structure is stored and enforced (`mandates` table), never the words.

After each queued review the agent (`runAgent`, `src/agent/autopilot.js`) runs `decide()`: only a
`propose` route (clear evidence, no policy concerns), a rule covering the product and the damage
type (photo check at least 0.5 sure of it), the amount within the rule, and the last 24 hours of
agent refunds plus this one within the daily limit. Then the PayPal ledger check, and inside one
transaction it decides again and calls the same `reserve` as a merchant approval (actor `agent`),
then `submit`. An `offer` rule sends the remedy list instead (`openOffer`). Anything else is left
for the merchant with one sentence on the timeline, the inbox Outcome column and the agent page.
The merchant's manual re-review does not trigger the agent.

Live (2026-10-26, `scripts/e2e-agent.js`, real PayPal sandbox, photo check and rule reader): the
rule above read back as "Refund any classic white ceramic mug with a crack or chip, up to $25.00 a
request"; a chipped mug was refunded by the agent with no click, refund `0CB61482WR802293Y` for
$20.00 COMPLETED (an earlier run: `2L621395024542343`); a cracked vase was left: "None of your rules
covers the clear glass bud vase." A repeat run with the same mug photo was left too, because the
reused-photo flag fired. Rule reader, five sample texts (`probe/rules-live.js`): all read correctly
in 1.3-2.8 s; "just handle the small stuff" was refused for having no amount. Screenshots
`screenshots/20-*.png` to `27-*.png`.

## Agent-to-agent: MCP servers for both sides' assistants (2026-10-27)

`mcp/buyer.js` (a shopper's assistant files, follows and settles a claim; the claim link is its only
permission) and `mcp/merchant.js` (the merchant's assistant reads requests, agent decisions and
rules, and checks them with the PayPal Agent Toolkit's read-only tools; no money-moving tool is
registered). `scripts/agent-to-agent.js` (`npm run demo:agents`) drives both with a model in a tool
loop. Live run 2026-10-27: the buyer's assistant used get_order, report_damage and check_request
(wait 60 s); the refund agent refunded `1W017904CP577140R` $20.00 COMPLETED; the merchant's assistant
used list_requests, get_request, then the toolkit's get_refund and get_order, and confirmed it.
Transcript: `AGENT_TO_AGENT_RUN.md`. 91 tests pass (3 new in `tests/mcp.test.js`).

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

## Hackathon video (2026-10-27)

2:49, voiced and scored: the owner sets the refund agent's rules in plain English, a shopper pays with PayPal and is refunded by the agent with no click, a second shopper's own assistant files through the buyer MCP server and is refunded the same way, a cracked vase goes to the owner (remedies + in-stock suggestion), a different product is held for a label photo. Live PayPal sandbox, live photo check and live assistants.

- Voice: `python3 scripts/voice/tts.py scripts/voice/agent-video-lines.json data/voice <kokoro-model-dir>` (Kokoro, offline, voice af_heart). Captions are the voiceover lines.
- Record: app on a fresh database with REPEAT_CLAIM_LIMIT=0, then `CHROMIUM_PATH=/opt/pw-browsers/chromium node --env-file=.env scripts/record-agent-video.js data/agent-video`. It stops if the agent did not pay the assistant's request.
- Stitch: `node scripts/stitch-agent-video.js data/agent-video <music.mp3>`. Playwright's video drifts from the wall clock (up to 10 s on a long take), so the recorder flips a corner square at every cut and line and the stitcher maps times through those flips.
- Music: "Inspired", Kevin MacLeod (incompetech.com), CC BY 4.0; the credit goes in the YouTube description.
- The generated `demo-photos/5-mug-in-pieces.jpg` is now flagged as a likely stock photo by the live check (4 of 4 runs), so the agent rightly holds it; the video uses the snapped-handle photo for the assistant scene.

## Correctness audit (2026-10-28)

Live on the PayPal sandbox with the real photo checks: merchant approval ($20 COMPLETED, a second
click refused with 409), buyer's pick of the gold-leaf kit ($3 COMPLETED), the refund agent ($20
COMPLETED with no click; the vase left for the merchant) and the agent-to-agent demo ($20 COMPLETED,
confirmed by the merchant's assistant against PayPal). One money bug found and fixed: a replay of a
refund request (the 60 s reconcile sweep, or the merchant's reconcile button) could answer after the
original call and mark a completed refund FAILED, which released its funds and allowed a second real
refund for the same item. A settled refund now ignores late answers (except PayPal confirming a
refund we had marked failed), the sweep skips calls still in flight, and a refund PayPal lists under
a failed operation's ID blocks new refunds. `scripts/e2e-sandbox.js` was updated for the AG Grid
inbox and the pick-then-confirm buyer step. 95 tests pass.
