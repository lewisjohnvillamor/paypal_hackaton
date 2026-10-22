// Damage marks: Jev's per-photo boxes reach the merchant's case view. Jev is a test double here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearFindings, testPhoto } from "./helpers.js";
import { purchaseAndClaim, setup } from "./harness.js";

test("damage marks from the AI review reach the merchant's case view, photo by photo", async () => {
  const box = { top: 0.2, bottom: 0.5, left: 0.3, right: 0.6 };
  const assess = async ({ photos }) => ({
    model: "fake-jev (test double)", findings: clearFindings, answers: {}, usage: {}, latencyMs: 1,
    marks: photos.map((_, i) => (i === 1 ? { box, damageShown: 0.95, confidence: 0.5 } : null)),
  });
  const t = await setup({ assess });
  try {
    const { claimId } = await purchaseAndClaim(t, { photos: [await testPhoto(1), await testPhoto(2)] });
    await t.login();
    const d = (await t.merchant("GET", `/claims/${claimId}`)).body;
    assert.equal(d.evidence[0].mark, null);
    assert.deepEqual(d.evidence[1].mark.box, box);
    assert.equal(d.proposal.route, "propose", "marks never change the policy outcome");
  } finally { t.close(); }
});
