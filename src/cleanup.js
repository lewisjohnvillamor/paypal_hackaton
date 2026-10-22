// Demo retention: delete evidence photos older than RETENTION_DAYS (default 7). Financial records stay.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { audit, openDb } from "./db.js";
import { uploadDir } from "./claims.js";

const days = Number(process.env.RETENTION_DAYS || 7);
const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
const db = openDb();
const old = db.prepare("SELECT id, claim_id, storage_key FROM evidence WHERE created_at < ?").all(cutoff);
for (const e of old) {
  rmSync(join(uploadDir(), e.storage_key), { force: true });
  db.prepare("DELETE FROM evidence WHERE id = ?").run(e.id);
  audit(db, { claimId: e.claim_id, actor: "system", type: "evidence.deleted_retention", payload: { days } });
}
console.log(`Deleted ${old.length} evidence photo(s) older than ${days} days.`);
