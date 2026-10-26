// Several kinds of product: each gets its own damage wording for Jev, its own damage types, and
// listings narrowed by its category, stock and damage. Pure functions only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRODUCTS, LISTINGS } from "../src/catalog.js";
import { KINDS, damageTags } from "../src/kinds.js";
import { buildLocateRequest, buildRequest } from "../src/ai/jev.js";
import { candidatesFor } from "../src/suggest/candidates.js";
import { cartLines } from "../src/orders.js";

const ids = (sku, damage_kind) => candidatesFor(sku, { damage_kind }).map((c) => c.id);

test("every product has a kind with its own damage types, a catalog photo and a remedy library", () => {
  for (const p of Object.values(PRODUCTS)) {
    assert.ok(KINDS[p.category], p.sku);
    assert.ok(p.refImage && p.remedies.length, p.sku);
    for (const r of p.remedies) assert.ok(r.refundUnitCents < p.unitCents && r.item.length >= 3, `${p.sku} ${r.id}`);
  }
});

test("Jev is asked about the ordered kind of product, in its own words", () => {
  const photos = [Buffer.from("x")], reference = Buffer.from("y");
  const tee = buildRequest({ photos, reference, category: "cotton-tee" });
  assert.match(tee.questions.visible_breakage.instructions, /T-shirt.*stain/);
  assert.deepEqual(Object.keys(tee.questions.damage_kind.criteria), ["stain", "tear_or_hole", "seam_or_print", "none_visible"]);
  assert.doesNotMatch(JSON.stringify(tee.questions), /mug|handle/i);
  const hp = buildRequest({ photos, reference, category: "headphones" });
  assert.ok("cushion_torn" in hp.questions.damage_kind.criteria);
  assert.match(buildLocateRequest(Buffer.from("x"), "glass-vase").questions.damaged.instructions, /chip on the rim/);
  // No category falls back to the mug wording, so older callers keep working.
  assert.match(buildRequest({ photos, reference }).questions.visible_breakage.instructions, /mug/);
});

test("listings are narrowed by the product's category and the damage Jev saw", () => {
  assert.deepEqual(ids("TEE-ORGANIC", "stain").sort(), ["L-EMBROIDERY", "L-STAIN-KIT", "L-TEE-FACTORY"]);
  assert.ok(ids("HEADPHONES-OVER", "cushion_torn").includes("L-HP-CUSHIONS"));
  assert.ok(!ids("HEADPHONES-OVER", "cosmetic").includes("L-HP-CUSHIONS"));
  assert.ok(ids("VASE-GLASS", "crack_or_chip").includes("L-GLASS-RESIN"));
  // Never another product's listings, and never the ordered product itself.
  for (const [sku, p] of Object.entries(PRODUCTS)) {
    for (const k of Object.keys(KINDS[p.category].kinds)) {
      for (const c of candidatesFor(sku, { damage_kind: k })) {
        const l = LISTINGS.find((x) => x.id === c.id);
        assert.ok(l.tags.includes(p.category) && l.id !== `L-${sku}`, `${sku} ${k} ${c.id}`);
      }
    }
  }
  // Unsure damage type: any damage tag of the kind.
  assert.deepEqual(damageTags("headphones", "none_visible").sort(), ["cosmetic", "cushion", "snapped"]);
});

test("anything out of stock is never offered to Haiku", () => {
  const out = LISTINGS.filter((l) => l.stock === 0).map((l) => l.id);
  assert.ok(out.includes("L-MENDING-KIT") && out.includes("L-HP-HEADBAND") && out.includes("L-VASE-SECOND"));
  assert.ok(!ids("TEE-ORGANIC", "tear_or_hole").includes("L-MENDING-KIT"));
  assert.ok(!ids("HEADPHONES-OVER", "snapped").includes("L-HP-HEADBAND"));
  assert.ok(!ids("VASE-GLASS", "shattered").includes("L-VASE-SECOND"));
  const restocked = LISTINGS.map((l) => (l.id === "L-MENDING-KIT" ? { ...l, stock: 3 } : l));
  assert.ok(candidatesFor("TEE-ORGANIC", { damage_kind: "tear_or_hole" }, restocked).some((c) => c.id === "L-MENDING-KIT"));
});

test("the cart is priced from the catalog and rejects unknown products and bad quantities", () => {
  const lines = cartLines([{ sku: "VASE-GLASS", quantity: 1 }, { sku: "TEE-ORGANIC", quantity: 2 }, { sku: "VASE-GLASS", quantity: 1 }, { sku: "MUG-CLASSIC", quantity: 0 }]);
  assert.deepEqual(lines.map((l) => [l.sku, l.quantity, l.unitCents]), [["VASE-GLASS", 2, 4500], ["TEE-ORGANIC", 2, 2500]]);
  assert.deepEqual(cartLines(undefined).map((l) => [l.sku, l.quantity]), [["MUG-CLASSIC", 4]]);
  for (const bad of [[{ sku: "NOPE", quantity: 1 }], [{ sku: "MUG-CLASSIC", quantity: 1.5 }], [{ sku: "MUG-CLASSIC", quantity: -1 }],
    [{ sku: "MUG-CLASSIC", quantity: 0 }], [{ sku: "MUG-CLASSIC", quantity: 11 }], [{ sku: "MUG-CLASSIC", quantity: 1, unitCents: 1 }].map((x) => ({ ...x, quantity: "1" }))]) {
    assert.throws(() => cartLines(bad), /isn't in the store|whole numbers|empty|Up to/);
  }
});
