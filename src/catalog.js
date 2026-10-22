// The demo storefront. Prices live on the server; the browser never sends an amount.
export const PRODUCTS = {
  "MUG-CLASSIC": {
    sku: "MUG-CLASSIC",
    title: "Classic white ceramic mug",
    unitCents: 2000,
    refImage: "catalog-mug.jpg",
  },
};

export const DEMO_CART = [{ sku: "MUG-CLASSIC", quantity: 4 }];
