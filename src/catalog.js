// The demo storefront. Prices live on the server; the browser never sends an amount.
export const PRODUCTS = {
  "MUG-CLASSIC": {
    sku: "MUG-CLASSIC",
    title: "Classic white ceramic mug",
    unitCents: 2000,
    refImage: "catalog-mug.jpg",
    // A chipped or cracked mug, or one with a snapped handle, can be kept and mended with
    // kintsugi (lacquer and gold). The shop sets the amounts; the buyer can always take a full refund.
    repair: {
      refundUnitCents: 1200,
      kit: "kintsugi repair kit with gold powder",
      upgrade: { kit: "24k gold-leaf kintsugi kit", unitCents: 900 },
    },
  },
};

export const DEMO_CART = [{ sku: "MUG-CLASSIC", quantity: 4 }];
