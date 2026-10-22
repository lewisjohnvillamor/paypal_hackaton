import express from "express";
import multer from "multer";
import * as paypal from "./paypal/client.js";
import { openDb } from "./db.js";
import { assessEvidence } from "./ai/jev.js";
import { ImageRejected, MAX_PHOTOS, MAX_UPLOAD_BYTES, normalizeImage } from "./images.js";
import { checkMerchantPassword, clearSession, issueSession, requireMerchant, tokenMatches } from "./auth.js";
import { OrderError, captureOrder, startOrder } from "./orders.js";
import { ClaimError, addEvidence, assessClaim, closeClaim, createClaim, readEvidence, requestInfo } from "./claims.js";
import { GateError, approveAndReserve, checkPayPalLedger, reconcile, reconcileOpen, submit } from "./refunds/execute.js";
import { caseDetail, inbox, buyerStatus } from "./views.js";

export function createApp({ db = openDb(), pp = paypal, assess = assessEvidence } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    next();
  });
  app.use(express.static(new URL("../public", import.meta.url).pathname, { extensions: ["html"] }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_PHOTOS, fields: 10 } });
  const photos = upload.array("photos", MAX_PHOTOS);

  // Small in-memory limiter for buyer submissions (single-instance demo).
  const hits = new Map();
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
    console.error(err);
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
    const images = [];
    for (const f of req.files) images.push(await normalizeImage(f.buffer)); // reject before creating anything
    const { claim, token } = createClaim(db, {
      orderId: order.id, lineId: req.body.lineId, quantity: Number(req.body.quantity), statement: req.body.statement,
    });
    addEvidence(db, claim.id, images);
    await assessClaim(db, claim.id, assess).catch((err) => console.error("assessment", err.message));
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
    const images = [];
    for (const f of req.files) images.push(await normalizeImage(f.buffer));
    addEvidence(db, claim.id, images);
    await assessClaim(db, claim.id, assess).catch((err) => console.error("assessment", err.message));
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
  m.get("/claims", (_req, res) => res.json(inbox(db)));
  m.get("/claims/:id", wrap(async (req, res) => {
    const detail = caseDetail(db, req.params.id);
    if (!detail) throw new ClaimError("NOT_FOUND", "No such request.", 404);
    res.json(detail);
  }));
  m.get("/evidence/:id", wrap(async (req, res) => {
    const e = db.prepare("SELECT * FROM evidence WHERE id = ?").get(req.params.id);
    if (!e) throw new ClaimError("NOT_FOUND", "No such photo.", 404);
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "Content-Disposition": "inline" });
    res.send(readEvidence(e.storage_key));
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
      const message = { LIMIT_FILE_COUNT: `Up to ${MAX_PHOTOS} photos per request.`, LIMIT_FILE_SIZE: "Each photo must be 5 MB or smaller." }[err.code] || err.message;
      return res.status(400).json({ error: "UPLOAD_REJECTED", message });
    }
    next(err);
  });
  return { app, db };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, db } = createApp();
  // Resume reconciliation of refunds that were in flight when the server last stopped.
  reconcileOpen(db, paypal).then((n) => n && console.log(`Reconciled ${n} open refund operation(s)`));
  setInterval(() => reconcileOpen(db, paypal).catch(() => {}), 60_000).unref();
  const port = Number(process.env.PORT || 8888);
  app.listen(port, () => console.log(`Refund Relay on http://localhost:${port}`));
}
