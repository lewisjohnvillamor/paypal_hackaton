// Small live sample through the real claim pipeline: real Jev, fake PayPal. Compares the old path
// (stored 1568 px photos sent as is) with the new one (1024 px copies, at most AI_MAX_PHOTOS).
// About 4 Jev calls in total.
import { readFileSync } from "node:fs";
import { assessEvidence } from "../src/ai/jev.js";
import { normalizeImage, aiCopy } from "../src/images.js";
import { setup, purchaseAndClaim } from "../tests/harness.js";
import { fakePayPal } from "../tests/helpers.js";
import { phonePhotos } from "./photos.js";

const reference = readFileSync(new URL("../public/assets/catalog-mug.jpg", import.meta.url));
// Phone-size versions of three broken-mug cases.
const all = await phonePhotos(20);
const pick = [4, 5, 7].map((i) => all[i]);
const stored = await Promise.all(pick.map((p) => normalizeImage(p).then((x) => x.data)));

const old = await assessEvidence({ photos: stored, reference });
const neu = await assessEvidence({ photos: await Promise.all(stored.map(aiCopy)), reference });
console.log(JSON.stringify({ photos: 3, old1568: { tokens: old.usage.input_tokens, ms: old.latencyMs, breakage: old.findings.visible_breakage, kind: old.findings.product_consistency },
  new1024: { tokens: neu.usage.input_tokens, ms: neu.latencyMs, breakage: neu.findings.visible_breakage, kind: neu.findings.product_consistency } }));

let n = 0;
const t = await setup({ pp: fakePayPal({ payerEmail: () => `live${++n}@example.com` }), assess: assessEvidence });
try {
  for (const count of [3, 20]) {
    const started = Date.now();
    const c = await purchaseAndClaim(t, { photos: all.slice(0, count) });
    await t.login();
    const d = (await t.merchant("GET", `/claims/${c.claimId}`)).body;
    console.log(JSON.stringify({ claimPhotos: count, endToEndMs: Date.now() - started, sentToJev: d.assessment.photosSent, tokens: d.assessment.usage?.input_tokens,
      jevMs: d.assessment.latencyMs, error: d.assessment.error, route: d.proposal.route, breakage: d.assessment.findings?.visible_breakage }));
  }
} finally { t.close(); }
