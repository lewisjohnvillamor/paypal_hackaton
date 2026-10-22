// Claim workflow: submit, attach evidence, assess, draft proposal, request info, close.
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audit, now, tx } from "./db.js";
import { hashToken, newToken } from "./auth.js";
import { draftProposal, refundableBalance } from "./policy/refundPolicy.js";
import { TEMPLATE_VERSION } from "./ai/jev.js";
import { IMAGE_CONCURRENCY, MAX_PHOTOS, SIMILAR_PHOTO_BITS, aiCopy, differenceHash, hashDistance, mapLimit } from "./images.js";
import { anyNearOtherClaim } from "./photoIndex.js";
import { pickForModel, tooManyTokens } from "./ai/select.js";
import { PRODUCTS } from "./catalog.js";

export const uploadDir = () => process.env.UPLOAD_DIR || "data/uploads";
const STATUS_TOKEN_DAYS = 30;
const REPEAT_WINDOW_DAYS = 90;

export class ClaimError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const shortRef = () => "RR-" + randomBytes(3).toString("hex").toUpperCase();

export function createClaim(db, { orderId, lineId, quantity, statement }) {
  const text = String(statement || "").trim();
  if (text.length < 5 || text.length > 1000) throw new ClaimError("INVALID", "Describe the problem in 5 to 1000 characters.");
  const line = db.prepare("SELECT * FROM order_lines WHERE id = ? AND order_id = ?").get(lineId, orderId);
  if (!line) throw new ClaimError("INVALID", "Pick an item from this order.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > line.quantity) {
    throw new ClaimError("INVALID", `Quantity must be between 1 and ${line.quantity}.`);
  }
  // Units already refunded on earlier requests cannot be claimed again.
  const resolved = db.prepare("SELECT COALESCE(SUM(quantity), 0) n FROM claims WHERE line_id = ? AND status = 'refunded'").get(lineId).n;
  if (quantity > line.quantity - resolved) {
    throw new ClaimError("UNITS_ALREADY_RESOLVED",
      `${resolved} of ${line.quantity} were already refunded; you can report at most ${line.quantity - resolved} more.`, 409);
  }
  const token = newToken();
  const ts = now();
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO claims (id, ref, order_id, line_id, quantity, statement, status, version, token_hash,
      token_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'new', 1, ?, ?, ?, ?)`)
      .run(id, shortRef(), orderId, lineId, quantity, text, hashToken(token),
        new Date(Date.now() + STATUS_TOKEN_DAYS * 86400e3).toISOString(), ts, ts);
  } catch (err) {
    if (/UNIQUE constraint failed: claims.order_id/.test(err.message)) {
      throw new ClaimError("ACTIVE_CLAIM_EXISTS", "There is already an open refund request for this order.", 409);
    }
    throw err;
  }
  audit(db, { claimId: id, actor: "buyer", type: "claim.submitted", payload: { lineId, quantity } });
  return { claim: db.prepare("SELECT * FROM claims WHERE id = ?").get(id), token };
}

export async function addEvidence(db, claimId, images, actor = "buyer") {
  const existing = db.prepare("SELECT COUNT(*) n FROM evidence WHERE claim_id = ?").get(claimId).n;
  if (existing + images.length > MAX_PHOTOS) throw new ClaimError("TOO_MANY_PHOTOS", `Up to ${MAX_PHOTOS} photos per request.`);
  const dir = join(uploadDir(), claimId);
  mkdirSync(dir, { recursive: true });
  // Files are written before the transaction, so the write lock is never held across disk I/O.
  // A crash in between leaves an orphan file, never a row without its photo.
  const stored = await mapLimit(images, 8, async (img) => {
    const id = randomUUID();
    await writeFile(join(dir, `${id}.jpg`), img.data, { mode: 0o600 });
    return { id, img };
  });
  const ts = now();
  tx(db, () => {
    const insert = db.prepare(`INSERT INTO evidence (id, claim_id, storage_key, sha256, phash, sharpness, width, height, bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const { id, img } of stored) {
      insert.run(id, claimId, `${claimId}/${id}.jpg`, img.sha256, img.phash ?? null, img.sharpness ?? null, img.width, img.height, img.data.length, ts);
    }
    // New evidence invalidates any earlier review: bump the version.
    db.prepare("UPDATE claims SET version = version + 1, status = CASE WHEN status = 'needs_info' THEN 'new' ELSE status END, updated_at = ? WHERE id = ?")
      .run(ts, claimId);
    audit(db, { claimId, actor, type: "evidence.added", payload: { count: images.length } });
  });
}

export const readEvidence = (key) => readFile(join(uploadDir(), key));

// Signals from the shop's own records. Like the model's findings, each one sends the case to a
// person; none of them can deny or pay a claim.
export function riskFlags(db, claim, evidence, catalogHash) {
  const flags = [];
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(claim.order_id);
  const near = (a, b) => a && b && hashDistance(a, b) <= SIMILAR_PHOTO_BITS;
  if (anyNearOtherClaim(db, claim.id, evidence.map((e) => e.phash), SIMILAR_PHOTO_BITS)) flags.push("PHOTO_REUSED_FROM_OTHER_CLAIM");
  if (evidence.some((e) => near(e.phash, catalogHash))) flags.push("PHOTO_MATCHES_CATALOG");
  if (db.prepare("SELECT 1 FROM claims WHERE order_id = ? AND id != ? AND created_at <= ?").get(claim.order_id, claim.id, claim.created_at)) {
    flags.push("PRIOR_CLAIM_ON_ORDER");
  }
  // Prior requests on other orders that mark a buyer as a repeat claimant. A shared demo buyer
  // account trips this on every run, so a hosted demo can set REPEAT_CLAIM_LIMIT=0 to turn it off.
  const repeatLimit = Number(process.env.REPEAT_CLAIM_LIMIT ?? 1);
  if (order.buyer_email && repeatLimit > 0) {
    const since = new Date(Date.now() - REPEAT_WINDOW_DAYS * 86400e3).toISOString();
    const n = db.prepare(`SELECT COUNT(*) n FROM claims c JOIN orders o ON o.id = c.order_id
      WHERE o.buyer_email = ? AND c.order_id != ? AND c.created_at >= ?`).get(order.buyer_email, order.id, since).n;
    if (n >= repeatLimit) flags.push("REPEAT_CLAIMANT");
  }
  if (claim.quantity > 1) flags.push("MULTI_UNIT_CLAIM"); // the merchant confirms how many broke
  return flags;
}

// The catalog photo and its fingerprint, read once per product.
const catalog = new Map();
function catalogPhoto(sku) {
  if (!catalog.has(sku)) {
    const reference = readFileSync(new URL(`../public/assets/${PRODUCTS[sku].refImage}`, import.meta.url));
    catalog.set(sku, differenceHash(reference).then((hash) => ({ reference, hash })));
  }
  return catalog.get(sku);
}

// Run Jev on the current evidence and draft a proposal for the current claim version.
// If Jev fails we record the error and still draft a manual-review proposal; we never invent findings.
export async function assessClaim(db, claimId, assess, actor = "system") {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
  if (!claim) throw new ClaimError("NOT_FOUND", "No such request.", 404);
  if (!["new", "ready", "needs_info"].includes(claim.status)) {
    throw new ClaimError("NOT_ASSESSABLE", `Request is ${claim.status}.`, 409);
  }
  const line = db.prepare("SELECT * FROM order_lines WHERE id = ?").get(claim.line_id);
  const evidence = db.prepare("SELECT * FROM evidence WHERE claim_id = ? ORDER BY created_at").all(claimId);
  const { reference, hash: catalogHash } = await catalogPhoto(line.sku);

  const flags = riskFlags(db, claim, evidence, catalogHash);

  let result = null, error = null, sent = pickForModel(evidence);
  if (evidence.length === 0) error = "No photos uploaded";
  else {
    try {
      const copies = await mapLimit(sent, IMAGE_CONCURRENCY, async (e) => aiCopy(await readEvidence(e.storage_key)));
      // If the photos still exceed the model's per-call budget, halve the set rather than fail.
      for (let n = copies.length; ; n = Math.ceil(n / 2)) {
        try {
          result = await assess({ photos: copies.slice(0, n), reference });
          sent = sent.slice(0, n);
          break;
        } catch (err) {
          if (!tooManyTokens(err) || n === 1) throw err;
        }
      }
    } catch (err) {
      error = String(err?.message || err).slice(0, 300);
    }
  }

  return tx(db, () => {
    const current = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
    if (current.version !== claim.version) throw new ClaimError("STALE_CASE", "The request changed during assessment. Run it again.", 409);
    const ts = now();
    const assessmentId = randomUUID();
    db.prepare(`INSERT INTO assessments (id, claim_id, claim_version, model, template_version, findings_json, answers_json,
      usage_json, latency_ms, error, photo_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(assessmentId, claimId, claim.version, result?.model ?? null, TEMPLATE_VERSION,
        result ? JSON.stringify(result.findings) : null, result ? JSON.stringify(result.answers) : null,
        result ? JSON.stringify(result.usage) : null, result?.latencyMs ?? null, error,
        evidence.length ? JSON.stringify(sent.map((e) => e.id)) : null, ts);

    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(claim.order_id);
    const ops = db.prepare("SELECT * FROM refund_ops WHERE capture_id = ?").all(order.capture_id);
    const draft = draftProposal({
      line, quantity: claim.quantity, findings: result?.findings ?? null,
      deliveredAt: order.delivered_at, claimedAt: claim.created_at,
      refundableCents: refundableBalance(order.amount_cents, ops), flags,
    });
    db.prepare(`INSERT INTO proposals (id, claim_id, claim_version, assessment_id, policy_version, route, amount_cents,
      currency, calc_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), claimId, claim.version, assessmentId, draft.policyVersion, draft.route, draft.amountCents,
        draft.currency, JSON.stringify({ reasons: draft.reasons, calculation: draft.calculation }), ts);

    db.prepare("UPDATE claims SET status = 'ready', updated_at = ? WHERE id = ?").run(ts, claimId);
    audit(db, { claimId, actor, type: error ? "assessment.failed" : "assessment.completed",
      payload: { route: draft.route, amountCents: draft.amountCents, error } });
    return draft;
  });
}

export function requestInfo(db, claimId, message, actor) {
  const msg = String(message || "").trim();
  if (msg.length < 3) throw new ClaimError("INVALID", "Tell the buyer what you need.");
  return transition(db, claimId, ["new", "ready"], "needs_info", actor, "claim.info_requested", { message: msg });
}

export function closeClaim(db, claimId, reason, actor) {
  const why = String(reason || "").trim();
  if (why.length < 3) throw new ClaimError("INVALID", "Give a reason for closing without a refund.");
  return transition(db, claimId, ["new", "ready", "needs_info"], "closed", actor, "claim.closed", { reason: why });
}

function transition(db, claimId, from, to, actor, type, payload) {
  return tx(db, () => {
    const c = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
    if (!c) throw new ClaimError("NOT_FOUND", "No such request.", 404);
    if (!from.includes(c.status)) throw new ClaimError("INVALID_STATE", `Request is ${c.status}.`, 409);
    db.prepare("UPDATE claims SET status = ?, version = version + 1, updated_at = ? WHERE id = ?").run(to, now(), claimId);
    audit(db, { claimId, actor, type, payload });
  });
}
