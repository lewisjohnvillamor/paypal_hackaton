// The demo storefront. Prices live on the server; the browser never sends an amount.
export const PRODUCTS = {
  "MUG-CLASSIC": {
    sku: "MUG-CLASSIC",
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
};

// The rest of the store's listings. Claude Haiku may suggest one of these as a remedy, but only
// from a short list the server narrows by category and damage first (src/suggest/candidates.js);
// a real store would run the same filter as an indexed query over thousands of listings.
// Tags: the product categories a listing fits, then the kinds of damage it helps with.
export const LISTINGS = [
  { id: "L-KINTSUGI", kind: "repair_kit", title: "Kintsugi repair kit, gold powder", priceCents: 800, tags: ["ceramic-mug", "ceramic-plate", "chip", "crack", "handle"] },
  { id: "L-KINTSUGI-GOLD", kind: "repair_kit", title: "24k gold-leaf kintsugi kit", priceCents: 900, tags: ["ceramic-mug", "ceramic-plate", "chip", "crack", "handle"] },
  { id: "L-GLAZE-PEN", kind: "repair_kit", title: "Food-safe white glaze touch-up pen", priceCents: 600, tags: ["ceramic-mug", "ceramic-plate", "chip"] },
  { id: "L-CERAMIC-GLUE", kind: "repair_kit", title: "Food-safe ceramic epoxy, clear", priceCents: 700, tags: ["ceramic-mug", "ceramic-plate", "handle", "crack"] },
  { id: "L-MUG-CLASSIC", kind: "replacement", title: "Classic white ceramic mug", priceCents: 2000, tags: ["ceramic-mug", "shattered", "handle", "crack", "chip"] },
  { id: "L-MUG-SECOND", kind: "replacement", title: "Classic white mug, studio second (tiny glaze flaw)", priceCents: 1200, tags: ["ceramic-mug", "shattered", "handle", "crack", "chip"] },
  { id: "L-MUG-SPECKLE", kind: "replacement", title: "Speckled stoneware mug", priceCents: 2400, tags: ["ceramic-mug", "shattered", "handle", "crack", "chip"] },
  { id: "L-PLANTER", kind: "other", title: "Drainage-hole drill kit to turn a broken mug into a planter", priceCents: 500, tags: ["ceramic-mug", "crack", "chip", "handle"] },
  { id: "L-MOSAIC", kind: "other", title: "Mosaic coaster kit for broken ceramic pieces", priceCents: 1000, tags: ["ceramic-mug", "ceramic-plate", "shattered"] },
  { id: "L-SAUCER", kind: "other", title: "Matching white saucer", priceCents: 900, tags: ["ceramic-saucer"] },
  { id: "L-PLATE", kind: "other", title: "Classic white dinner plate", priceCents: 1800, tags: ["ceramic-plate"] },
  { id: "L-TEA-TOWEL", kind: "other", title: "Linen tea towel", priceCents: 1100, tags: ["textile"] },
  { id: "L-COASTERS", kind: "other", title: "Cork coaster set", priceCents: 800, tags: ["accessory"] },
  { id: "L-GIFT-BOX", kind: "other", title: "Gift box with tissue", priceCents: 300, tags: ["packaging"] },
];

export const DEMO_CART = [{ sku: "MUG-CLASSIC", quantity: 4 }];
