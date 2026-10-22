# Load test results

Measured 2026-10-22 on a 4-core, 16 GB Linux container with Node 22.22. "Before" is PR #1's branch
(`claude/project-thread-qvj06f` at 2737250); "after" is this branch.

## How it was measured

- `npm run bench` (`bench/run.js`) starts the real app in a child process with a fresh on-disk
  SQLite database, a fake PayPal and a **stub Jev** (no network, no cost). The stub sleeps
  200 ms + 20 ms per photo, which brackets the live calls below, and refuses a call that would carry
  more than 32k image tokens, as the real API does.
- Buyers are simulated over HTTP, each from its own 127.0.0.x address so per-IP limits behave as
  they would for different people. "Ready" is when the merchant's case page has a drafted proposal.
- Photos are phone-sized: 100 JPEGs at 4032×3024, 2.06 MB on average (`bench/photos.js` builds them
  from the probe set). "Browser-shrunk" means the 1568 px copy the claim page now sends.
- Peak RSS is the server process's high-water mark (`VmHWM`).
- Live numbers come from `bench/jev-live.js` and `bench/live-pipeline.js` against the real Jev API
  (`jev-preview`), 9 calls in total.

## Server under load (stub Jev)

| Scenario | Before | After |
| --- | --- | --- |
| 1 claim, 3 photos: submit / ready | 846 ms / 851 ms | 233 ms / 556 ms |
| 1 claim, 30 photos | rejected (limit 3) | ready in 2.2 s, Jev sees 8 |
| 1 claim, 100 photos | rejected (limit 3) | ready in 6.3 s, Jev sees 8 |
| 1 claim, 100 photos, browser-shrunk | rejected | ready in 2.7 s |
| 40 claims at once, 3 photos each: submit p50 / p95 | 7.3 s / 8.1 s | 4.4 s / 6.4 s |
| same burst, browser-shrunk: submit p50 / ready p95 | n/a | 2.1 s / 5.4 s |
| same burst: Jev calls in flight at once | 18 | 4 (the queue's limit) |
| same burst: worst event-loop stall | 700 ms | 42 ms |
| same burst: peak memory | 683 MB | 446 MB (310 MB browser-shrunk) |
| 10 claims at once, 20 photos each | all rejected | all ready, p95 12.6 s |
| Shop with 20k past claims: new claim ready | 5.1 s | 0.75 s |
| same: merchant inbox load | 203 ms, 4.8 MB | 3 ms, 24 KB (100 newest) |
| same: worst event-loop stall | 1,010 ms | 149 ms |

The raw-photo numbers above are the worst case: a client that uploads full-size phone photos.
Through the real claim page, photos are shrunk before upload.

## Browser upload (`bench/browser-upload.js`, headless Chromium)

| Photos picked | Original size | Sent over the wire | Click to "request sent" |
| --- | --- | --- | --- |
| 30 | 61.8 MB | 7.9 MB | 3.7 s |
| 100 | 206 MB | 26.7 MB | 9.7 s |

The time is mostly headless Chromium decoding 12 MP JPEGs in software. On a phone the network
matters more: 206 MB at 10 Mbit/s is about 2 min 45 s; 26.7 MB is about 21 s. After the 100-photo
upload the merchant's case page showed a decision 2.1 s after opening, with the line "looked at the
8 clearest of 100 photos".

## Image processing (`bench/images.js`, 40 phone photos)

| | Per photo |
| --- | --- |
| One at a time (before) | 159 ms |
| 2 in parallel | 83 ms |
| 4 in parallel (after, the default) | 48 ms |
| 8 in parallel | 51 ms (no gain on 4 cores) |
| 4 in parallel, browser-shrunk input | 20 ms |

## Live Jev

How many photos fit in one call (probe photos, about 1024 px, stored at up to 1568 px):

| Photos | Input tokens | Wall time |
| --- | --- | --- |
| 1 | 4,850 | 375 ms |
| 3 | 8,850 | 219 ms |
| 6 | 14,872 | 382 ms |
| 12 | 27,011 | 426 ms |
| 24 | refused: `max_tokens_exceeded` | 136 ms |

Latency hardly grows with photo count; the hard limit is the per-call token budget. Image tokens
scale with pixels: the same photo cost about 3,700 tokens at 1568 px and about 1,100 at 1024 px.

Same 3 phone photos, old path against new path:

| | Input tokens | Jev time | Breakage |
| --- | --- | --- | --- |
| Before: stored 1568 px copies | 16,963 | 491 ms | yes |
| After: 1024 px copies | 9,073 | 356 ms | yes |

Through the full pipeline with live Jev: a 3-photo claim was ready 636 ms after submit, a 20-photo
claim 1.7 s after submit (8 photos sent, 19.6k tokens). Before, 20 photos were refused at upload,
and a 20-photo call at 1568 px would have exceeded the token budget.

All 18 Gate 2 calibration photos are 1024 px or smaller, so the 1024 px model copy is what the
thresholds were tuned on. One live sample is not an accuracy result; rerun `npm run probe` after
changing the model copy size.
