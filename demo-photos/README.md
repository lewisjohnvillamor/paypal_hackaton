# Generated damage demo photos

Synthetic product-damage examples generated with the built-in image-generation tool from this repository's catalog photos. These are demo fixtures, not real customer evidence or an accuracy benchmark. The original four requested filenames are preserved exactly.

| File | Catalog reference | Visible condition | Intended scenario |
| --- | --- | --- | --- |
| `1-kit-chipped-mug.jpg` | `catalog/catalog-mug.jpg` | One small rim chip; body and handle intact | Repair kit |
| `2-vase-cracked.jpg` | `catalog/catalog-vase.jpg` | Crack running down from the rim; vase in one piece | Glass repair or replacement |
| `4b-clear-mug-handle-off.jpg` | `catalog/catalog-mug.jpg` | Handle snapped off and lying alongside | Clear follow-up photo |
| `5-mug-in-pieces.jpg` | `catalog/catalog-mug.jpg` | Mug broken into several pieces | Refund or replacement |
| `6-tee-small-tear.jpg` | `catalog/catalog-tee.jpg` | Small frayed hole; otherwise clean | Mending kit |
| `7-tee-stained.jpg` | `catalog/catalog-tee.jpg` | Brown stain; fabric intact | Stain remover |
| `8-headphones-cushion-torn.jpg` | `catalog/catalog-headphones.jpg` | Torn cushion exposing foam; structure intact | Replacement cushions |
| `9-headphones-scuffed.jpg` | `catalog/catalog-headphones.jpg` | Cosmetic scuffs; structure intact | Keep with case and partial refund |
| `10-headphones-headband-snapped.jpg` | `catalog/catalog-headphones.jpg` | Headband broken through | Replacement or refund |

Each generated JPG is 1536 x 1024. Catalog references are copied unchanged from `public/assets/`; their existing repository source/licence information still applies. The mug's silhouette and the vase's cylindrical shape are based on those references. Backgrounds were simplified. `2-vase-cracked.jpg` is not generated: it is the catalog photo itself with a crack drawn on the glass and a closer, tilted framing (`scripts/photos/crack-vase.py`), because a generated empty glass did not read as the same product. Full generation prompts are in `prompts.json`.

For the marketing recorder on the working branch, set `DEMO_PHOTOS=demo-photos`. The four original filenames match its lookup keys. It can derive the blurred 4a example from 4b. The additional T-shirt and headphone photos can be uploaded manually to claims for the corresponding products; they do not add recorder scenes automatically.

Scenarios above describe visual intent. Actual model findings, matching, available stock, policy and merchant review determine the options shown; these files have not been checked through the live AI pipeline.
