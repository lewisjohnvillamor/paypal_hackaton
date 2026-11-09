// The sample damage photos that ship with the repo (demo-photos/, probe/products/, probe/cases/).
// On a hosted demo every judge uploads these same files, so a match against another request is
// expected there, not a sign of a reused photo. Only with PUBLIC_DEMO=1; everywhere else the
// list is empty and the reuse check is unchanged.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeImage, SIMILAR_PHOTO_BITS, hashDistance } from "./images.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["demo-photos", "probe/products", "probe/cases"];
let hashes = null;

async function load() {
  const out = [];
  for (const dir of DIRS) {
    let names = [];
    try { names = await readdir(join(ROOT, dir)); } catch { continue; }
    for (const name of names.filter((n) => /\.(jpe?g|png)$/i.test(n))) {
      try { out.push((await normalizeImage(join(ROOT, dir, name))).phash); } catch {}
    }
  }
  return out;
}

export async function sharedDemoHashes(env = process.env) {
  if (env.PUBLIC_DEMO !== "1") return [];
  hashes ??= load();
  return hashes;
}

export const isSharedDemoPhoto = (phash, shared) =>
  Boolean(phash) && shared.some((h) => hashDistance(h, phash) <= SIMILAR_PHOTO_BITS);
