// The multi-merchant surface: dashboard sign-up and setup (/api/dashboard), and the store API that
// a merchant's own server calls with a secret key (/v1).
import express from "express";
import { issueSession, requireMerchant } from "../auth.js";
import { toDecimal } from "../money.js";
import {
  AccountError, DEMO, connectionView, createKey, getMerchant, keyMerchant, listKeys, login, removeConnection, revokeKey, saveConnection, signup,
} from "./accounts.js";
import { CATEGORIES, CLAIM_LINK_DAYS, registerOrder } from "./register.js";

export function platformRoutes(app, { db, clientFor, paypalFor, fetchImage, limit, wrap }) {
  const baseUrl = (req) => (process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

  // ---- Dashboard ------------------------------------------------------------------------------
  app.post("/api/dashboard/signup", limit(5, 60e3), wrap(async (req, res) => {
    const merchant = signup(db, req.body ?? {});
    issueSession(res, merchant.id);
    res.status(201).json({ merchant });
  }));
  app.post("/api/dashboard/login", limit(10, 60e3), wrap(async (req, res) => {
    const merchant = login(db, req.body ?? {});
    if (!merchant) throw new AccountError("BAD_LOGIN", "Wrong email or password.", 401);
    issueSession(res, merchant.id);
    res.json({ merchant });
  }));

  // Everything the dashboard shows: the account, the PayPal connection, keys, and the setup
  // checklist, each step done when the thing it asks for has really happened.
  const overview = (req) => {
    const id = req.merchantId;
    const connection = connectionView(db, id);
    const keys = listKeys(db, id);
    const orders = db.prepare("SELECT COUNT(*) n FROM orders WHERE merchant_id = ? AND capture_status = 'COMPLETED'").get(id).n;
    const requests = db.prepare("SELECT COUNT(*) n FROM claims c JOIN orders o ON o.id = c.order_id WHERE o.merchant_id = ?").get(id).n;
    return {
      merchant: getMerchant(db, id), demo: id === DEMO, baseUrl: baseUrl(req), categories: CATEGORIES, claimLinkDays: CLAIM_LINK_DAYS,
      connection, keys, counts: { orders, requests },
      checklist: [
        { id: "paypal", title: "Connect your PayPal account", done: !!connection },
        { id: "key", title: "Create a secret key for your server", done: keys.some((k) => !k.revokedAt) },
        { id: "order", title: "Send your first order to Refund Relay", done: orders > 0 },
        { id: "button", title: "Show buyers the Report a problem button", done: requests > 0 },
      ],
    };
  };

  const d = express.Router();
  d.use(requireMerchant);
  d.get("/", (req, res) => res.json(overview(req)));
  d.put("/paypal", limit(10, 60e3), wrap(async (req, res) => {
    await saveConnection(db, req.merchantId, req.body ?? {}, (credentials) => paypalFor(credentials).accessToken());
    res.json(overview(req));
  }));
  d.delete("/paypal", wrap(async (req, res) => {
    removeConnection(db, req.merchantId);
    res.json(overview(req));
  }));
  d.post("/keys", limit(10, 60e3), wrap(async (req, res) => {
    const created = createKey(db, req.merchantId, req.body?.label);
    res.status(201).json({ created, ...overview(req) });
  }));
  d.delete("/keys/:id", wrap(async (req, res) => {
    revokeKey(db, req.merchantId, req.params.id);
    res.json(overview(req));
  }));
  app.use("/api/dashboard", d);

  // ---- Store API ------------------------------------------------------------------------------
  const v1 = express.Router();
  v1.use((req, res, next) => {
    const presented = /^Bearer\s+(\S+)$/.exec(req.get("Authorization") || "")?.[1];
    const found = presented && keyMerchant(db, presented);
    if (!found) return res.status(401).json({ error: "UNAUTHENTICATED", message: "Send your secret key as Authorization: Bearer rr_sk_test_…" });
    req.merchantId = found.merchant.id;
    next();
  });

  const orderView = (req, order, token, alreadyRegistered) => {
    const lines = db.prepare("SELECT id, sku, title, quantity, unit_cents FROM order_lines WHERE order_id = ?").all(order.id);
    const link = db.prepare("SELECT expires_at FROM claim_links WHERE order_id = ?").get(order.id);
    return {
      id: order.id, object: "order", paypal_order_id: order.paypal_order_id, capture_id: order.capture_id,
      amount: { currency_code: order.currency, value: toDecimal(order.amount_cents) },
      items: lines.map((l) => ({ id: l.id, sku: l.sku, title: l.title, quantity: l.quantity, unit_price: toDecimal(l.unit_cents) })),
      // The buyer's private link. Refund Relay keeps only its hash, so it is returned once;
      // registering the order again issues a new one and the old one stops working.
      ...(token ? { claim_url: `${baseUrl(req)}/claim?order=${order.id}#t=${token}`, already_registered: alreadyRegistered } : {}),
      claim_url_expires_at: link?.expires_at ?? null,
      requests: db.prepare(`SELECT c.ref, c.status, c.quantity, l.sku, c.created_at,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM refund_ops r WHERE r.claim_id = c.id AND r.status = 'COMPLETED') refunded_cents
        FROM claims c JOIN order_lines l ON l.id = c.line_id WHERE c.order_id = ? ORDER BY c.created_at`).all(order.id)
        .map((c) => ({ ref: c.ref, status: c.status, sku: c.sku, quantity: c.quantity, created_at: c.created_at, refunded: toDecimal(c.refunded_cents) })),
    };
  };

  v1.post("/orders", limit(120, 60e3), wrap(async (req, res) => {
    const { order, claimToken, alreadyRegistered } = await registerOrder(db, { merchantId: req.merchantId, client: clientFor(req.merchantId), body: req.body, fetchImage });
    res.status(alreadyRegistered ? 200 : 201).json(orderView(req, order, claimToken, alreadyRegistered));
  }));
  // By Refund Relay's id or the PayPal order ID.
  v1.get("/orders/:id", (req, res) => {
    const order = db.prepare("SELECT * FROM orders WHERE (id = ? OR paypal_order_id = ?) AND merchant_id = ?").get(req.params.id, req.params.id, req.merchantId);
    if (!order) return res.status(404).json({ error: "NOT_FOUND", message: "No such order on your account." });
    res.json(orderView(req, order));
  });
  v1.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use("/v1", v1);
}
