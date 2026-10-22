// The merchant's remedy library, per product. Seeded from the catalog the first time a product has
// none; after that the merchant owns it. Amounts are refunds per unit and can never exceed what
// the buyer paid for that unit.
import { randomUUID } from "node:crypto";
import { now, tx } from "./db.js";
import { PRODUCTS } from "./catalog.js";
import { ClaimError } from "./claims.js";

export const MAX_REMEDIES = 8; // per product; each is one more question in the Jev call
const KINDS = ["repair_kit", "spare_part", "replacement", "other"];

const row = (r) => r && {
  id: r.id, sku: r.sku, kind: r.kind, title: r.title, item: r.item, fits: r.fits,
  refundUnitCents: r.refund_unit_cents, active: !!r.active, position: r.position, updatedAt: r.updated_at,
};

export function seedRemedies(db) {
  for (const p of Object.values(PRODUCTS)) {
    if (db.prepare("SELECT 1 FROM remedies WHERE sku = ?").get(p.sku)) continue;
    const insert = db.prepare(`INSERT INTO remedies (id, sku, kind, title, item, fits, refund_unit_cents, active, position, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
    (p.remedies ?? []).forEach((r, i) => insert.run(r.id ?? randomUUID(), p.sku, r.kind, r.title, r.item, r.fits, r.refundUnitCents, i, now()));
  }
}

export const activeRemedies = (db, sku) =>
  db.prepare("SELECT * FROM remedies WHERE sku = ? AND active = 1 ORDER BY position, updated_at LIMIT ?").all(sku, MAX_REMEDIES).map(row);

export function remedyLibrary(db) {
  return Object.values(PRODUCTS).map((p) => ({
    sku: p.sku, title: p.title, unitCents: p.unitCents, refImage: `/assets/${p.refImage}`,
    remedies: db.prepare("SELECT * FROM remedies WHERE sku = ? ORDER BY position, updated_at").all(p.sku).map(row),
  }));
}

function clean(input, product) {
  const text = (v, field, max) => {
    const s = String(v ?? "").trim();
    if (s.length < 3 || s.length > max) throw new ClaimError("INVALID", `${field} must be 3 to ${max} characters.`);
    return s;
  };
  const kind = String(input.kind ?? "other");
  if (!KINDS.includes(kind)) throw new ClaimError("INVALID", "Pick a kind of remedy.");
  const cents = Number(input.refundUnitCents);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents >= product.unitCents) {
    throw new ClaimError("INVALID", `The refund must be at least $0 and less than the $${(product.unitCents / 100).toFixed(2)} paid; a full refund is always offered anyway.`);
  }
  return {
    kind, title: text(input.title, "The title", 80), item: text(input.item, "What you send", 160),
    fits: text(input.fits, "When it fits", 400), refundUnitCents: cents, active: input.active === undefined ? true : !!input.active,
  };
}

export function createRemedy(db, input) {
  const product = PRODUCTS[input.sku];
  if (!product) throw new ClaimError("INVALID", "Unknown product.");
  const r = clean(input, product);
  return tx(db, () => {
    const n = db.prepare("SELECT COUNT(*) n, COALESCE(MAX(position), -1) last FROM remedies WHERE sku = ?").get(product.sku);
    if (n.n >= MAX_REMEDIES) throw new ClaimError("TOO_MANY_REMEDIES", `Up to ${MAX_REMEDIES} remedies per product.`, 409);
    const id = randomUUID();
    db.prepare(`INSERT INTO remedies (id, sku, kind, title, item, fits, refund_unit_cents, active, position, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, product.sku, r.kind, r.title, r.item, r.fits, r.refundUnitCents, r.active ? 1 : 0, n.last + 1, now());
    return row(db.prepare("SELECT * FROM remedies WHERE id = ?").get(id));
  });
}

export function updateRemedy(db, id, input) {
  const current = row(db.prepare("SELECT * FROM remedies WHERE id = ?").get(id));
  if (!current) throw new ClaimError("NOT_FOUND", "No such remedy.", 404);
  const r = clean({ ...current, ...input }, PRODUCTS[current.sku]);
  db.prepare(`UPDATE remedies SET kind = ?, title = ?, item = ?, fits = ?, refund_unit_cents = ?, active = ?, updated_at = ? WHERE id = ?`)
    .run(r.kind, r.title, r.item, r.fits, r.refundUnitCents, r.active ? 1 : 0, now(), id);
  return row(db.prepare("SELECT * FROM remedies WHERE id = ?").get(id));
}
