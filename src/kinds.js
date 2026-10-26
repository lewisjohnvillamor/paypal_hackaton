// What "damaged" means for each kind of product the store sells. Jev's questions, the damage types
// it chooses from, and the listing tags those damage types narrow Haiku's candidates to all come
// from here, so adding a product kind is one entry, not a change to the evidence code.
//   noun:     how a question names the item ("a ceramic drinking mug")
//   damage:   what visible damage looks like, for the yes/no and box questions
//   design:   what "same design" means when comparing with the catalog photo
//   kinds:    damage types Jev picks from: { key: [description for Jev, short label, listing tags] }
// "none_visible" is added to every kind.
export const KINDS = {
  "ceramic-mug": {
    noun: "a ceramic drinking mug or cup",
    damage: "a crack, a chip, a snapped-off handle, or broken pieces",
    design: "same colour and glaze, same printed pattern or lack of one, and the same overall shape",
    kinds: {
      shattered: ["Broken into several pieces.", "broken into pieces", ["shattered"]],
      handle_off: ["The handle is snapped off; the body may be whole.", "handle snapped off", ["handle"]],
      crack_or_chip: ["A crack, hairline, or chip; still in one piece.", "a crack or chip", ["chip", "crack"]],
    },
  },
  "glass-vase": {
    noun: "a glass flower vase",
    damage: "a crack, a chip on the rim or base, or broken pieces",
    design: "same glass colour and clarity, same shape and height, same pattern or lack of one",
    kinds: {
      shattered: ["Broken into several pieces.", "broken into pieces", ["shattered"]],
      crack_or_chip: ["A crack or a chip; still in one piece.", "a crack or chip", ["chip", "crack"]],
    },
  },
  "cotton-tee": {
    noun: "a cotton T-shirt",
    damage: "a stain, a tear or hole in the fabric, a split seam, or a peeling print",
    design: "same fabric colour, same print or lack of one, and the same cut (sleeve length, neckline)",
    kinds: {
      stain: ["A stain or discoloured mark on the fabric.", "a stain", ["stain"]],
      tear_or_hole: ["A tear, rip or hole in the fabric.", "a tear or hole", ["tear"]],
      seam_or_print: ["A seam coming apart, or a print cracking or peeling.", "a split seam or peeling print", ["seam"]],
    },
  },
  headphones: {
    noun: "a pair of over-ear headphones",
    damage: "a cracked or snapped headband or hinge, a torn or missing ear cushion, or deep scratches and dents",
    design: "same colour and finish, same headband and ear-cup shape, same logo placement",
    kinds: {
      snapped: ["The headband, hinge or an ear cup is cracked or snapped.", "headband or hinge broken", ["snapped"]],
      cushion_torn: ["An ear cushion is torn, peeling or missing.", "ear cushion torn", ["cushion"]],
      cosmetic: ["Scratches, scuffs or dents only; nothing broken.", "scratches or dents", ["cosmetic"]],
    },
  },
};

const NONE = ["No damage is visible.", "no damage visible", []];

export function kindOf(category) {
  const k = KINDS[category] ?? KINDS["ceramic-mug"];
  return { ...k, kinds: { ...k.kinds, none_visible: NONE } };
}

// Short labels for every damage type of every kind ("handle_off" -> "handle snapped off").
export const DAMAGE_LABELS = Object.fromEntries(
  Object.values(KINDS).flatMap((k) => Object.entries({ ...k.kinds, none_visible: NONE }).map(([key, v]) => [key, v[1]])),
);

// Listing tags that help with a damage type, or every damage tag of the kind when Jev was unsure.
export function damageTags(category, damageKind) {
  const { kinds } = kindOf(category);
  const tags = kinds[damageKind]?.[2];
  return tags?.length ? tags : Object.values(kinds).flatMap((v) => v[2]);
}
