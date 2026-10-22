// The demo storefront. Prices live on the server; the browser never sends an amount.
export const PRODUCTS = {
  "MUG-CLASSIC": {
    sku: "MUG-CLASSIC",
    title: "Classic white ceramic mug",
    unitCents: 2000,
    refImage: "catalog-mug.jpg",
    // Starting remedy library. The merchant edits it on the Remedies page; Jev reads each "fits"
    // line against the photos and the best-fitting ones become the buyer's options.
    remedies: [
      { id: "kintsugi", kind: "repair_kit", title: "Keep it and mend it with kintsugi", item: "kintsugi repair kit with gold powder",
        fits: "Mends a chip, a crack, or a snapped-off handle on a ceramic mug that is otherwise in one piece. Cannot rebuild a mug broken into many pieces.",
        refundUnitCents: 1200 },
      { id: "kintsugi_gold", kind: "repair_kit", title: "Mend it in 24k gold leaf", item: "24k gold-leaf kintsugi kit (its $9 price comes off the refund)",
        fits: "Mends a chip, a crack, or a snapped-off handle on a ceramic mug that is otherwise in one piece, with real gold leaf. Cannot rebuild a mug broken into many pieces.",
        refundUnitCents: 300 },
      { id: "replacement", kind: "replacement", title: "Get a new one, shipped free", item: "a new Classic white ceramic mug",
        fits: "Any damage to the mug, including one broken into pieces or damaged beyond repair.",
        refundUnitCents: 0 },
    ],
  },
};

export const DEMO_CART = [{ sku: "MUG-CLASSIC", quantity: 4 }];
