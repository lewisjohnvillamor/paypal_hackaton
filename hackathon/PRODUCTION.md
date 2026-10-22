# Production readiness and roadmap

Written 2026-10-22, alongside the scale work in this branch. Measured numbers are in
[`bench/RESULTS.md`](../bench/RESULTS.md).

## Where it stands

Refund Relay can now take a claim with up to 100 photos, absorb a burst of claims without
stalling, and run on one Render instance with a persistent disk, health checks, request logs and
daily backups. The money path (reservations, idempotent refunds, reconciliation) was already
sound and is unchanged.

It is still a single-merchant, single-instance app on SQLite. That is the right shape for the
hackathon and for a first pilot shop. It is not yet a multi-tenant service.

## What this branch changed

| Problem found | Fix | Effect |
| --- | --- | --- |
| Hard limit of 3 photos per claim | `MAX_PHOTOS` (default 100), per request and per claim | 100-photo claims accepted |
| Jev refuses calls above about 32k image tokens (24 photos failed live) | `src/ai/select.js` picks at most `AI_MAX_PHOTOS` (8): the newest upload first, then the sharpest, skipping near-duplicates; halves the set if Jev still says `max_tokens_exceeded` | 100-photo claims assessed; the merchant sees which photos Jev looked at |
| Photos sent to Jev at 1568 px | 1024 px copies for the model (the size Gate 2 was tuned on) | 47% fewer tokens, 27% faster in a live sample |
| Uploads held in memory (up to 1.5 GB per request at the per-file cap) | Multer streams to a temp folder; a 300 MB request cap answers 413 early | Peak memory in a 40-claim burst 683 → 446 MB |
| Photos resized one at a time | 4 at a time (`IMAGE_CONCURRENCY`) | 159 → 48 ms per phone photo |
| Full-size phone photos uploaded | The claim page shrinks photos to 1568 px in the browser first | 206 MB → 27 MB for 100 photos |
| Each claim held its HTTP request open while Jev ran; a burst opened 18 Jev calls at once | In-process queue (`src/queue.js`, `JEV_CONCURRENCY` 4), resumed from the database after a restart; the case page shows "Checking the photos with Jev…" | Buyers get an answer at once; Jev load is bounded |
| Reused-photo check compared BigInt hashes against every past photo | Typed-array index with 32-bit popcounts (`src/photoIndex.js`) | New claim with 20k past claims: 5.1 s → 0.75 s |
| No secondary indexes | 14 indexes on foreign keys and time columns | |
| Inbox returned every claim | 100 per page, `?before=` cursor | 4.8 MB / 203 ms → 24 KB / 3 ms |
| Rate limits keyed on the proxy's IP behind a load balancer | `TRUST_PROXY` | Each buyer gets their own bucket on Render |
| Rate-limit map never swept | Swept every 10 minutes | Bounded memory |
| Missing config found on the first request | `checkConfig()` at boot | Fails fast with the missing names |
| No health check, no request logs, abrupt stop on deploy | `/healthz` (database, queue, memory); one JSON log line per API request with an `X-Request-Id`; SIGTERM drains requests and the queue, checkpoints the WAL | |
| No backups | `npm run backup` and `BACKUP_INTERVAL_HOURS` (`VACUUM INTO`, keeps 7) | |
| No deploy recipe | `render.yaml`: one web service, 2 GB disk at `/var/data`, health check, secrets as unsynced env vars | |

Tests: 50 pass (41 before, plus 9 for many photos, the token-budget fallback, photo picking, the
queue, restart recovery, the photo index, inbox paging, the health check and backups).

## Review by area

**Security.** Good: hashed, expiring buyer capability links; signed `HttpOnly` `SameSite=Strict`
merchant cookie plus a custom header on every mutation; uploads re-encoded (metadata stripped,
bombs rejected); the buyer's text never reaches the model; HSTS when served over HTTPS (new).
Gaps: one shared merchant password with no second factor or per-person accounts; no Content
Security Policy (pages use inline scripts, and the PayPal SDK needs its own allowances); no
automated dependency audit.

**Reliability.** Good: refunds are idempotent and reconciled on start and every 60 s; the queue
resumes after a restart; graceful shutdown. Gaps: no PayPal webhooks, so a refund or dispute
made in the PayPal dashboard is only noticed when the merchant next approves on that payment;
retention cleanup is a manual script.

**Data.** SQLite in WAL mode with `synchronous=NORMAL` and a 5 s busy timeout, now indexed. Daily
`VACUUM INTO` copies on the same disk, plus Render's own disk snapshots. Gaps: no off-machine copy
and no restore drill yet.

**Observability.** Request logs, request IDs and a health check. Gaps: no metrics or alerts, in
particular none for a refund stuck in `UNKNOWN`, the one state that needs a person.

**Capacity.** One 4-core instance handled 40 simultaneous claims (browser-shrunk photos) with every
proposal ready within 5.4 s; the queue, not the CPU, set the pace. The real ceiling is Jev's
concurrency and rate limit, which TypeSafe has not published; `JEV_CONCURRENCY` should be raised
only after asking them. A persistent disk pins Render to one instance, so scaling out means
Postgres and object storage first (P2 below).

## Roadmap

### P0: before the 12 November deadline

1. Deploy with `render.yaml`, set the secrets, open `/healthz`, and run `scripts/e2e-sandbox.js`
   against the hosted URL.
2. Rerun `npm run probe` to confirm the 1024 px model copy matches the Gate 2 results.
3. Decide judge access (sandbox buyer login, merchant password, `REPEAT_CLAIM_LIMIT=0`).
4. Record the video. A 20-photo claim with "looked at the 8 clearest of 20 photos" is a good
   scale beat.

### P1: product, next

1. **Show where the damage is.** Jev can return bounding boxes (`box()`); draw them on the
   merchant's photos. Highest demo value for the least work.
2. **Second look for large photo sets.** When Jev's 8 photos are inconclusive, review the next
   8 and say which photo showed the damage. Never let more batches only add reasons to pay: an
   attacker could send 100 photos hoping for one false positive.
3. **PayPal webhooks** for refunds and disputes (`PAYMENT.CAPTURE.REFUNDED`,
   `CUSTOMER.DISPUTE.CREATED`), verified with PayPal's signature check, instead of polling.
4. **Merchant accounts:** one login per staff member, roles, and Log In with PayPal or a second
   factor. The audit trail already records an actor.
5. **Inbox paging and filters** in the UI (the API already pages).
6. **Buyer notifications** by email when the status changes.
7. **Scheduled retention cleanup** inside the server, like backups.
8. **Content Security Policy:** move inline scripts into files, then add a strict policy.

### P2: scale out and become a service

1. Postgres for data and object storage (S3 or R2) for photos with signed URLs, so the app can run
   on several instances without a disk.
2. A durable job queue (pg-boss or similar) in place of the in-process one.
3. Multiple merchants onboarded through PayPal's partner referrals, with per-merchant policy.
4. Metrics and alerts (OpenTelemetry, Sentry): Jev latency and errors, queue depth, refunds stuck
   in `UNKNOWN`.
5. Cache Jev answers by photo fingerprints, so re-running an unchanged case costs nothing.
6. More currencies and a real product catalog.
