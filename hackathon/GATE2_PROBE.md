# Gate 2: can Jev triage damage photos?

Run on 2026-10-22 with `npm run probe`. Raw output: [`probe/results/2026-10-22T10-07-56-497Z.json`](../probe/results/2026-10-22T10-07-56-497Z.json).

**Verdict: passes as triage, not as a judge.** Jev separated clearly broken mugs from intact ones with no confident false alarms, flagged blurry and dark photos as unusable, and was quick. The weak signal is the catalog-photo comparison, which often says "unsure" for shattered mugs. That is the safe failure: those cases go to the merchant instead of getting a one-click proposal.

## Setup

- Model `jev-preview`, served as `jev-1.14.0`. Question template `evidence-v1` (see `src/ai/jev.js`).
- One request per case: the customer photo plus the seller's catalog photo, five questions (three Nouls, two Choices). The customer's written statement is not sent.
- Thresholds: a Noul at or above 0.8 is "yes", at or below 0.2 is "no", anything between is "uncertain". Item match needs both the catalog-comparison Noul and the item-kind Choice to agree.
- 18 cases: 5 broken, 4 intact, 3 hard to call (a chip close-up, damage not in frame, a top-down shot), 2 unusable (too far away, too dark), 2 wrong items (a broken plate, a pottery shard), and 2 blurred copies made for this probe. All are Creative Commons or CC0 photos; credits are in `probe/cases.json`.
- This was the first and only run of `evidence-v1`. No thresholds or wording were tuned on these cases, so they are still usable as a held-out check for the next template.

## Results

"Unsure" means the app routes the case to the merchant. Cases labelled "ambiguous" are left out of the score.

| Finding | Scored cases | Right | Wrong | Unsure |
| --- | --- | --- | --- | --- |
| Visible breakage | 10 | 7 | 1 | 2 |
| Item matches the order | 13 | 8 | 0 | 5 |
| Photos usable | 15 | 14 | 0 | 1 |

- **No intact mug was called broken.** Two intact mugs came back "unsure" (p = 0.56 and 0.31), never "yes".
- **The one wrong breakage answer** is the broken plate: Jev said "no breakage" (p = 0.13). The question asks about damage to a mug or cup, so for a plate that answer is defensible. The item-match check flagged the plate as a different product (p = 0.03), so the claim still goes to the merchant.
- **Item match is the weak spot.** Three of the four clearly broken ceramic mugs scored 0.48 to 0.77 on "same kind of product as the catalog photo", so they went to manual review. The glass mug was called a different product, which matches the "ceramic" in the question.
- **Unusable photos are caught.** Both blurred copies and the dark panorama scored at or below 0.09 on "usable".
- **Speed and cost:** median 194 ms per request, 472 ms at most. About 4,800 input tokens and 170 output tokens per request (one customer photo plus the catalog photo).

## Live runs

Three live runs through the app with the same "broken rocket mug" photo gave "same kind" scores of 0.82, 0.79 and 0.90. The 0.79 run fell just under the 0.8 threshold and correctly needed a merchant reason before approval. So scores near a threshold can vary by about 0.1 between runs. Gating money on a merchant click covers this, but the threshold for the item-match check is the first thing to recalibrate.

## Next template (evidence-v2) candidates

- Rely more on the item-kind Choice, and use the catalog comparison only to catch different products.
- Ask the catalog question about the material and shape, so that broken pieces are not compared to a whole mug.
- Re-run on these 18 cases plus new held-out photos. Keep reporting wrong answers and "unsure" answers separately.
