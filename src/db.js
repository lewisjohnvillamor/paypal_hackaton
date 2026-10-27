// SQLite storage (node:sqlite). Single-instance demo scope; financial uniqueness lives in constraints.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

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
-- MVP: one active case per capture/order. 'resolved' = settled without money moving (a replacement).
CREATE UNIQUE INDEX IF NOT EXISTS one_active_claim_per_order_v2
  ON claims(order_id) WHERE status NOT IN ('closed', 'refunded', 'resolved');

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

-- Resolution options the merchant approved and sent to the buyer. The buyer's pick becomes the
-- refund; every option's amount was approved by the merchant when the offer was sent.
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  claim_version INTEGER NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  options_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','accepted')),
  chosen_option TEXT,
  op_id TEXT REFERENCES refund_ops(id),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (claim_id, claim_version)
);

-- The merchant's remedy library: what can put a damaged item right besides a full refund. Jev
-- judges which ones fit the photos; refund_unit_cents is what the buyer gets back per unit.
CREATE TABLE IF NOT EXISTS remedies (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('repair_kit','spare_part','replacement','other')),
  title TEXT NOT NULL,
  item TEXT NOT NULL,
  fits TEXT NOT NULL,
  refund_unit_cents INTEGER NOT NULL CHECK (refund_unit_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  listing_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  item TEXT NOT NULL,
  item_price_cents INTEGER NOT NULL,
  why TEXT NOT NULL,
  refund_unit_cents INTEGER NOT NULL CHECK (refund_unit_cents >= 0),
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','dismissed')),
  decided_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (proposal_id, listing_id)
);

-- The merchant's standing rules for the refund agent: their own words, and the checked structure
-- that is the only thing enforced. One row is on at a time (ended_at IS NULL); old ones stay.
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  model TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT
);

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
const MIGRATIONS = [
  "DROP INDEX IF EXISTS one_active_claim_per_order",
  "ALTER TABLE evidence ADD COLUMN phash TEXT",
  "ALTER TABLE evidence ADD COLUMN sharpness INTEGER",
  "ALTER TABLE assessments ADD COLUMN photo_ids_json TEXT",
];

// Every lookup the app makes by foreign key or by time. Without these, each claim submission and
// each inbox load scanned whole tables (see bench/RESULTS.md).
const INDEXES = `
CREATE INDEX IF NOT EXISTS offers_by_claim ON offers(claim_id, created_at);
CREATE INDEX IF NOT EXISTS suggestions_by_proposal ON suggestions(proposal_id, created_at);
CREATE INDEX IF NOT EXISTS remedies_by_sku ON remedies(sku, active, position);
CREATE INDEX IF NOT EXISTS evidence_by_claim ON evidence(claim_id, created_at);
CREATE INDEX IF NOT EXISTS claims_by_order ON claims(order_id, created_at);
CREATE INDEX IF NOT EXISTS claims_by_line ON claims(line_id, status);
CREATE INDEX IF NOT EXISTS claims_by_created ON claims(created_at);
CREATE INDEX IF NOT EXISTS orders_by_buyer ON orders(buyer_email);
CREATE INDEX IF NOT EXISTS lines_by_order ON order_lines(order_id);
CREATE INDEX IF NOT EXISTS assessments_by_claim ON assessments(claim_id, created_at);
CREATE INDEX IF NOT EXISTS proposals_by_claim ON proposals(claim_id, created_at);
CREATE INDEX IF NOT EXISTS approvals_by_claim ON approvals(claim_id, created_at);
CREATE INDEX IF NOT EXISTS refund_ops_by_capture ON refund_ops(capture_id, created_at);
CREATE INDEX IF NOT EXISTS refund_ops_by_claim ON refund_ops(claim_id, created_at);
CREATE INDEX IF NOT EXISTS refund_ops_open ON refund_ops(status) WHERE status IN ('SUBMITTING','PENDING','UNKNOWN');
CREATE INDEX IF NOT EXISTS audit_by_claim ON audit(claim_id, type);
CREATE INDEX IF NOT EXISTS audit_by_op ON audit(op_id);
CREATE INDEX IF NOT EXISTS offers_by_actor ON offers(actor, status, created_at);
CREATE INDEX IF NOT EXISTS refund_ops_by_created ON refund_ops(created_at);
`;

export function openDb(path = process.env.DATABASE_PATH || "data/refund-relay.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (err) { if (!/duplicate column/.test(err.message)) throw err; }
  }
  db.exec(INDEXES);
  return db;
}

export const now = () => new Date().toISOString();

// Online backup: a consistent copy taken while the app keeps writing (VACUUM INTO), kept next to
// the data and pruned to the newest `keep` copies. Copy the folder off the machine, or rely on the
// host's disk snapshots, for disaster recovery.
export function backup(db, { dir = process.env.BACKUP_DIR || join(dirname(process.env.DATABASE_PATH || "data/refund-relay.db"), "backups"), keep = Number(process.env.BACKUP_KEEP || 7) } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `refund-relay-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  db.prepare("VACUUM INTO ?").run(file);
  const old = readdirSync(dir).filter((f) => f.startsWith("refund-relay-") && f.endsWith(".db")).sort().slice(0, -keep);
  for (const f of old) rmSync(join(dir, f));
  return { file, removed: old.length };
}

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
