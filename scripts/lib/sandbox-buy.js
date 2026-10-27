// Pay for a demo order as the PayPal sandbox buyer, in a real browser: the one step that stays a
// person's, since only the buyer can approve a PayPal payment. Returns the capture and the
// private claim link the shop gives the buyer.
export async function sandboxBuy(page, base, items) {
  const order = await (await fetch(`${base}/api/demo/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) })).json();
  await page.goto(order.approveUrl);
  // PayPal remembers the sandbox buyer after the first purchase and skips the sign-in.
  if (await page.waitForSelector("#email", { timeout: 15_000 }).catch(() => null)) {
    await page.fill("#email", process.env.SANDBOX_BUYER_EMAIL);
    await page.click("#btnNext");
    await page.fill("#password", process.env.SANDBOX_BUYER_PASSWORD);
    await page.click("#btnLogin");
  }
  const pay = page.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button:has-text("Complete Purchase"), button:has-text("Continue")').first();
  await pay.waitFor({ timeout: 60_000 });
  await pay.click();
  await page.waitForURL((u) => !u.hostname.includes("paypal.com"), { timeout: 60_000 }).catch(() => {});
  let cap;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${base}/api/demo/orders/${order.paypalOrderId}/capture`, { method: "POST" });
    cap = await r.json();
    if (r.ok) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!cap.claimUrl) throw new Error("capture failed: " + JSON.stringify(cap));
  return { paypalOrderId: order.paypalOrderId, captureId: cap.captureId, claimUrl: cap.claimUrl, claimLink: base + cap.claimUrl };
}
