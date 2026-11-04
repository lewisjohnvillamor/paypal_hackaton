// Remedies are only offered for the damage they put right, and the best fit is called out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFindings } from "./helpers.js";
import { resolutionOptions } from "../src/policy/refundPolicy.js";
import { PRODUCTS } from "../src/catalog.js";
import { damageKindOf, fixesDamage } from "../src/kinds.js";

const mug = PRODUCTS["MUG-CLASSIC"].remedies;
const findings = (damage_kind, remedyFit, confidence = 0.9) => ({
  ...clearFindings, damage_kind, remedyFit, signals: { ...clearFindings.signals, damage_kind: { choice: damage_kind, confidence } },
});
const offer = (f, remedies = mug) => resolutionOptions({ remedies, quantity: 1, findings: f, amountCents: 2000, category: "ceramic-mug" });
const ids = (opts) => opts.map((o) => o.id);
const fit = { kintsugi: 0.9, kintsugi_gold: 0.85, replacement: 0.6 };

test("a repair kit is never offered for damage it cannot fix, however high the fit score", () => {
  // A mug in pieces: the photo check may still score a kit, but kits fix chips and handles only.
  assert.deepEqual(ids(offer(findings("shattered", fit))), ["refund", "replacement"]);
  assert.deepEqual(ids(offer(findings("crack_or_chip", fit))), ["refund", "kintsugi", "kintsugi_gold", "replacement"]);
  assert.deepEqual([...offer(findings("crack_or_chip", fit))[1].fixes].sort(), ["crack_or_chip", "handle_off"]);
});

test("unsure of the damage type, only what fixes every type is offered", () => {
  assert.deepEqual(ids(offer(findings("crack_or_chip", fit, 0.4))), ["refund", "replacement"]);
  assert.equal(damageKindOf(findings("crack_or_chip", fit, 0.4)), null);
  assert.equal(damageKindOf(findings("none_visible", fit)), null);
  assert.equal(fixesDamage(null, "ceramic-mug", "shattered"), true); // a remedy saved before eligibility existed
  assert.equal(fixesDamage(["shattered", "handle_off", "crack_or_chip"], "ceramic-mug", null), true);
  assert.equal(fixesDamage(["crack_or_chip"], "ceramic-mug", null), false);
});

test("the best fit is marked only when it is confident and clearly ahead", () => {
  const plain = mug.map((r) => ({ ...r, featured: false })); // no shop's pick: the scores decide
  const best = (f) => offer(findings("crack_or_chip", f), plain).filter((o) => o.best).map((o) => o.id);
  assert.deepEqual(best({ kintsugi: 0.6, kintsugi_gold: 0.95, replacement: 0.55 }), ["kintsugi_gold"]);
  assert.deepEqual(best({ kintsugi: 0.9, kintsugi_gold: 0.85 }), []); // too close to call
  assert.deepEqual(best({ kintsugi: 0.65, kintsugi_gold: 0.5 }), []); // not sure enough
  assert.ok(!offer(findings("crack_or_chip", fit), plain)[0].best); // never the plain refund
});

test("the shop's pick is highlighted whenever it is eligible and fits, even when another kit scores the same", () => {
  const remedies = mug.map((r) => ({ ...r, featured: r.id === "kintsugi_gold" }));
  const opts = resolutionOptions({ remedies, quantity: 1, findings: findings("crack_or_chip", { kintsugi: 0.97, kintsugi_gold: 0.96, replacement: 0.9 }), amountCents: 2000, category: "ceramic-mug" });
  assert.deepEqual(opts.filter((o) => o.best).map((o) => [o.id, o.highlight]), [["kintsugi_gold", "shop_pick"]]);
  // Not for a mug in pieces: the pick is not eligible there, so nothing is forced on the buyer.
  const pieces = resolutionOptions({ remedies, quantity: 1, findings: findings("shattered", { kintsugi_gold: 0.9, replacement: 0.95 }), amountCents: 2000, category: "ceramic-mug" });
  assert.deepEqual(pieces.map((o) => [o.id, o.highlight ?? null]), [["refund", null], ["replacement", "best_fit"]]);
});
