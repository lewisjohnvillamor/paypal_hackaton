// Narrowing the store's listings to the few a suggestion could use, before any model sees them.
// A listing is only a candidate when it is eligible for this item and this damage, set on the
// listing itself (src/catalog.js), never inferred:
//   - it is offered for the product's category;
//   - it fixes the damage type the photo check settled on (unsure: only what fixes every type);
//   - a replacement is the same product (its "replaces" names this SKU), never a look-alike;
//   - it is in stock.
// With thousands of listings this is the same filters as an indexed query, so the model always gets
// a short list of usable options and can only answer with ids from it.
import { LISTINGS, PRODUCTS } from "../catalog.js";
import { damageKindOf, fixesDamage } from "../kinds.js";

export const MAX_CANDIDATES = 12;

export function eligibleListing(l, sku, kind) {
  const product = PRODUCTS[sku];
  if (!product?.category || !l.categories?.includes(product.category)) return false;
  if (l.id === `L-${sku}`) return false; // the library's own replacement already covers it
  if (l.kind === "replacement" && !l.replaces?.includes(sku)) return false;
  if (!l.damage?.length || !fixesDamage(l.damage, product.category, kind)) return false;
  return (l.stock ?? 1) > 0;
}

export function candidatesFor(sku, findings, listings = LISTINGS, max = MAX_CANDIDATES, minSure) {
  if (!PRODUCTS[sku]?.category || !findings) return [];
  const kind = damageKindOf(findings, minSure);
  return listings
    .filter((l) => eligibleListing(l, sku, kind))
    // Most specific first: a kit for this exact damage before something that fixes anything.
    .sort((a, b) => a.damage.length - b.damage.length || a.priceCents - b.priceCents)
    .slice(0, max)
    .map((l) => ({ id: l.id, kind: l.kind, title: l.title, priceCents: l.priceCents, stock: l.stock, fixes: l.damage }));
}
