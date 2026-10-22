// Browser check: a buyer picks N phone photos on the claim page; measures what actually goes over
// the wire after the in-browser shrink, and the time until the claim is accepted.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phonePhotos } from "./photos.js";

const N = Number(process.argv[2] || 30);
await phonePhotos(N);
const files = Array.from({ length: N }, (_, i) => join(tmpdir(), "rr-bench-photos", `phone-${i}.jpg`));
const dir = mkdtempSync(join(tmpdir(), "rr-browser-"));
const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "bench/server.js"], {
  env: { ...process.env, DATABASE_PATH: join(dir, "db.sqlite"), UPLOAD_DIR: join(dir, "up"), LOG_REQUESTS: "0" }, stdio: ["ignore", "pipe", "inherit"],
});
const port = await new Promise((r) => srv.stdout.on("data", (d) => { const m = /READY (\d+)/.exec(String(d)); if (m) r(m[1]); }));
const base = `http://127.0.0.1:${port}`;
try {
  const order = await (await fetch(`${base}/api/demo/orders`, { method: "POST" })).json();
  const cap = await (await fetch(`${base}/api/demo/orders/${order.paypalOrderId}/capture`, { method: "POST" })).json();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(base + cap.claimUrl);
  await page.fill("#statement", "Two mugs arrived broken, photos attached.");
  await page.setInputFiles("#photos", files);
  const t = Date.now();
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/claims")), page.click("#submit")]);
  const uploadBytes = (await (await fetch(`${base}/__bench`)).json()).lastUploadBytes;
  console.log(JSON.stringify({ photos: N, originalMB: +(files.length * 2.06).toFixed(1), uploadMB: +(uploadBytes / 1e6).toFixed(1), status: res.status(), clickToAcceptedMs: Date.now() - t }));
  // The merchant opens the case straight away; the page waits for the queued assessment.
  await page.waitForSelector("#sent:not(.hidden)");
  const claimId = new URL(await page.getAttribute("#status-link", "href"), base).searchParams.get("claim");
  await page.goto(`${base}/merchant/`);
  await page.fill("#password", process.env.MERCHANT_PASSWORD);
  await page.press("#password", "Enter");
  await page.waitForSelector("#inbox:not(.hidden)");
  const t2 = Date.now();
  await page.goto(`${base}/merchant/case?id=${claimId}`);
  await page.waitForSelector("#approve", { timeout: 20_000 }).catch(async (e) => {
    console.log((await page.locator("body").innerText()).slice(0, 1500));
    throw e;
  });
  console.log(JSON.stringify({ caseOpenToDecisionMs: Date.now() - t2, aiLine: await page.locator("text=clearest").first().textContent().catch(() => null) }));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
  await browser.close();
} finally { srv.kill(); }
