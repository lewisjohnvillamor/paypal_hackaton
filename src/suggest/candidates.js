// Narrowing the store's listings to the few a suggestion could use, before any model sees them.
// The order already fixes the product, so only listings tagged for its category qualify; Jev's
// damage reading then keeps the ones tagged for that damage (src/kinds.js), and anything out of
// stock is left out. With thousands of listings this is the same filters as an indexed query
// (category, stock, then damage tag), so the model always gets a short list and can only answer
// with ids from it.
import { LISTINGS, PRODUCTS } from "../catalog.js";
import { damageTags } from "../kinds.js";

export const MAX_CANDIDATES = 12;

export function candidatesFor(sku, findings, listings = LISTINGS, max = MAX_CANDIDATES) {
  const product = PRODUCTS[sku];
  if (!product?.category || !findings) return [];
  // Unsure about the kind of damage: anything for this product category may fit.
  const wanted = damageTags(product.category, findings.damage_kind);
  return listings
    .filter((l) => l.tags.includes(product.category) && l.id !== `L-${sku}` && (l.stock ?? 1) > 0)
    .map((l) => ({ l, hits: wanted.filter((t) => l.tags.includes(t)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.l.priceCents - b.l.priceCents)
    .slice(0, max)
    .map(({ l }) => ({ id: l.id, kind: l.kind, title: l.title, priceCents: l.priceCents, stock: l.stock }));
}
