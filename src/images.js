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
  };
}
