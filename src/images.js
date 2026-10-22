// Evidence image preparation: validate, rotate upright, strip metadata, fit Jev's 280-1568 px window.
import sharp from "sharp";
import { createHash } from "node:crypto";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_PHOTOS = 3;
const MAX_INPUT_PIXELS = 40_000_000; // rejects decompression bombs before decoding
const MIN_SIDE = 280;
const MAX_SIDE = 1568;

export class ImageRejected extends Error {}

export async function normalizeImage(buf) {
  if (buf.length > MAX_UPLOAD_BYTES) throw new ImageRejected("Each photo must be 5 MB or smaller.");
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
  };
}

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

export function hashDistance(a, b) {
  let v = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  while (v) { n += Number(v & 1n); v >>= 1n; }
  return n;
}

export const SIMILAR_PHOTO_BITS = 8; // at most 8 of 64 bits differ
