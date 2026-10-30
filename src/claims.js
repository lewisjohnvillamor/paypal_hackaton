// Claim workflow: submit, attach evidence, assess, draft proposal, request info, close.
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audit, now, tx } from "./db.js";
import { hashToken, newToken } from "./auth.js";
import { draftProposal, itemConfirmed, refundableBalance, resolutionOptions } from "./policy/refundPolicy.js";
import { currentPolicy } from "./policy/settings.js";
import { agentSpent } from "./agent/spend.js";
import { TEMPLATE_VERSION } from "./ai/jev.js";
import { IMAGE_CONCURRENCY, MAX_PHOTOS, SIMILAR_PHOTO_BITS, aiCopy, differenceHash, hashDistance, mapLimit } from "./images.js";
import { anyNearOtherClaim } from "./photoIndex.js";
import { pickForModel, tooManyTokens } from "./ai/select.js";
import { PRODUCTS } from "./catalog.js";
import { activeRemedies } from "./remedies.js";
import { candidatesFor } from "./suggest/candidates.js";
import { checkSuggestions, storeSuggestions } from "./suggest/suggestions.js";
import { DEMO } from "./merchants/accounts.js";

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
  const resolved = db.prepare("SELECT COALESCE(SUM(quantity), 0) n FROM claims WHERE line_id = ? AND status IN ('refunded', 'resolved')").get(lineId).n;
  if (quantity > line.quantity - resolved) {
    throw new ClaimError("UNITS_ALREADY_RESOLVED",
      `${resolved} of ${line.quantity} were already refunded or replaced; you can report at most ${line.quantity - resolved} more.`, 409);
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
  // Prior requests on the same store's other orders that mark a buyer as a repeat claimant (another
  // store's requests are that store's business). A shared demo buyer
  // account trips this on every run, so a hosted demo can set REPEAT_CLAIM_LIMIT=0 to turn it off.
  const repeatLimit = Number(process.env.REPEAT_CLAIM_LIMIT ?? 1);
  if (order.buyer_email && repeatLimit > 0) {
    const since = new Date(Date.now() - REPEAT_WINDOW_DAYS * 86400e3).toISOString();
    const n = db.prepare(`SELECT COUNT(*) n FROM claims c JOIN orders o ON o.id = c.order_id
      WHERE o.buyer_email = ? AND o.merchant_id = ? AND c.order_id != ? AND c.created_at >= ?`).get(order.buyer_email, order.merchant_id, order.id, since).n;
    if (n >= repeatLimit) flags.push("REPEAT_CLAIMANT");
  }
  if (claim.quantity > 1) flags.push("MULTI_UNIT_CLAIM"); // the merchant confirms how many broke
  return flags;
}

// The catalog photo and its fingerprint, read once per image. A connected store's photos were
// stored when it registered the order ("m/<sha>.jpg"); the demo store's ship in public/assets.
const catalog = new Map();
function catalogPhoto(line) {
  const file = line.ref_image ?? PRODUCTS[line.sku].refImage;
  if (!catalog.has(file)) {
    const reference = readFileSync(file.startsWith("m/") ? join(uploadDir(), "catalog", file.slice(2)) : new URL(`../public/assets/${file}`, import.meta.url));
    // A failed fingerprint is not kept, so the next review tries again.
    catalog.set(file, differenceHash(reference).then((hash) => ({ reference, hash }), (err) => { catalog.delete(file); throw err; }));
  }
  return catalog.get(file);
}

// What the evidence check and Haiku need to know about the product: the demo catalog entry, or
// what the store sent when it registered the order.
const productOf = (line) => PRODUCTS[line.sku] && !line.category
  ? PRODUCTS[line.sku]
  : { sku: line.sku, title: line.title, unitCents: line.unit_cents, category: line.category };

// Run Jev on the current evidence and draft a proposal for the current claim version.
// If Jev fails we record the error and still draft a manual-review proposal; we never invent findings.
// suggest, when the server has a Claude key, adds Haiku's pending remedy suggestions; match adds
// Haiku's second product-match check to the findings.
export async function assessClaim(db, claimId, assess, actor = "system", suggest = null, match = null) {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
  if (!claim) throw new ClaimError("NOT_FOUND", "No such request.", 404);
  if (!["new", "ready", "needs_info"].includes(claim.status)) {
    throw new ClaimError("NOT_ASSESSABLE", `Request is ${claim.status}.`, 409);
  }
  const line = db.prepare("SELECT * FROM order_lines WHERE id = ?").get(claim.line_id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(claim.order_id);
  const evidence = db.prepare("SELECT * FROM evidence WHERE claim_id = ? ORDER BY created_at").all(claimId);
  const { reference, hash: catalogHash } = await catalogPhoto(line);
  const product = productOf(line);
  // The remedy library and store listings are the demo store's for now; a connected store gets the
  // photo check, its own refund policy, its own refund agent and refunds through its own PayPal.
  const demoStore = order.merchant_id === DEMO;
  if (!demoStore) suggest = null;

  const flags = riskFlags(db, claim, evidence, catalogHash);
  const remedies = demoStore ? activeRemedies(db, line.sku) : [];

  let result = null, error = null, sent = pickForModel(evidence), copies = [];
  if (evidence.length === 0) error = "No photos uploaded";
  else {
    try {
      copies = await mapLimit(sent, IMAGE_CONCURRENCY, async (e) => aiCopy(await readEvidence(e.storage_key)));
      // If the photos still exceed the model's per-call budget, halve the set rather than fail.
      for (let n = copies.length; ; n = Math.ceil(n / 2)) {
        try {
          result = await assess({ photos: copies.slice(0, n), reference, remedies, category: product.category });
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

  // Both Haiku calls run side by side; suggestions are dropped below if the item is not confirmed.
  const photosSent = copies.slice(0, sent.length);
  const [suggested, matched] = await Promise.all([
    suggestFor({ suggest, sku: line.sku, findings: result?.findings, photos: photosSent, reference }),
    matchFor({ match, product, findings: result?.findings, photos: photosSent, reference }),
  ]);
  if (matched?.same) result = { ...result, findings: { ...result.findings, second_check: matched } };

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

    const ops = db.prepare("SELECT * FROM refund_ops WHERE capture_id = ?").all(order.capture_id);
    // The decision is drafted under the settings in force now, and records which version that was
    // and every input it used, so it can be replayed to the same answer.
    const settings = currentPolicy(db, order.merchant_id);
    const inputs = {
      quantity: claim.quantity, deliveredAt: order.delivered_at, claimedAt: claim.created_at,
      refundableCents: refundableBalance(order.amount_cents, ops), flags, agentSpentCents: agentSpent(db, order.merchant_id),
    };
    const draft = draftProposal({ line, findings: result?.findings ?? null, settings, ...inputs });
    const options = draft.route === "reject" ? [] : resolutionOptions({
      remedies, quantity: draft.calculation.quantity, findings: result?.findings ?? null, amountCents: draft.amountCents,
      fullRefund: draft.amountCents >= draft.calculation.grossCents,
    });
    const proposalId = randomUUID();
    db.prepare(`INSERT INTO proposals (id, claim_id, claim_version, assessment_id, policy_version, route, amount_cents,
      currency, calc_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(proposalId, claimId, claim.version, assessmentId, draft.policyVersion, draft.route, draft.amountCents,
        draft.currency, JSON.stringify({ reasons: draft.reasons, decidedBy: draft.decidedBy, askForPhotos: draft.askForPhotos, hardReject: draft.hardReject,
          calculation: draft.calculation, options, policyId: settings.id, inputs }), ts);

    db.prepare("UPDATE claims SET status = 'ready', updated_at = ? WHERE id = ?").run(ts, claimId);
    audit(db, { claimId, actor, type: error ? "assessment.failed" : "assessment.completed",
      payload: { route: draft.route, amountCents: draft.amountCents, error } });
    if (matched?.error) audit(db, { claimId, actor: "system", type: "match.failed", payload: { error: matched.error } });
    if (suggested && draft.route !== "reject" && draft.amountCents > 0 && itemConfirmed(result?.findings)) {
      if (suggested.error) audit(db, { claimId, actor: "system", type: "suggestion.failed", payload: { error: suggested.error } });
      else {
        // On a partial refund, nothing may be worth more than the policy's amount: no replacements,
        // and a listing plus its refund must fit inside the drafted refund per item.
        const full = draft.amountCents >= draft.calculation.grossCents;
        const perUnit = Math.floor(draft.amountCents / draft.calculation.quantity);
        const fits = suggested.suggestions.filter((x) => full || (x.listing.kind !== "replacement" && x.listing.priceCents + x.refundUnitCents <= perUnit));
        storeSuggestions(db, { claimId, proposalId, model: suggested.model, suggestions: fits });
        audit(db, { claimId, actor: "system", type: "suggestion.created", payload: {
          model: suggested.model, latencyMs: suggested.latencyMs, candidates: suggested.candidates,
          titles: fits.map((x) => x.title), dropped: suggested.dropped + suggested.suggestions.length - fits.length } });
      }
    }
    return draft;
  });
}

// Ask Haiku only when Jev clearly saw damage on usable photos, with the store's listings narrowed
// to this product and damage first. A failure is recorded and never blocks the review.
async function suggestFor({ suggest, sku, findings, photos, reference }) {
  if (!suggest || !findings || findings.visible_breakage !== "yes" || findings.evidence_usable === "no" || !photos.length) return null;
  const candidates = candidatesFor(sku, findings);
  if (!candidates.length) return null;
  const product = PRODUCTS[sku];
  try {
    const r = await suggest({ photos, reference, product, findings, candidates });
    const suggestions = checkSuggestions(r.suggestions, { candidates, unitCents: product.unitCents });
    return { model: r.model, latencyMs: r.latencyMs, candidates: candidates.length, suggestions, dropped: (r.suggestions?.length ?? 0) - suggestions.length };
  } catch (err) {
    return { error: String(err?.message || err).slice(0, 300) };
  }
}

// Haiku's second look at whether the photos show the product sold. A failure is recorded and leaves
// Jev's checks to stand alone; it never blocks the review.
async function matchFor({ match, product, findings, photos, reference }) {
  if (!match || !findings || !photos.length) return null;
  try {
    return await match({ photos, reference, product });
  } catch (err) {
    return { error: String(err?.message || err).slice(0, 300) };
  }
}

export function requestInfo(db, claimId, message, actor, inTx = false) {
  const msg = String(message || "").trim();
  if (msg.length < 3) throw new ClaimError("INVALID", "Tell the buyer what you need.");
  return transition(db, claimId, ["new", "ready"], "needs_info", actor, "claim.info_requested", { message: msg }, inTx);
}

export function closeClaim(db, claimId, reason, actor, inTx = false) {
  const why = String(reason || "").trim();
  if (why.length < 3) throw new ClaimError("INVALID", "Give a reason for closing without a refund.");
  return transition(db, claimId, ["new", "ready", "needs_info"], "closed", actor, "claim.closed", { reason: why }, inTx);
}

// inTx: the caller already holds a transaction (the refund agent closing a case, or asking for photos).
function transition(db, claimId, from, to, actor, type, payload, inTx = false) {
  const step = () => {
    const c = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId);
    if (!c) throw new ClaimError("NOT_FOUND", "No such request.", 404);
    if (!from.includes(c.status)) throw new ClaimError("INVALID_STATE", `Request is ${c.status}.`, 409);
    db.prepare("UPDATE claims SET status = ?, version = version + 1, updated_at = ? WHERE id = ?").run(to, now(), claimId);
    audit(db, { claimId, actor, type, payload });
  };
  return inTx ? step() : tx(db, step);
}
