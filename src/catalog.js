// The demo storefront. Prices live on the server; the browser never sends an amount.
export const PRODUCTS = {
  "MUG-CLASSIC": {
    sku: "MUG-CLASSIC",
    blurb: "Glazed stoneware, made in small batches.",
    title: "Classic white ceramic mug",
    unitCents: 2000,
    category: "ceramic-mug",
    refImage: "catalog-mug.jpg",
    // Starting remedy library. The merchant edits it on the Remedies page; Jev reads each "fits"
    // line against the photos and the best-fitting ones become the buyer's options.
    remedies: [
      { id: "kintsugi", kind: "repair_kit", title: "Keep it and mend it with kintsugi", item: "a kintsugi repair kit with gold powder",
        fits: "Mends a chip, a crack, or a snapped-off handle on a ceramic mug that is otherwise in one piece. Cannot rebuild a mug broken into many pieces.",
        refundUnitCents: 1200 },
      { id: "kintsugi_gold", kind: "repair_kit", title: "Mend it in 24k gold leaf ($9 kit)", item: "a 24k gold-leaf kintsugi kit",
        fits: "Mends a chip, a crack, or a snapped-off handle on a ceramic mug that is otherwise in one piece, with real gold leaf. Cannot rebuild a mug broken into many pieces.",
        refundUnitCents: 300 },
      { id: "replacement", kind: "replacement", title: "Get a new one, shipped free", item: "a new Classic white ceramic mug",
        fits: "Any damage to the mug, including one broken into pieces or damaged beyond repair.",
        refundUnitCents: 0 },
    ],
  },
  "VASE-GLASS": {
    sku: "VASE-GLASS",
    blurb: "Mouth-blown clear glass, 22 cm tall.",
    title: "Clear glass cylinder vase",
    unitCents: 4500,
    category: "glass-vase",
    refImage: "catalog-vase.jpg",
    remedies: [
      { id: "vase_resin", kind: "repair_kit", title: "Keep it and seal the crack with glass resin", item: "a UV-cure glass repair resin kit",
        fits: "Seals a hairline crack or fills a small chip in a glass vase that is still in one piece and holds its shape. Cannot rebuild a vase broken into pieces.",
        refundUnitCents: 2500 },
      { id: "vase_replacement", kind: "replacement", title: "Get a new one, shipped free", item: "a new Clear glass cylinder vase",
        fits: "Any damage to the vase, including one cracked through or broken into pieces.",
        refundUnitCents: 0 },
    ],
  },
  "TEE-ORGANIC": {
    sku: "TEE-ORGANIC",
    blurb: "Heavyweight organic cotton, white.",
    title: "Organic cotton T-shirt",
    unitCents: 2500,
    category: "cotton-tee",
    refImage: "catalog-tee.jpg",
    remedies: [
      { id: "tee_stain_kit", kind: "repair_kit", title: "Keep it with a stain remover kit", item: "an enzyme stain remover kit",
        fits: "Lifts a stain or discoloured mark on a cotton T-shirt whose fabric is otherwise intact. Does not fix tears, holes or split seams.",
        refundUnitCents: 1500 },
      { id: "tee_patch_kit", kind: "repair_kit", title: "Keep it with an iron-on mending kit", item: "an iron-on patch and mending kit",
        fits: "Mends a small tear, hole or split seam in a cotton T-shirt. Does not remove stains, and cannot fix a large rip.",
        refundUnitCents: 1500 },
      { id: "tee_replacement", kind: "replacement", title: "Get a new one, shipped free", item: "a new Organic cotton T-shirt in the same size",
        fits: "Any damage to the T-shirt: stains, tears, holes, split seams or a peeling print.",
        refundUnitCents: 0 },
    ],
  },
  "HEADPHONES-OVER": {
    sku: "HEADPHONES-OVER",
    blurb: "Bluetooth, 30-hour battery, folding.",
    title: "Wireless over-ear headphones",
    unitCents: 12000,
    category: "headphones",
    refImage: "catalog-headphones.jpg",
    remedies: [
      { id: "hp_cushions", kind: "repair_kit", title: "Keep them with new ear cushions", item: "a pair of replacement ear cushions",
        fits: "Fixes headphones whose ear cushion is torn, peeling or missing, when the headband, hinges and ear cups are not broken.",
        refundUnitCents: 3000 },
      { id: "hp_keep_case", kind: "other", title: "Keep them, with a free case and $30 back", item: "a hard-shell carry case",
        fits: "Headphones with scratches, scuffs or small dents only, where nothing is cracked, snapped or torn.",
        refundUnitCents: 3000 },
      { id: "hp_replacement", kind: "replacement", title: "Get a new pair, shipped free", item: "a new pair of Wireless over-ear headphones",
        fits: "Any damage to the headphones, including a cracked or snapped headband, hinge or ear cup.",
        refundUnitCents: 0 },
    ],
  },
};

// The rest of the store's listings. Claude Haiku may suggest one of these as a remedy, but only
// from a short list the server narrows by category and damage first (src/suggest/candidates.js);
// a real store would run the same filter as an indexed query over thousands of listings.
// Tags: the product categories a listing fits, then the kinds of damage it helps with (src/kinds.js).
// stock: units on hand. A listing with none is never put in front of Haiku.
export const LISTINGS = [
  { id: "L-KINTSUGI", kind: "repair_kit", title: "Kintsugi repair kit, gold powder", priceCents: 800, stock: 40, tags: ["ceramic-mug", "ceramic-plate", "chip", "crack", "handle"] },
  { id: "L-KINTSUGI-GOLD", kind: "repair_kit", title: "24k gold-leaf kintsugi kit", priceCents: 900, stock: 12, tags: ["ceramic-mug", "ceramic-plate", "chip", "crack", "handle"] },
  { id: "L-GLAZE-PEN", kind: "repair_kit", title: "Food-safe white glaze touch-up pen", priceCents: 600, stock: 25, tags: ["ceramic-mug", "ceramic-plate", "chip"] },
  { id: "L-CERAMIC-GLUE", kind: "repair_kit", title: "Food-safe ceramic epoxy, clear", priceCents: 700, stock: 30, tags: ["ceramic-mug", "ceramic-plate", "handle", "crack"] },
  { id: "L-MUG-CLASSIC", kind: "replacement", title: "Classic white ceramic mug", priceCents: 2000, stock: 120, tags: ["ceramic-mug", "shattered", "handle", "crack", "chip"] },
  { id: "L-MUG-SECOND", kind: "replacement", title: "Classic white mug, studio second (tiny glaze flaw)", priceCents: 1200, stock: 18, tags: ["ceramic-mug", "shattered", "handle", "crack", "chip"] },
  { id: "L-MUG-SPECKLE", kind: "replacement", title: "Speckled stoneware mug", priceCents: 2400, stock: 9, tags: ["ceramic-mug", "shattered", "handle", "crack", "chip"] },
  { id: "L-PLANTER", kind: "other", title: "Drainage-hole drill kit to turn a broken mug into a planter", priceCents: 500, stock: 15, tags: ["ceramic-mug", "crack", "chip", "handle"] },
  { id: "L-MOSAIC", kind: "other", title: "Mosaic coaster kit for broken ceramic pieces", priceCents: 1000, stock: 7, tags: ["ceramic-mug", "ceramic-plate", "shattered"] },
  { id: "L-VASE-GLASS", kind: "replacement", title: "Clear glass cylinder vase", priceCents: 4500, stock: 30, tags: ["glass-vase", "shattered", "crack", "chip"] },
  { id: "L-VASE-SECOND", kind: "replacement", title: "Clear glass cylinder vase, second (small bubble in the glass)", priceCents: 2800, stock: 0, tags: ["glass-vase", "shattered", "crack", "chip"] },
  { id: "L-VASE-RECYCLED", kind: "replacement", title: "Recycled green glass vase", priceCents: 3200, stock: 14, tags: ["glass-vase", "shattered", "crack", "chip"] },
  { id: "L-GLASS-RESIN", kind: "repair_kit", title: "UV-cure glass repair resin", priceCents: 1400, stock: 20, tags: ["glass-vase", "crack", "chip"] },
  { id: "L-DRIED-FLOWERS", kind: "other", title: "Dried flower bundle (hides a chipped rim)", priceCents: 1600, stock: 10, tags: ["glass-vase", "chip"] },
  { id: "L-TEE-ORGANIC", kind: "replacement", title: "Organic cotton T-shirt", priceCents: 2500, stock: 200, tags: ["cotton-tee", "stain", "tear", "seam"] },
  { id: "L-TEE-FACTORY", kind: "replacement", title: "Organic cotton T-shirt, factory second (off-centre label)", priceCents: 1500, stock: 35, tags: ["cotton-tee", "stain", "tear", "seam"] },
  { id: "L-STAIN-KIT", kind: "repair_kit", title: "Enzyme stain remover kit", priceCents: 900, stock: 50, tags: ["cotton-tee", "textile", "stain"] },
  { id: "L-MENDING-KIT", kind: "repair_kit", title: "Iron-on patch and mending kit", priceCents: 800, stock: 0, tags: ["cotton-tee", "textile", "tear", "seam"] },
  { id: "L-EMBROIDERY", kind: "repair_kit", title: "Visible-mending embroidery kit", priceCents: 1200, stock: 8, tags: ["cotton-tee", "textile", "tear", "stain"] },
  { id: "L-HEADPHONES-OVER", kind: "replacement", title: "Wireless over-ear headphones", priceCents: 12000, stock: 25, tags: ["headphones", "snapped", "cushion", "cosmetic"] },
  { id: "L-HP-REFURB", kind: "replacement", title: "Wireless over-ear headphones, certified refurbished", priceCents: 7900, stock: 6, tags: ["headphones", "snapped", "cushion", "cosmetic"] },
  { id: "L-HP-CUSHIONS", kind: "repair_kit", title: "Replacement ear cushions, pair", priceCents: 2200, stock: 40, tags: ["headphones", "cushion"] },
  { id: "L-HP-HEADBAND", kind: "repair_kit", title: "Replacement headband with hinges", priceCents: 3500, stock: 0, tags: ["headphones", "snapped"] },
  { id: "L-HP-CASE", kind: "other", title: "Hard-shell carry case", priceCents: 2500, stock: 30, tags: ["headphones", "cosmetic"] },
  { id: "L-SAUCER", kind: "other", title: "Matching white saucer", priceCents: 900, stock: 60, tags: ["ceramic-saucer"] },
  { id: "L-PLATE", kind: "other", title: "Classic white dinner plate", priceCents: 1800, stock: 45, tags: ["ceramic-plate"] },
  { id: "L-TEA-TOWEL", kind: "other", title: "Linen tea towel", priceCents: 1100, stock: 70, tags: ["textile"] },
  { id: "L-COASTERS", kind: "other", title: "Cork coaster set", priceCents: 800, stock: 55, tags: ["accessory"] },
  { id: "L-GIFT-BOX", kind: "other", title: "Gift box with tissue", priceCents: 300, stock: 300, tags: ["packaging"] },
];

export const DEMO_CART = [{ sku: "MUG-CLASSIC", quantity: 4 }];
