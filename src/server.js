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
import { storeStats } from "./stats.js";
import { paymentDisputes } from "./disputes.js";
import { acceptOffer, sendOffer, withdrawOffer } from "./offers.js";
import { createRemedy, remedyLibrary, seedRemedies, updateRemedy } from "./remedies.js";
import { defaultMatcher, defaultRuleParser, defaultSuggester } from "./ai/haiku.js";
import { activeMandate, agentSpent, replay, runAgent, saveMandate, seedDemoMandate, stopMandate, storeCatalog, unseenByAgent } from "./agent/autopilot.js";
import { RuleError, checkRules, damageChoices, describeRules, ruleVocabulary } from "./agent/rules.js";
import { decideSuggestion } from "./suggest/suggestions.js";
import { assessmentQueue } from "./queue.js";
import { PRODUCTS } from "./catalog.js";
import { DEFAULT_POLICY, PolicyError, currentPolicy, savePolicy, severityTable } from "./policy/settings.js";
import { POLICY_VERSION } from "./policy/refundPolicy.js";
import { AccountError, DEMO, ensureDemoMerchant, getMerchant, merchantClients, routedPayPal } from "./merchants/accounts.js";
import { platformRoutes } from "./merchants/routes.js";
import { RegisterError, catalogPhotoPath, fetchCatalogImage } from "./merchants/register.js";

// Whole multipart request: 100 photos already shrunk by the browser fit with lots of room.
const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_MB || 300) * 1024 * 1024;
const started = Date.now();

// pp is the demo store's PayPal client; paypalFor(credentials) makes one for a connected merchant.
// Every refund, ledger check and reconciliation goes through `pay`, which picks the account the
// order was paid to.
export function createApp({ db = openDb(), pp = paypal, paypalFor = paypal.paypalClient, fetchImage = fetchCatalogImage, assess = assessEvidence,
  suggest = defaultSuggester(), match = defaultMatcher(), parseRules = defaultRuleParser(), queue = null, retryDelays } = {}) {
  seedRemedies(db);
  ensureDemoMerchant(db);
  const clientFor = merchantClients(db, pp, paypalFor);
  const pay = routedPayPal(db, pp, clientFor);
  queue ??= assessmentQueue(db, assess, { suggest, match, retryDelays, after: (claimId) => runAgent(db, pay, claimId) });
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
  // Connected stores' catalog photos, stored when the order was registered (src/merchants/register.js).
  app.get("/assets/m/:file", (req, res) => {
    if (!/^[0-9a-f]{64}\.jpg$/.test(req.params.file)) return res.status(404).end();
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400, immutable" });
    res.sendFile(resolve(catalogPhotoPath(req.params.file)), { cacheControl: false, lastModified: false }, (err) => err && !res.headersSent && res.status(404).end());
  });

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
    if (err instanceof GateError || err instanceof ClaimError || err instanceof OrderError || err instanceof ImageRejected || err instanceof RuleError || err instanceof PolicyError
      || err instanceof AccountError || err instanceof RegisterError) {
      const status = err.status || ({ CAPTURE_NOT_REFUNDABLE: 409, EXTERNAL_REFUND_DETECTED: 409, NOT_FOUND: 404, STALE_CASE: 409, REFUND_IN_PROGRESS: 409, NOT_READY: 409, NO_OPTIONS: 409, TOO_MANY_REMEDIES: 409 }[err.code] ?? 400);
      return res.status(status).json({ error: err.code || "IMAGE_REJECTED", message: err.message, debugId: err.debugId });
    }
    if (err instanceof multer.MulterError) return res.status(400).json({ error: "UPLOAD_REJECTED", message: err.message });
    console.error(JSON.stringify({ at: new Date().toISOString(), id: req.id, error: err.message, stack: err.stack }));
    res.status(500).json({ error: "INTERNAL", message: "Something went wrong." });
  });

  // ---- Demo purchase -------------------------------------------------------------------------
  app.get("/api/config", (_req, res) => res.json({ clientId: process.env.PAYPAL_CLIENT_ID, demo: publicDemo() }));

  app.get("/api/products", (_req, res) => res.json(Object.values(PRODUCTS).map((p) => ({
    sku: p.sku, title: p.title, unitCents: p.unitCents, category: p.category, image: `/assets/${p.refImage}`, blurb: p.blurb ?? "",
  }))));

  // Body { items: [{ sku, quantity }] }; an empty body buys the default demo cart.
  app.post("/api/demo/orders", limit(10, 60e3), wrap(async (req, res) => {
    res.status(201).json(await startOrder(db, pay, req.body?.items));
  }));

  app.post("/api/demo/orders/:paypalOrderId/capture", limit(20, 60e3), wrap(async (req, res) => {
    const { order, claimToken, alreadyCaptured } = await captureOrder(db, pay, req.params.paypalOrderId);
    res.json({
      orderId: order.id, captureId: order.capture_id, amount: order.amount_cents, alreadyCaptured,
      claimUrl: claimToken ? `/claim?order=${order.id}#t=${claimToken}` : null,
      lines: db.prepare("SELECT id, sku, title, quantity, unit_cents unitCents, ref_image image FROM order_lines WHERE order_id = ?").all(order.id),
    });
  }));

  // ---- Buyer ---------------------------------------------------------------------------------
  function orderForClaimToken(req) {
    const orderId = req.params.orderId || req.body.orderId;
    const link = db.prepare("SELECT * FROM claim_links WHERE order_id = ?").get(orderId);
    const order = link && db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    // The link lasts at least as long as the store's reporting window, which the merchant may set
    // longer than the link's own 14 days.
    const windowMs = Date.parse(order?.delivered_at) + (order ? currentPolicy(db, order.merchant_id).claimWindowDays : 0) * 86400e3;
    const until = Math.max(Date.parse(link?.expires_at), Number.isFinite(windowMs) ? windowMs : 0);
    if (!link || !order || !tokenMatches(req.get("X-Claim-Token"), link.token_hash) || !(until >= Date.now())) {
      throw new ClaimError("LINK_INVALID", "This claim link is invalid or has expired.", 403);
    }
    return order;
  }

  app.get("/api/claim-link/:orderId", wrap(async (req, res) => {
    const order = orderForClaimToken(req);
    const lines = db.prepare("SELECT id, title, quantity, unit_cents, ref_image FROM order_lines WHERE order_id = ?").all(order.id);
    const open = db.prepare("SELECT id, ref FROM claims WHERE order_id = ? AND status NOT IN ('closed','refunded','resolved')").get(order.id);
    res.json({ orderId: order.id, amountCents: order.amount_cents, capturedAt: order.delivered_at, lines, openClaimRef: open?.ref ?? null,
      store: { name: getMerchant(db, order.merchant_id)?.name ?? null, demo: order.merchant_id === DEMO } });
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

  // The buyer picks one of the options the merchant approved; the pick is the refund.
  app.post("/api/claims/:id/choose", limit(10, 60e3), wrap(async (req, res) => {
    const claim = claimForStatusToken(req);
    // PayPal is asked first only when the pick moves money; a replacement settles without it.
    const open = db.prepare("SELECT options_json FROM offers WHERE id = ? AND claim_id = ? AND status = 'open' AND decided_at IS NULL").get(String(req.body.offerId || ""), claim.id);
    const picked = open && JSON.parse(open.options_json).find((o) => o.id === String(req.body.optionId || ""));
    // The refund gate's messages are written for the merchant ("Reconnect PayPal", "Reconcile it");
    // the buyer is told what it means for them, and the code stays the same.
    const forBuyer = (err) => {
      if (err instanceof GateError && BUYER_GATE[err.code]) throw Object.assign(new GateError(err.code, BUYER_GATE[err.code]), { status: err.status });
      throw err;
    };
    if (!picked || picked.refundCents > 0) await checkPayPalLedger(db, pay, claim.id).catch(forBuyer);
    let accepted;
    try {
      accepted = acceptOffer(db, { claimId: claim.id, offerId: String(req.body.offerId || ""), optionId: String(req.body.optionId || "") });
    } catch (err) { forBuyer(err); }
    const { op, duplicate } = accepted;
    if (op && !duplicate) await submit(db, pay, op, "buyer").catch((err) => { if (err.code !== "PAYPAL_NOT_CONNECTED") throw err; });
    res.json(buyerStatus(db, db.prepare("SELECT * FROM claims WHERE id = ?").get(claim.id)));
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
    issueSession(res, DEMO);
    res.json({ ok: true });
  });
  app.post("/api/merchant/logout", (_req, res) => { clearSession(res); res.json({ ok: true }); });

  const m = express.Router();
  m.use(requireMerchant);
  // A merchant only ever sees and acts on requests from their own orders.
  const ownClaim = (req, id) => db.prepare("SELECT 1 FROM claims c JOIN orders o ON o.id = c.order_id WHERE c.id = ? AND o.merchant_id = ?").get(id, req.merchantId);
  m.param("id", (req, res, next, id) => {
    if (req.path.startsWith("/claims/") && !ownClaim(req, id)) return res.status(404).json({ error: "NOT_FOUND", message: "No such request." });
    if (req.path.startsWith("/refunds/") && !db.prepare("SELECT 1 FROM refund_ops r JOIN orders o ON o.id = r.order_id WHERE r.id = ? AND o.merchant_id = ?").get(id, req.merchantId)) {
      return res.status(404).json({ error: "NOT_FOUND", message: "No such refund." });
    }
    if (req.path.startsWith("/evidence/") && !db.prepare("SELECT 1 FROM evidence e JOIN claims c ON c.id = e.claim_id JOIN orders o ON o.id = c.order_id WHERE e.id = ? AND o.merchant_id = ?").get(id, req.merchantId)) {
      return res.status(404).json({ error: "NOT_FOUND", message: "No such photo." });
    }
    next();
  });
  // The remedy library works on the demo store's catalog, so far.
  const demoOnly = (req, res, next) => req.merchantId === DEMO ? next()
    : res.status(404).json({ error: "DEMO_STORE_ONLY", message: "The remedy library is coming to connected stores soon." });
  m.get("/me", (req, res) => {
    const me = getMerchant(db, req.merchantId);
    res.json({ actor: "merchant", merchant: { id: me?.id, name: me?.name }, demo: req.merchantId === DEMO });
  });
  m.get("/claims", (req, res) => res.json(inbox(db, { limit: req.query.limit, before: req.query.before, merchantId: req.merchantId })));
  m.get("/stats", (req, res) => res.json(storeStats(db, req.merchantId)));
  m.get("/claims/:id", wrap(async (req, res) => {
    const detail = caseDetail(db, req.params.id);
    if (!detail) throw new ClaimError("NOT_FOUND", "No such request.", 404);
    res.json(detail);
  }));
  // Disputes the buyer opened in PayPal on this payment, read live. Shown next to the payment; a
  // failure to ask PayPal is reported as such, never as "no disputes".
  m.get("/claims/:id/disputes", wrap(async (req, res) => {
    const { capture_id: captureId } = db.prepare("SELECT o.capture_id FROM claims c JOIN orders o ON o.id = c.order_id WHERE c.id = ?").get(req.params.id);
    try {
      res.json({ disputes: await paymentDisputes(pay, captureId), checkedAt: new Date().toISOString() });
    } catch (err) {
      res.json({ disputes: null, error: err.code === "PAYPAL_NOT_CONNECTED" ? "PayPal is not connected." : "PayPal did not answer just now." });
    }
  }));
  m.get("/evidence/:id", wrap(async (req, res) => {
    const e = db.prepare("SELECT * FROM evidence WHERE id = ?").get(req.params.id);
    if (!e) throw new ClaimError("NOT_FOUND", "No such photo.", 404);
    // A photo never changes under its id, so the browser may keep it: redraws don't refetch or flicker.
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400, immutable", "Content-Disposition": "inline" });
    res.sendFile(resolve(uploadDir(), e.storage_key), { cacheControl: false, lastModified: false });
  }));
  m.post("/claims/:id/assess", wrap(async (req, res) => {
    await assessClaim(db, req.params.id, assess, req.actor, suggest, match);
    res.json(caseDetail(db, req.params.id));
  }));
  // The merchant approves or dismisses one of Claude Haiku's suggestions for this case.
  m.post("/claims/:id/suggestions/:sid", wrap(async (req, res) => {
    decideSuggestion(db, { claimId: req.params.id, suggestionId: req.params.sid, approve: req.body.approve === true, actor: req.actor });
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
    await checkPayPalLedger(db, pay, req.params.id);
    const { op, duplicate } = approveAndReserve(db, {
      claimId: req.params.id, claimVersion: Number(claimVersion), proposalId, amountCents: Number(amountCents), reason, actor: req.actor,
    });
    // A duplicate click never submits again; it reports the operation that already exists.
    if (!duplicate) await submit(db, pay, op, req.actor);
    res.status(duplicate ? 409 : 200).json({ duplicate, ...caseDetail(db, req.params.id) });
  }));
  m.post("/claims/:id/send-offer", wrap(async (req, res) => {
    const { claimVersion, proposalId, reason } = req.body;
    sendOffer(db, { claimId: req.params.id, claimVersion: Number(claimVersion), proposalId, reason, actor: req.actor });
    res.json(caseDetail(db, req.params.id));
  }));
  m.post("/claims/:id/withdraw-offer", wrap(async (req, res) => {
    withdrawOffer(db, { claimId: req.params.id, actor: req.actor });
    res.json(caseDetail(db, req.params.id));
  }));
  m.get("/remedies", demoOnly, (_req, res) => res.json(remedyLibrary(db)));
  m.post("/remedies", demoOnly, wrap(async (req, res) => res.status(201).json(createRemedy(db, req.body))));
  m.patch("/remedies/:id", demoOnly, wrap(async (req, res) => res.json(updateRemedy(db, req.params.id, req.body))));
  // ---- The refund policy: severity table, limits and how sure the photo check must be ----
  const policyView = (merchantId) => {
    const policy = currentPolicy(db, merchantId);
    // Only the damage types the store's products can have are shown (a mug shop has no torn ear
    // cushions); the others keep their values and are saved unchanged.
    const sold = damageChoices(undefined, storeCatalog(db, merchantId));
    const severity = severityTable(policy).map((r) => ({ ...r, sold: r.kind in sold }));
    return { version: POLICY_VERSION, policy, defaults: DEFAULT_POLICY, severity, spentCents: agentSpent(db, merchantId) };
  };
  m.get("/policy", (req, res) => res.json(policyView(req.merchantId)));
  // New settings apply to reviews from now on; cases already reviewed keep the decision they got.
  m.put("/policy", wrap(async (req, res) => {
    savePolicy(db, req.body ?? {}, req.actor, req.merchantId);
    res.json(policyView(req.merchantId));
  }));
  // ---- The refund agent's rules ----
  // What is on, what the agent did lately, and what it has sent in the last 24 hours. Every store
  // has its own agent, rules and daily total.
  m.get("/agent", (req, res) => {
    const recent = db.prepare(`SELECT a.type, a.payload, a.at, c.id claim_id, c.ref, c.status, l.title FROM audit a
      JOIN claims c ON c.id = a.claim_id JOIN order_lines l ON l.id = c.line_id JOIN orders o ON o.id = c.order_id
      WHERE a.type IN ('agent.acted', 'agent.left_for_merchant') AND o.merchant_id = ? ORDER BY a.id DESC LIMIT 20`).all(req.merchantId)
      .map((r) => ({ ...JSON.parse(r.payload), acted: r.type === "agent.acted", at: r.at, claimId: r.claim_id, ref: r.ref, status: r.status, title: r.title }));
    res.json({ mandate: activeMandate(db, req.merchantId), spentCents: agentSpent(db, req.merchantId),
      policyDailyCents: currentPolicy(db, req.merchantId).dailyAutoRefundCents, recent, canWrite: !!parseRules, demo: req.merchantId === DEMO });
  });
  // Plain English in, checked rules and their read-back out. Nothing is turned on here.
  m.post("/agent/preview", limit(20, 60e3), wrap(async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (text.length < 8 || text.length > 1000) throw new RuleError("Write your rules in 8 to 1000 characters.");
    if (!parseRules) throw Object.assign(new RuleError("Writing rules in plain English needs the AI, which is off on this server."), { status: 503 });
    const products = storeCatalog(db, req.merchantId);
    let parsed;
    try {
      parsed = await parseRules({ text, ...ruleVocabulary(products) });
    } catch (err) {
      throw Object.assign(new RuleError(`The AI could not read those rules (${String(err.message).slice(0, 120)}). Try again.`), { status: 502 });
    }
    let checked;
    try {
      checked = checkRules(parsed, products);
    } catch (err) {
      if (err instanceof RuleError && parsed.notUnderstood) err.message += ` The AI said: ${parsed.notUnderstood}`;
      throw err;
    }
    res.json({ text, ...checked, readback: describeRules(checked, products), notUnderstood: parsed.notUnderstood || null, model: parsed.model, replay: replay(db, checked, { merchantId: req.merchantId }) });
  }));
  m.post("/agent", wrap(async (req, res) => {
    res.json(saveMandate(db, { text: req.body?.text, rules: req.body?.rules, model: req.body?.model ?? null, actor: req.actor, merchantId: req.merchantId }));
  }));
  m.delete("/agent", (req, res) => { stopMandate(db, req.actor, req.merchantId); res.json({ mandate: null }); });
  m.post("/refunds/:id/reconcile", wrap(async (req, res) => {
    const op = await reconcile(db, pay, req.params.id, req.actor);
    res.json(caseDetail(db, op.claim_id));
  }));
  app.use("/api/merchant", m);
  // Sign-up, PayPal connection, API keys (/api/dashboard) and the store API (/v1).
  platformRoutes(app, { db, clientFor, paypalFor, fetchImage, limit, wrap });

  app.use("/api", (_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  // Upload limits (too many files, file too large) fail inside multer, before any route handler.
  app.use((err, _req, res, next) => {
    if (err instanceof multer.MulterError) {
      const message = { LIMIT_FILE_COUNT: `Up to ${MAX_PHOTOS} photos per request.`, LIMIT_FILE_SIZE: `Each photo must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller.` }[err.code] || err.message;
      return res.status(400).json({ error: "UPLOAD_REJECTED", message });
    }
    next(err);
  });
  return { app, db, queue, pay };
}

// What a buyer reads when the refund gate stops their pick. Nothing was refunded in any of these.
const SHOP_FIXING = "The shop needs to sort something out with PayPal before this refund can go out. Nothing was refunded yet; your choice is still open, so try again later.";
const BUYER_GATE = {
  PAYPAL_NOT_CONNECTED: SHOP_FIXING, ORDER_NOT_ON_ACCOUNT: SHOP_FIXING, EXTERNAL_REFUND_DETECTED: SHOP_FIXING, CAPTURE_NOT_FOUND: SHOP_FIXING,
  REFUND_IN_PROGRESS: "A refund on this order is still being processed. Nothing more was refunded; try again in a few minutes.",
  CAPTURE_NOT_REFUNDABLE: "PayPal no longer lets this payment be refunded here. Contact the shop about your order.",
  INSUFFICIENT_REFUNDABLE_BALANCE: "This order doesn't have enough left to refund for that choice. Contact the shop about your order.",
};

// A hosted demo for judges can print its sandbox sign-ins on the store and merchant pages. Off
// unless PUBLIC_DEMO=1, and only ever for the sandbox (the PayPal client refuses live mode).
export function publicDemo(env = process.env) {
  if (env.PUBLIC_DEMO !== "1") return null;
  return {
    merchantPassword: env.MERCHANT_PASSWORD,
    buyerEmail: env.DEMO_BUYER_EMAIL || null,
    buyerPassword: env.DEMO_BUYER_PASSWORD || null,
  };
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
  const { app, db, queue, pay } = createApp();
  if (publicDemo() && seedDemoMandate(db)) console.log("Hosted demo: the refund agent's starter rules are on");
  // Resume reconciliation of refunds that were in flight when the server last stopped, and any
  // claims that were waiting for assessment.
  reconcileOpen(db, pay, { atStartup: true }).then((n) => n && console.log(`Reconciled ${n} open refund operation(s)`));
  const waiting = queue.resume();
  if (waiting) console.log(`Resumed assessment of ${waiting} claim(s)`);
  // Reviews that finished just before the server stopped still get the refund agent's look.
  (async () => {
    for (const id of unseenByAgent(db)) await runAgent(db, pay, id).catch((err) => console.error("agent", id, err.message));
  })();
  setInterval(() => reconcileOpen(db, pay).catch(() => {}), 60_000).unref();
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
