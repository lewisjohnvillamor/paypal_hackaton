// Which photos the model sees. Jev takes a bounded number of image tokens per call (a live call with
// 24 photos failed with max_tokens_exceeded; 12 passed), so a claim with many photos sends a
// subset: the newest upload first (it answers the merchant's latest request), then the sharpest of
// the rest, skipping near-duplicates. The merchant always sees every photo.
import { SIMILAR_PHOTO_BITS, hashDistance } from "../images.js";

export const AI_MAX_PHOTOS = Number(process.env.AI_MAX_PHOTOS || 8);

export function pickForModel(evidence, max = AI_MAX_PHOTOS) {
  if (evidence.length <= max) return evidence;
  const newest = evidence.reduce((m, e) => (e.created_at > m ? e.created_at : m), "");
  const ranked = [...evidence].sort((a, b) =>
    (b.created_at === newest) - (a.created_at === newest) || (b.sharpness ?? 0) - (a.sharpness ?? 0));
  const picked = [];
  for (const e of ranked) {
    if (picked.length >= max) break;
    const dup = e.phash && picked.some((p) => p.phash && hashDistance(p.phash, e.phash) <= SIMILAR_PHOTO_BITS);
    if (!dup) picked.push(e);
  }
  return evidence.filter((e) => picked.includes(e)); // keep upload order
}

export const tooManyTokens = (err) => /max_tokens_exceeded/.test(String(err?.message || err));
