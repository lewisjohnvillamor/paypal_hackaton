// Per-photo processing cost: 100 phone photos through normalizeImage at different parallelism.
import { normalizeImage, mapLimit } from "../src/images.js";
import { phonePhotos } from "./photos.js";
import sharp from "sharp";

const photos = await phonePhotos(Number(process.argv[2] || 100));
for (const limit of [1, 2, 4, 8]) {
  const t = performance.now();
  await mapLimit(photos, limit, (p) => normalizeImage(p));
  console.log(JSON.stringify({ photos: photos.length, parallel: limit, totalMs: Math.round(performance.now() - t), perPhotoMs: Math.round((performance.now() - t) / photos.length), rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
}
// What a browser-side shrink (to 1568 px before upload) leaves for the server to do.
const small = await Promise.all(photos.map((p) => sharp(p).resize(1568, 1568, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer()));
const t = performance.now();
await mapLimit(small, 4, (p) => normalizeImage(p));
console.log(JSON.stringify({ photos: small.length, preShrunk: true, avgKB: Math.round(small.reduce((s, b) => s + b.length, 0) / small.length / 1024), parallel: 4, totalMs: Math.round(performance.now() - t) }));
