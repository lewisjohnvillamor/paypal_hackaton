// Phone-sized test photos for load tests: each probe case upscaled to 4032x3024 with sensor-like
// noise, so file sizes (about 2-4 MB) and decode cost match what a buyer's phone uploads.
import sharp from "sharp";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CASES = new URL("../probe/cases/", import.meta.url).pathname;
const OUT = join(tmpdir(), "rr-bench-photos");

export async function phonePhotos(n) {
  mkdirSync(OUT, { recursive: true });
  const sources = readdirSync(CASES).filter((f) => f.endsWith(".jpg") && !f.startsWith("catalog"));
  const files = [];
  for (let i = 0; i < n; i++) {
    const file = join(OUT, `phone-${i}.jpg`);
    if (!existsSync(file)) {
      const src = readFileSync(join(CASES, sources[i % sources.length]));
      const { data, info } = await sharp(src).resize(4032, 3024, { fit: "cover" })
        .modulate({ brightness: 0.9 + (i % 7) * 0.03 }).raw().toBuffer({ resolveWithObject: true });
      let x = (i + 1) * 2654435761 >>> 0;
      for (let p = 0; p < data.length; p++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; data[p] = Math.max(0, Math.min(255, data[p] + (x & 15) - 8)); }
      writeFileSync(file, await sharp(data, { raw: info }).jpeg({ quality: 90 }).toBuffer());
    }
    files.push(file);
  }
  return files.map((f) => readFileSync(f));
}
