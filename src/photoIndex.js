// In-memory index of every evidence photo's fingerprint, for the "photo reused from another claim"
// check. Scanning SQLite rows and comparing hashes as BigInts cost about a second per claim once a
// shop had 60k photos; typed arrays and 32-bit popcounts check 100 photos against 60k in a few ms.
// The index follows the table by rowid and rebuilds if rows were deleted (retention cleanup).
import { halvesDistance, hashHalves } from "./images.js";

const indexes = new WeakMap();

function load(db) {
  let ix = indexes.get(db);
  if (!ix) indexes.set(db, (ix = { hi: new Uint32Array(1024), lo: new Uint32Array(1024), claims: [], n: 0, lastRowid: 0 }));
  const { n, maxRowid } = db.prepare("SELECT COUNT(*) n, COALESCE(MAX(rowid), 0) maxRowid FROM evidence WHERE phash IS NOT NULL").get();
  if (n < ix.n || maxRowid < ix.lastRowid) Object.assign(ix, { n: 0, lastRowid: 0, claims: [] }); // rows were deleted
  if (maxRowid === ix.lastRowid) return ix;
  const rows = db.prepare("SELECT rowid, claim_id, phash FROM evidence WHERE rowid > ? AND phash IS NOT NULL ORDER BY rowid").all(ix.lastRowid);
  if (ix.n + rows.length > ix.hi.length) {
    const size = Math.max(ix.hi.length * 2, ix.n + rows.length);
    for (const k of ["hi", "lo"]) { const a = new Uint32Array(size); a.set(ix[k].subarray(0, ix.n)); ix[k] = a; }
  }
  for (const r of rows) {
    [ix.hi[ix.n], ix.lo[ix.n]] = hashHalves(r.phash);
    ix.claims[ix.n++] = r.claim_id;
    ix.lastRowid = r.rowid;
  }
  return ix;
}

// True when any of `hashes` is within `maxBits` of a photo on a claim other than `claimId`.
export function anyNearOtherClaim(db, claimId, hashes, maxBits) {
  const ix = load(db);
  const probes = hashes.filter(Boolean).map(hashHalves);
  for (let i = 0; i < ix.n; i++) {
    const h = ix.hi[i], l = ix.lo[i];
    for (const [ph, pl] of probes) {
      if (halvesDistance(h, l, ph, pl) <= maxBits && ix.claims[i] !== claimId) return true;
    }
  }
  return false;
}
