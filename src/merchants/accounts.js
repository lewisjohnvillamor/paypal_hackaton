// Merchants, their API keys and their PayPal connection. The demo store ('demo') is a merchant like
// any other, except that it signs in with MERCHANT_PASSWORD and its PayPal app comes from .env.
import { randomBytes, randomUUID } from "node:crypto";
import { audit, now } from "../db.js";
import { checkPassword, decrypt, encrypt, hashPassword, sha256 } from "./crypto.js";

export const DEMO = "demo";
export const DEMO_NAME = "Juniper Market";
const MAX_KEYS = 10;

export class AccountError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function ensureDemoMerchant(db) {
  db.prepare("INSERT OR IGNORE INTO merchants (id, name, created_at) VALUES (?, ?, ?)").run(DEMO, DEMO_NAME, now());
}

export const getMerchant = (db, id) => db.prepare("SELECT id, name, email, created_at FROM merchants WHERE id = ?").get(id) ?? null;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

export function signup(db, { name, email, password }) {
  const shop = String(name ?? "").trim();
  const mail = String(email ?? "").trim().toLowerCase();
  if (shop.length < 2 || shop.length > 80) throw new AccountError("INVALID", "Your store name must be 2 to 80 characters.");
  if (!EMAIL.test(mail)) throw new AccountError("INVALID", "Enter a valid email address.");
  if (String(password ?? "").length < 10 || String(password).length > 200) throw new AccountError("INVALID", "Use a password of at least 10 characters.");
  const id = `m_${randomBytes(8).toString("hex")}`;
  try {
    db.prepare("INSERT INTO merchants (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, shop, mail, hashPassword(password), now());
  } catch (err) {
    if (/UNIQUE constraint failed: merchants.email/.test(err.message)) throw new AccountError("EMAIL_TAKEN", "There is already an account with that email. Sign in instead.", 409);
    throw err;
  }
  audit(db, { actor: id, type: "merchant.signed_up", payload: { name: shop } });
  return getMerchant(db, id);
}

export function login(db, { email, password }) {
  const row = db.prepare("SELECT * FROM merchants WHERE email = ?").get(String(email ?? "").trim().toLowerCase());
  return checkPassword(password ?? "", row?.password_hash) ? getMerchant(db, row.id) : null;
}

// ---- API keys -----------------------------------------------------------------------------------
const keyView = (k) => ({ id: k.id, label: k.label, prefix: k.prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at });

export const listKeys = (db, merchantId) =>
  db.prepare("SELECT * FROM api_keys WHERE merchant_id = ? ORDER BY created_at DESC").all(merchantId).map(keyView);

export function createKey(db, merchantId, label) {
  const name = String(label ?? "").trim().slice(0, 60) || "Server key";
  const active = db.prepare("SELECT COUNT(*) n FROM api_keys WHERE merchant_id = ? AND revoked_at IS NULL").get(merchantId).n;
  if (active >= MAX_KEYS) throw new AccountError("TOO_MANY_KEYS", `Up to ${MAX_KEYS} active keys. Revoke one first.`, 409);
  // "test" because every key works against the PayPal sandbox only.
  const key = `rr_sk_test_${randomBytes(24).toString("base64url")}`;
  const id = randomUUID();
  db.prepare("INSERT INTO api_keys (id, merchant_id, label, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, merchantId, name, `${key.slice(0, 15)}…`, sha256(key), now());
  audit(db, { actor: merchantId, type: "api_key.created", payload: { keyId: id, label: name } });
  return { ...keyView(db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id)), key };
}

export function revokeKey(db, merchantId, keyId) {
  const r = db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND merchant_id = ? AND revoked_at IS NULL").run(now(), keyId, merchantId);
  if (!r.changes) throw new AccountError("NOT_FOUND", "No such active key.", 404);
  audit(db, { actor: merchantId, type: "api_key.revoked", payload: { keyId } });
}

// The merchant behind a presented secret key, or null. Only the hash is compared.
export function keyMerchant(db, presented) {
  if (!/^rr_sk_test_[A-Za-z0-9_-]{32}$/.test(String(presented ?? ""))) return null;
  const k = db.prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL").get(sha256(presented));
  if (!k) return null;
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), k.id);
  return { merchant: getMerchant(db, k.merchant_id), keyId: k.id };
}

// ---- PayPal connection --------------------------------------------------------------------------
// One-click "Connect with PayPal" (Partner Referrals) needs PayPal to approve Refund Relay as a
// partner; until then a merchant pastes the client ID and secret of their own REST app.
const mask = (id) => (id ? `${id.slice(0, 6)}…${id.slice(-4)}` : null);

export function connectionView(db, merchantId) {
  if (merchantId === DEMO) {
    const id = process.env.PAYPAL_CLIENT_ID;
    return id ? { source: "server", clientId: mask(id), payeeMerchantId: process.env.PAYPAL_MERCHANT_ID || null, verifiedAt: null } : null;
  }
  const c = db.prepare("SELECT * FROM paypal_connections WHERE merchant_id = ?").get(merchantId);
  return c ? { source: "merchant", clientId: mask(c.client_id), payeeMerchantId: c.payee_merchant_id, verifiedAt: c.verified_at,
    needsReconnect: !readSecret(c.secret_enc) } : null;
}

// The stored secret, or null when it can no longer be read (CREDENTIALS_KEY or SESSION_SECRET
// changed): the store then has to paste its credentials again.
function readSecret(sealed) {
  try { return decrypt(sealed); } catch { return null; }
}

const CRED = /^[A-Za-z0-9_-]{20,128}$/;

// verify(credentials) resolves when PayPal accepts them (an OAuth token), and throws otherwise.
export async function saveConnection(db, merchantId, { clientId, clientSecret, payeeMerchantId }, verify) {
  if (merchantId === DEMO) throw new AccountError("SERVER_MANAGED", "The demo store's PayPal app is set on the server.", 409);
  const id = String(clientId ?? "").trim(), secret = String(clientSecret ?? "").trim();
  const payee = String(payeeMerchantId ?? "").trim().toUpperCase() || null;
  if (!CRED.test(id) || !CRED.test(secret)) throw new AccountError("INVALID", "Paste the Client ID and Secret from your PayPal app (developer.paypal.com, Apps & Credentials, Sandbox).");
  if (payee && !/^[A-Z0-9]{8,20}$/.test(payee)) throw new AccountError("INVALID", "The PayPal merchant ID is 8 to 20 letters and digits (Account settings, Business information).");
  try {
    await verify({ clientId: id, clientSecret: secret });
  } catch (err) {
    throw new AccountError("PAYPAL_REJECTED", err.status === 401
      ? "PayPal did not accept that Client ID and Secret. Check they are from a sandbox app."
      : "Could not reach PayPal to check those credentials. Try again.", err.status === 401 ? 400 : 503);
  }
  // One PayPal app, and one PayPal account, per store: otherwise two stores could each register
  // and refund orders paid to the same account. Checked after PayPal answers and right before the
  // write, with no await in between, so two stores racing to connect the same app cannot both pass.
  // The demo store's app comes from .env and is not in this table: a sandbox can share it, since
  // the demo store's orders are registered by its own checkout and no other store can claim them.
  if (db.prepare("SELECT 1 FROM paypal_connections WHERE client_id = ? AND merchant_id != ?").get(id, merchantId)) {
    throw new AccountError("APP_IN_USE", "This PayPal app is already connected to another Refund Relay store. Each store connects its own PayPal app.", 409);
  }
  if (payee && payeeOwner(db, payee, merchantId)) {
    throw new AccountError("PAYEE_IN_USE", "That PayPal merchant ID is already connected to another Refund Relay store.", 409);
  }
  const ts = now();
  // Pasting the same app again (a rotated secret) keeps the payee its orders were paid to; a
  // different app starts over and learns its payee from its next order.
  db.prepare(`INSERT INTO paypal_connections (merchant_id, client_id, secret_enc, payee_merchant_id, verified_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(merchant_id) DO UPDATE SET client_id = excluded.client_id, secret_enc = excluded.secret_enc,
    payee_merchant_id = COALESCE(excluded.payee_merchant_id,
      CASE WHEN paypal_connections.client_id = excluded.client_id THEN paypal_connections.payee_merchant_id END), verified_at = excluded.verified_at, updated_at = excluded.updated_at`)
    .run(merchantId, id, encrypt(secret), payee, ts, ts);
  audit(db, { actor: merchantId, type: "paypal.connected", payload: { clientId: mask(id), payee } });
  return connectionView(db, merchantId);
}

export function removeConnection(db, merchantId) {
  if (merchantId === DEMO) throw new AccountError("SERVER_MANAGED", "The demo store's PayPal app is set on the server.", 409);
  db.prepare("DELETE FROM paypal_connections WHERE merchant_id = ?").run(merchantId);
  audit(db, { actor: merchantId, type: "paypal.disconnected" });
}

// Another connected store that already gets paid into this PayPal account, if any.
export const payeeOwner = (db, payee, merchantId) =>
  db.prepare("SELECT merchant_id FROM paypal_connections WHERE payee_merchant_id = ? AND merchant_id != ?").get(payee, merchantId)?.merchant_id ?? null;

// The first verified order teaches a connection its payee when the merchant did not give one;
// every later order must be paid to the same account.
export function learnPayee(db, merchantId, payee) {
  if (merchantId !== DEMO && payee) {
    db.prepare("UPDATE paypal_connections SET payee_merchant_id = ? WHERE merchant_id = ? AND payee_merchant_id IS NULL").run(payee, merchantId);
  }
}

export const expectedPayee = (db, merchantId) => merchantId === DEMO
  ? process.env.PAYPAL_MERCHANT_ID || null
  : db.prepare("SELECT payee_merchant_id p FROM paypal_connections WHERE merchant_id = ?").get(merchantId)?.p ?? null;

// A PayPal client per merchant: the demo store's own, or one built from the merchant's stored
// credentials (rebuilt when they reconnect). null when the merchant has not connected PayPal, or
// its stored secret can no longer be read.
export function merchantClients(db, demoClient, paypalFor) {
  const cache = new Map();
  return (merchantId) => {
    if (!merchantId || merchantId === DEMO) return demoClient;
    const c = db.prepare("SELECT client_id, secret_enc, updated_at FROM paypal_connections WHERE merchant_id = ?").get(merchantId);
    if (!c) return null;
    const hit = cache.get(merchantId);
    if (hit?.at === c.updated_at) return hit.client;
    const secret = readSecret(c.secret_enc);
    if (!secret) return null;
    const client = paypalFor({ clientId: c.client_id, clientSecret: secret });
    cache.set(merchantId, { at: c.updated_at, client });
    return client;
  };
}

// One object with the PayPal client's methods that sends each call to the account the order was
// paid to, so the refund gate, reconciliation and the refund agent stay unchanged. Checkout calls
// (create, capture) only ever happen on the demo store.
export function routedPayPal(db, demoClient, clientFor) {
  const via = (merchantId) => {
    const c = clientFor(merchantId);
    if (!c) throw Object.assign(new Error("This store has not connected PayPal."), { code: "PAYPAL_NOT_CONNECTED" });
    return c;
  };
  const byOrder = (paypalOrderId) => db.prepare("SELECT merchant_id FROM orders WHERE paypal_order_id = ?").get(paypalOrderId)?.merchant_id;
  const byCapture = (captureId) => db.prepare("SELECT merchant_id FROM orders WHERE capture_id = ?").get(captureId)?.merchant_id;
  const byRefund = (refundId) => db.prepare("SELECT o.merchant_id FROM refund_ops r JOIN orders o ON o.id = r.order_id WHERE r.provider_refund_id = ?").get(refundId)?.merchant_id;
  return {
    ...demoClient,
    createOrder: (...a) => demoClient.createOrder(...a),
    captureOrder: (...a) => demoClient.captureOrder(...a),
    getOrder: async (id) => via(byOrder(id)).getOrder(id),
    getCapture: async (id) => via(byCapture(id)).getCapture(id),
    refundCapture: async (id, body, requestId) => via(byCapture(id)).refundCapture(id, body, requestId),
    getRefund: async (id) => via(byRefund(id)).getRefund(id),
  };
}
