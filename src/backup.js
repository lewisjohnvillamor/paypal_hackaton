// One-off database backup (`npm run backup`). The server can also take one on a timer; see
// BACKUP_INTERVAL_HOURS in .env.example.
import { backup, openDb } from "./db.js";

const t = Date.now();
const { file, removed } = backup(openDb());
console.log(`Backed up to ${file} in ${Date.now() - t} ms; removed ${removed} old copy(ies).`);
