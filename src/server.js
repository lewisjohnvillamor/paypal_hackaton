import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as paypal from "./paypal/client.js";
import { backup, openDb } from "./db.js";
import { assessEvidence } from "./ai/jev.js";
import { IMAGE_CONCURRENCY, ImageRejected, MAX_PHOTOS, MAX_UPLOAD_BYTES, mapLimit, normalizeImage } from "./images.js";
import { checkMerchantPassword, clearSession, issueSession, requireMerchant, tokenMatches } from "./auth.js";
import { OrderError, captureOrder, startOrder } from "./orders.js";
import { ClaimError, addEvidence, assessClaim, closeClaim, createClaim, requestInfo, uploadDir } from "./claims.js";
import { GateError, approveAndReserve, checkPayPalLedger, reconcile, reconcileOpen, submit } from "./refunds/execute.js";
import { caseDetail, inbox, buyerStatus } from "./views.js";
import { assessmentQueue } from "./queue.js";

// Whole multipart request: 100 photos already shrunk by the browser fit with lots of room.
const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_MB || 300) * 1024 * 1024;
const started = Date.now();

export function createApp({ db = openDb(), pp = paypal, assess = assessEvidence, queue = assessmentQueue(db, assess) } = {}) {
  const app = express();
  app.disable("x-powered-by");
  // Behind Render's (or any) load balancer, req.ip is the proxy unless we trust its X-Forwarded-For;
  // without this every buyer shares one rate-limit bucket.
  if (process.env.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    req.id = req.get("X-Request-Id")?.slice(0, 64) || randomUUID();
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Request-Id": req.id });
    if (process.env.APP_BASE_URL?.startsWith("https://")) res.set("Strict-Transport-Security", "max-age=15552000");
    if (process.env.LOG_REQUESTS !== "0" && req.path.startsWith("/api/")) {
      const t = process.hrtime.bigint();
      res.on("finish", () => console.log(JSON.stringify({
        at: new Date().toISOString(), id: req.id, method: req.method, path: req.route?.path ? req.baseUrl + req.route.path : req.originalUrl.split("?")[0],
        status: res.statusCode, ms: Number((process.hrtime.bigint() - t) / 1000000n), files: req.files?.length,
      })));
    }
    next();
  });
  app.use(express.static(new URL("../public", import.meta.url).pathname, { extensions: ["html"] }));

  app.get("/healthz", (_req, res) => {
    try {
      db.prepare("SELECT 1").get();
      res.json({ ok: true, uptimeS: Math.round((Date.now() - started) / 1000), queue: queue.stats(), rssMB: Math.round(process.memoryUsage().rss / 1e6) });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  // Uploads stream to a temp folder instead of memory: 100 phone photos would otherwise sit in RAM
  // (up to 1.5 GB per request at the per-file cap) while they are processed.
  const incoming = join(tmpdir(), "refund-relay-incoming");
  mkdirSync(incoming, { recursive: true });
  const upload = multer({ dest: incoming, limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_PHOTOS, fields: 10 } });
  const receive = upload.array("photos", MAX_PHOTOS);
  const photos = (req, res, next) => {
    if (Number(req.get("Content-Length") || 0) > MAX_REQUEST_BYTES) {
      return res.status(413).json({ error: "UPLOAD_REJECTED", message: "These photos are too large to send together. Send fewer at a time." });
    }
    // Temp files are removed whatever happens to the request.
    res.on("close", () => { for (const f of req.files ?? []) rm(f.path, { force: true }).catch(() => {}); });
    receive(req, res, next);
  };
  // Validate and shrink every photo (a few at a time) before anything is created.
  const normalizeAll = (files) => mapLimit(files, IMAGE_CONCURRENCY, (f) => normalizeImage(f.path));

  // Small in-memory limiter for buyer submissions (single instance). Old entries are swept so a
  // stream of distinct IPs cannot grow the map without bound.
  const hits = new Map();
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (t - v[v.length - 1] > 3600e3) hits.delete(k);
  }, 600e3).unref();
  const limit = (max, windowMs) => (req, res, next) => {
    const key = `${req.path}|${req.ip}`;
    const t = Date.now();
    const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (recent.length >= max) return res.status(429).json({ error: "RATE_LIMITED", message: "Too many attempts. Try again in a minute." });
    hits.set(key, [...recent, t]);
    next();
  };

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    if (err instanceof GateError || err instanceof ClaimError || err instanceof OrderError || err instanceof ImageRejected) {
      const status = err.status || ({ CAPTURE_NOT_REFUNDABLE: 409, EXTERNAL_REFUND_DETECTED: 409, NOT_FOUND: 404, STALE_CASE: 409, REFUND_IN_PROGRESS: 409, NOT_READY: 409 }[err.code] ?? 400);
      return res.status(status).json({ error: err.code || "IMAGE_REJECTED", message: err.message, debugId: err.debugId });
    }
    if (err instanceof multer.MulterError) return res.status(400).json({ error: "UPLOAD_REJECTED", message: err.message });
    console.error(JSON.stringify({ at: new Date().toISOString(), id: req.id, error: err.message, stack: err.stack }));
    res.status(500).json({ error: "INTERNAL", message: "Something went wrong." });
  });

  // ---- Demo purchase -------------------------------------------------------------------------
  app.get("/api/config", (_req, res) => res.json({ clientId: process.env.PAYPAL_CLIENT_ID }));

  app.post("/api/demo/orders", limit(10, 60e3), wrap(async (_req, res) => {
    res.status(201).json(await startOrder(db, pp));
  }));

  app.post("/api/demo/orders/:paypalOrderId/capture", wrap(async (req, res) => {
    const { order, claimToken, alreadyCaptured } = await captureOrder(db, pp, req.params.paypalOrderId);
    res.json({
      orderId: order.id, captureId: order.capture_id, amount: order.amount_cents, alreadyCaptured,
      claimUrl: claimToken ? `/claim?order=${order.id}#t=${claimToken}` : null,
    });
  }));

  // ---- Buyer ---------------------------------------------------------------------------------
  function orderForClaimToken(req) {
    const orderId = req.params.orderId || req.body.orderId;
    const link = db.prepare("SELECT * FROM claim_links WHERE order_id = ?").get(orderId);
    if (!link || !tokenMatches(req.get("X-Claim-Token"), link.token_hash) || link.expires_at < new Date().toISOString()) {
      throw new ClaimError("LINK_INVALID", "This claim link is invalid or has expired.", 403);
    }
    return db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  }

  app.get("/api/claim-link/:orderId", wrap(async (req, res) => {
    const order = orderForClaimToken(req);
    const lines = db.prepare("SELECT id, title, quantity, unit_cents, ref_image FROM order_lines WHERE order_id = ?").all(order.id);
    const open = db.prepare("SELECT id, ref FROM claims WHERE order_id = ? AND status NOT IN ('closed','refunded')").get(order.id);
    res.json({ orderId: order.id, amountCents: order.amount_cents, capturedAt: order.delivered_at, lines, openClaimRef: open?.ref ?? null });
  }));

  app.post("/api/claims", limit(5, 60e3), photos, wrap(async (req, res) => {
    const order = orderForClaimToken(req);
    if (!req.files?.length) throw new ClaimError("PHOTOS_REQUIRED", "Add at least one photo of the damage.");
    const images = await normalizeAll(req.files); // reject before creating anything
    const { claim, token } = createClaim(db, {
      orderId: order.id, lineId: req.body.lineId, quantity: Number(req.body.quantity), statement: req.body.statement,
    });
    await addEvidence(db, claim.id, images);
    queue.enqueue(claim.id); // the buyer gets an answer now; Jev runs in the queue
    res.status(201).json({ ref: claim.ref, claimId: claim.id, statusUrl: `/status?claim=${claim.id}#t=${token}` });
  }));

  function claimForStatusToken(req) {
    const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(req.params.id);
    if (!claim || !tokenMatches(req.get("X-Claim-Token"), claim.token_hash) || claim.token_expires_at < new Date().toISOString()) {
      throw new ClaimError("LINK_INVALID", "This status link is invalid or has expired.", 403);
    }
    return claim;
  }

  app.get("/api/claims/:id/status", wrap(async (req, res) => {
    res.json(buyerStatus(db, claimForStatusToken(req)));
  }));

  app.post("/api/claims/:id/evidence", limit(5, 60e3), photos, wrap(async (req, res) => {
    const claim = claimForStatusToken(req);
    if (claim.status !== "needs_info") throw new ClaimError("INVALID_STATE", "The merchant has not asked for more photos.", 409);
    if (!req.files?.length) throw new ClaimError("PHOTOS_REQUIRED", "Add at least one photo.");
    const images = await normalizeAll(req.files);
    await addEvidence(db, claim.id, images);
    queue.enqueue(claim.id);
    res.json(buyerStatus(db, db.prepare("SELECT * FROM claims WHERE id = ?").get(claim.id)));
  }));

  // ---- Merchant ------------------------------------------------------------------------------
  app.post("/api/merchant/login", limit(10, 60e3), (req, res) => {
    if (!checkMerchantPassword(req.body?.password ?? "")) return res.status(401).json({ error: "BAD_PASSWORD", message: "Wrong password." });
    issueSession(res);
    res.json({ ok: true });
  });
  app.post("/api/merchant/logout", (_req, res) => { clearSession(res); res.json({ ok: true }); });

  const m = express.Router();
  m.use(requireMerchant);
  m.get("/me", (_req, res) => res.json({ actor: "merchant" }));
  m.get("/claims", (req, res) => res.json(inbox(db, { limit: req.query.limit, before: req.query.before })));
  m.get("/claims/:id", wrap(async (req, res) => {
    const detail = caseDetail(db, req.params.id);
    if (!detail) throw new ClaimError("NOT_FOUND", "No such request.", 404);
    res.json(detail);
  }));
  m.get("/evidence/:id", wrap(async (req, res) => {
    const e = db.prepare("SELECT * FROM evidence WHERE id = ?").get(req.params.id);
    if (!e) throw new ClaimError("NOT_FOUND", "No such photo.", 404);
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "Content-Disposition": "inline" });
    res.sendFile(resolve(uploadDir(), e.storage_key), { cacheControl: false, lastModified: false });
  }));
  m.post("/claims/:id/assess", wrap(async (req, res) => {
    await assessClaim(db, req.params.id, assess, req.actor);
    res.json(caseDetail(db, req.params.id));
  }));
  m.post("/claims/:id/request-info", wrap(async (req, res) => {
    requestInfo(db, req.params.id, req.body.message, req.actor);
    res.json(caseDetail(db, req.params.id));
  }));
  m.post("/claims/:id/close", wrap(async (req, res) => {
    closeClaim(db, req.params.id, req.body.reason, req.actor);
    res.json(caseDetail(db, req.params.id));
  }));
  m.post("/claims/:id/approve-refund", wrap(async (req, res) => {
    const { claimVersion, proposalId, amountCents, reason } = req.body;
    await checkPayPalLedger(db, pp, req.params.id);
    const { op, duplicate } = approveAndReserve(db, {
      claimId: req.params.id, claimVersion: Number(claimVersion), proposalId, amountCents: Number(amountCents), reason, actor: req.actor,
    });
    // A duplicate click never submits again; it reports the operation that already exists.
    if (!duplicate) await submit(db, pp, op, req.actor);
    res.status(duplicate ? 409 : 200).json({ duplicate, ...caseDetail(db, req.params.id) });
  }));
  m.post("/refunds/:id/reconcile", wrap(async (req, res) => {
    const op = await reconcile(db, pp, req.params.id, req.actor);
    res.json(caseDetail(db, op.claim_id));
  }));
  app.use("/api/merchant", m);

  app.use("/api", (_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  // Upload limits (too many files, file too large) fail inside multer, before any route handler.
  app.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError) {
      const message = { LIMIT_FILE_COUNT: `Up to ${MAX_PHOTOS} photos per request.`, LIMIT_FILE_SIZE: `Each photo must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller.` }[err.code] || err.message;
      return res.status(400).json({ error: "UPLOAD_REJECTED", message });
    }
    next(err);
  });
  return { app, db, queue };
}

// Fail at boot, not on the first buyer, when configuration is missing.
export function checkConfig(env = process.env) {
  const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "TYPESAFE_API_KEY", "MERCHANT_PASSWORD", "SESSION_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
  if (env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be 32+ characters");
  if (env.MERCHANT_PASSWORD.length < 12 && env.NODE_ENV === "production") throw new Error("MERCHANT_PASSWORD must be 12+ characters in production");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkConfig();
  const { app, db, queue } = createApp();
  // Resume reconciliation of refunds that were in flight when the server last stopped, and any
  // claims that were waiting for assessment.
  reconcileOpen(db, paypal).then((n) => n && console.log(`Reconciled ${n} open refund operation(s)`));
  const waiting = queue.resume();
  if (waiting) console.log(`Resumed assessment of ${waiting} claim(s)`);
  setInterval(() => reconcileOpen(db, paypal).catch(() => {}), 60_000).unref();
  // Hosts like Render cannot attach a web service's disk to a separate cron job, so the server
  // backs itself up when asked to.
  const backupHours = Number(process.env.BACKUP_INTERVAL_HOURS || 0);
  if (backupHours > 0) {
    setInterval(() => {
      try { console.log(JSON.stringify({ at: new Date().toISOString(), backup: backup(db) })); }
      catch (err) { console.error(JSON.stringify({ at: new Date().toISOString(), backupError: err.message })); }
    }, backupHours * 3600e3).unref();
  }
  const port = Number(process.env.PORT || 8888);
  const server = app.listen(port, () => console.log(`Refund Relay on http://localhost:${port}`));
  // Render (and most hosts) send SIGTERM on deploy: stop taking requests, let running
  // assessments and refund calls finish (bounded), checkpoint the WAL, exit.
  const shutdown = async (signal) => {
    console.log(`${signal}: shutting down`);
    const closed = new Promise((r) => server.close(r)); // waits for in-flight requests, e.g. a refund call
    await Promise.race([Promise.all([closed, queue.idle()]), new Promise((r) => setTimeout(r, 15_000))]);
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); } catch {}
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
