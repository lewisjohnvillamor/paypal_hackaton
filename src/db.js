// SQLite storage (node:sqlite). Single-instance demo scope; financial uniqueness lives in constraints.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  paypal_order_id TEXT NOT NULL UNIQUE,
  capture_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  payee_merchant_id TEXT,
  capture_status TEXT,
  buyer_email TEXT,
  delivered_at TEXT,
  delivery_source TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cents INTEGER NOT NULL CHECK (unit_cents > 0),
  ref_image TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES orders(id),
  line_id TEXT NOT NULL REFERENCES order_lines(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  statement TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  token_hash TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- MVP: one active case per capture/order.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_claim_per_order
  ON claims(order_id) WHERE status NOT IN ('closed', 'refunded');

CREATE TABLE IF NOT EXISTS claim_links (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  claim_version INTEGER NOT NULL,
  model TEXT,
  template_version TEXT NOT NULL,
  findings_json TEXT,
  answers_json TEXT,
  usage_json TEXT,
  latency_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  claim_version INTEGER NOT NULL,
  assessment_id TEXT REFERENCES assessments(id),
  policy_version TEXT NOT NULL,
  route TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL,
  calc_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  claim_version INTEGER NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  proposal_snapshot TEXT NOT NULL,
  actor TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  override_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (claim_id, claim_version)
);

CREATE TABLE IF NOT EXISTS refund_ops (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  capture_id TEXT NOT NULL,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  request_id TEXT NOT NULL UNIQUE,
  request_body TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUBMITTING','PENDING','UNKNOWN','COMPLETED','FAILED')),
  provider_refund_id TEXT UNIQUE,
  provider_status TEXT,
  debug_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- At most one unresolved refund operation per capture.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_op_per_capture
  ON refund_ops(capture_id) WHERE status IN ('SUBMITTING','PENDING','UNKNOWN');

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT,
  op_id TEXT,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT,
  at TEXT NOT NULL
);
`;

// Columns added after the first release; ALTER is skipped when the column already exists.
const MIGRATIONS = ["ALTER TABLE evidence ADD COLUMN phash TEXT"];

export function openDb(path = process.env.DATABASE_PATH || "data/refund-relay.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (err) { if (!/duplicate column/.test(err.message)) throw err; }
  }
  return db;
}

export const now = () => new Date().toISOString();

// Short synchronous transaction. Never put network I/O inside.
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function audit(db, { claimId = null, opId = null, actor, type, payload = null }) {
  db.prepare("INSERT INTO audit (claim_id, op_id, actor, type, payload, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(claimId, opId, actor, type, payload ? JSON.stringify(payload) : null, now());
}
