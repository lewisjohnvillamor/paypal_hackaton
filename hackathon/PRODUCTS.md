# Several kinds of product

Last updated 2026-10-23.

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

## Live check (jev-1.14.0, claude-haiku-5-5), `node --env-file=.env probe/products-live.js`

| Photo | Jev saw | Remedies offered | Haiku |
|---|---|---|---|
| T-shirt with yellow stains | damage yes 85%, stain 71%, design mismatch | refund, new one, stain kit | stain remover kit; factory-second tee |
| Green shirt with a small hole | damage yes 84%, tear or hole 55% | refund, new one, mending kit | visible-mending embroidery kit (the iron-on kit is out of stock); factory-second tee |
| Clear vase with a long crack | damage yes 98%, crack or chip 97%, design match | refund, new one, glass resin | recycled green glass vase |
| Vase with its top broken off | damage yes 97%, crack or chip 88% | refund, new one | recycled green glass vase |
| Headphones, headband snapped and taped | damage yes 92%, snapped 56% | refund, new pair | refurbished pair |
| Headphones, headband snapped, torn cushion | damage yes 96%, cushion torn 36% | refund, new pair | replacement cushions; refurbished pair |
| Headphones, hinge repaired with clear tape | damage unsure 26% | refund only | (not asked) |
| Intact clear vase | damage no 5% | refund only | (not asked) |

Jev took 140-350 ms per photo; Haiku 3.6-6.4 s. The subtle taped hinge goes to the merchant as
"unsure", which is the intended behaviour.

## Live sandbox run

`CHROMIUM_PATH=/opt/pw-browsers/chromium node --env-file=.env scripts/record-products.js`:
$215.00 order (vase, two T-shirts, headphones), stained T-shirt reported, Jev read a stain and
matched the stain-kit remedy, Haiku suggested the stain kit and a factory-second tee, the merchant
added the kit, the buyer picked it, PayPal refund `90G53154FC121611U` for $5.00 COMPLETED.

## Known gaps

- Haiku can suggest a listing that duplicates a library remedy (both a "stain remover kit"), with
  a different refund. The merchant sees both and can dismiss one.
- Stock is read from the catalog file; a real store would read it from inventory at suggestion
  time and again when the buyer picks.
- One open request per order still applies, so a second item on the same order waits until the
  first request is resolved.

Photo credits: `probe/products/sources.json` (Openverse, CC BY / CC BY-SA / CC0).
