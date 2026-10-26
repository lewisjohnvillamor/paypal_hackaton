# Several kinds of product

Last updated 2026-10-23 (product-match layer added).

The store now sells four very different products: a ceramic mug ($20), a clear glass bud vase
($45), an organic cotton T-shirt ($25) and wireless over-ear headphones ($120). The buyer fills a
bag, pays once with PayPal, and can report a problem with any item on the order.

## What changes per product kind

Everything that depends on what the product is lives in one entry in `src/kinds.js`:

- how Jev's questions name the item and what counts as visible damage
- the damage types Jev picks from (mug: broken / handle off / crack or chip; vase: broken / crack
  or chip; T-shirt: stain / tear or hole / seam or print; headphones: snapped / cushion torn /
  scratches)
- what "same design" means when comparing with the catalog photo
- which listing tags each damage type narrows Haiku's candidates to

The PayPal order, capture, refund gate, merchant approval, remedy library, buyer offers and Haiku
checks do not know or care which product it is. The kind comes from the catalog entry of the
order line, never from the buyer.

## How Haiku knows what to suggest, and that it is in stock

1. The order line fixes the product, so only listings tagged with its category qualify.
2. Listings with `stock: 0` are left out.
3. Jev's damage type keeps only listings tagged for that damage (all damage tags of the kind
   when Jev is unsure).
4. Haiku sees at most 12 of those, with price and stock, and may only answer with their ids
   (enforced by the JSON schema).
5. The server drops any id that was not on the list and any refund that would make the listing
   plus refund worth more than the price paid.
6. The merchant adds or dismisses each suggestion before the buyer sees it.

Out of stock in the demo catalog: `L-VASE-SECOND`, `L-MENDING-KIT`, `L-HP-HEADBAND`. Tests check
they are never offered.

## Is it the product the shop sold?

Two independent checks compare the claim photos with the catalog photo:

1. **Jev** answers whether it is the same kind of product and whether the design matches (colour,
   print, shape or cut).
2. **Claude Haiku's second check** (`checkItemMatch` in `src/ai/haiku.js`) looks at the photos,
   the catalog photo and the product name, and answers `yes`, `no` or `unsure`, with one sentence
   on what differs. It is told to judge only what damage cannot change (colour, material, print,
   branding), so broken pieces and stains are not read as a different product.

If either says it is a different product (`itemConfirmed` in `src/policy/refundPolicy.js`), the
case goes to the merchant with the plain refund only: no repair kits, no replacements, no Haiku
suggestions. The "Ask the buyer" box is pre-filled with a request for a photo of the whole item
and its label. The merchant can still refund with a written reason. "Unsure" from either check
does not block. A failed Haiku call is recorded and Jev's checks stand alone.

## Live check (jev-1.14.0, claude-haiku-5-5), `node --env-file=.env probe/products-live.js`

Haiku's second check, 2026-10-23, after tuning the prompt so damage is not read as a difference:

| Photo | Product sold | Jev design | Haiku second check | Offers |
|---|---|---|---|---|
| White mug, handle snapped (`broken-handle-white`) | white mug | unsure | yes | shown |
| Green hand-painted cup, chipped | white mug | mismatch | no | held |
| Rocket-print mug, broken | white mug | mismatch | no | held |
| Red Riding Hood figurine in pieces (2 photos) | white mug | - | no | held |
| Blue mug, cartoon mug (intact) | white mug | - | no | held |
| Patchwork white garment, stained | white T-shirt | mismatch | yes | held (Jev) |
| Green fabric with a hole | white T-shirt | unsure | no | held |
| Clear cylinder vase, cracked | clear vase | match | yes | shown |
| Wavy-rim glass vessel, broken | clear vase | mismatch | unsure | held (Jev) |
| Three different broken headphone models | black wireless headphones | mismatch | no | held |

Every photo of a different product was held by at least one check; both photos of the actual
product passed. Haiku's second check took 1.2-2.8 s and runs alongside the suggestion call.

The real damage photos found for the T-shirt and headphones are of other models, so they now
correctly get the refund only. A matching damaged T-shirt or headphone photo (the same white tee
or the same black headphones) would get the full set of offers.

## Live sandbox run

`CHROMIUM_PATH=/opt/pw-browsers/chromium node --env-file=.env scripts/record-products.js`:
$215.00 order (vase, two T-shirts, headphones), the cracked vase reported, Jev and Haiku both
confirmed it is the vase sold, Haiku suggested the recycled glass vase, the merchant added it,
the buyer picked it, PayPal refund `08173433BC803262Y` for $10.00 COMPLETED.

## Known gaps

- Haiku can suggest a listing that duplicates a library remedy (both a "stain remover kit"), with
  a different refund. The merchant sees both and can dismiss one.
- Stock is read from the catalog file; a real store would read it from inventory at suggestion
  time and again when the buyer picks.
- One open request per order still applies, so a second item on the same order waits until the
  first request is resolved.

Photo credits: `probe/products/sources.json` (Openverse, CC BY / CC BY-SA / CC0).
