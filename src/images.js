// Evidence image preparation: validate, rotate upright, strip metadata, fit Jev's 280-1568 px window.
import sharp from "sharp";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { stat } from "node:fs/promises";

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024;
export const MAX_PHOTOS = Number(process.env.MAX_PHOTOS || 100); // per request, and per claim in total
const MAX_INPUT_PIXELS = 70_000_000; // 64 MP phone cameras pass; decompression bombs are rejected before decoding
const MIN_SIDE = 280;
const MAX_SIDE = 1568;
const AI_SIDE = 1024; // the copy sent to Jev: about 60% fewer image tokens than 1568 px, same as the Gate 2 set

// libvips already parallelises inside one image; a few images at a time keeps every core busy
// without holding dozens of decoded phone photos in memory at once.
export const IMAGE_CONCURRENCY = Number(process.env.IMAGE_CONCURRENCY || Math.min(4, availableParallelism()));

export class ImageRejected extends Error {}

// Runs fn over items with at most `limit` in flight; results keep the input order.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// `input` is a Buffer or a path to a file (uploads are spooled to disk, never held in memory).
export async function normalizeImage(input) {
  const size = Buffer.isBuffer(input) ? input.length : (await stat(input)).size;
  if (size > MAX_UPLOAD_BYTES) throw new ImageRejected(`Each photo must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller.`);
  const buf = input;
  let meta;
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new ImageRejected("That file is not a readable image.");
  }
  if (!["jpeg", "png"].includes(meta.format)) throw new ImageRejected("Photos must be JPEG or PNG.");
  if ((meta.pages ?? 1) > 1) throw new ImageRejected("Animated images are not accepted.");

  // .rotate() with no argument applies EXIF orientation; output carries no metadata.
  let img = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" });
  let out = await img.jpeg({ quality: 88, progressive: false }).toBuffer({ resolveWithObject: true });

  // Hash before any padding, so a small copy of a photo still matches the original.
  const phash = await differenceHash(out.data);
  const { width, height } = out.info;
  if (width < MIN_SIDE || height < MIN_SIDE) {
    // Pad small photos up to the minimum instead of rejecting them.
    out = await sharp(out.data).extend({
      top: 0, left: 0,
      bottom: Math.max(0, MIN_SIDE - height),
      right: Math.max(0, MIN_SIDE - width),
      background: "#ffffff",
    }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });
  }
  return {
    data: out.data,
    width: out.info.width,
    height: out.info.height,
    sha256: createHash("sha256").update(out.data).digest("hex"),
    phash,
    sharpness: await sharpness(out.data),
  };
}

// Variance of the Laplacian on a small greyscale copy: higher means more in-focus detail. Used to
// pick which photos the model sees when a buyer sends more than it can take in one call.
export async function sharpness(buf) {
  const { data, info } = await sharp(buf).greyscale().resize(256, 256, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = data[i - w] + data[i + w] + data[i - 1] + data[i + 1] - 4 * data[i];
      sum += v; sq += v * v; n++;
    }
  }
  return n ? Math.round(sq / n - (sum / n) ** 2) : 0;
}

// Smaller copy of a stored evidence photo for the model.
export const aiCopy = (buf) => sharp(buf).resize(AI_SIDE, AI_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();

// 64-bit difference hash: survives re-encoding, resizing and small edits, so a photo reused from
// another claim (or the shop's own catalog photo) is caught even when it is not byte-identical.
export async function differenceHash(buf) {
  const px = await sharp(buf).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, "0");
}

const popcount32 = (v) => {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
// A 64-bit hash as two unsigned 32-bit halves, so distances need no BigInt.
export const hashHalves = (hex) => [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0];
export const halvesDistance = (ah, al, bh, bl) => popcount32((ah ^ bh) >>> 0) + popcount32((al ^ bl) >>> 0);

export function hashDistance(a, b) {
  const [ah, al] = hashHalves(a), [bh, bl] = hashHalves(b);
  return halvesDistance(ah, al, bh, bl);
}

export const SIMILAR_PHOTO_BITS = 8; // at most 8 of 64 bits differ
