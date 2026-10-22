// Assessment queue. A claim is stored first and answered at once; Jev runs here, a bounded number
// at a time, so a burst of claims queues instead of opening dozens of model calls together and
// holding every buyer's upload request open. State lives in the database (a claim in status "new"
// has no current proposal), so after a restart `resume()` picks up whatever was waiting.
import { assessClaim } from "./claims.js";

export function assessmentQueue(db, assess, { concurrency = Number(process.env.JEV_CONCURRENCY || 4), suggest = null } = {}) {
  const waiting = [];
  const active = new Set();
  const again = new Set(); // evidence arrived while this claim was being assessed
  let running = 0;
  let idleWaiters = [];
  const counts = { completed: 0, failed: 0 };

  const settle = () => {
    if (running === 0 && waiting.length === 0) { idleWaiters.forEach((r) => r()); idleWaiters = []; }
  };

  async function run(claimId) {
    running++;
    active.add(claimId);
    try {
      await assessClaim(db, claimId, assess, "system", suggest);
      counts.completed++;
    } catch (err) {
      // STALE_CASE: new photos landed mid-assessment; they enqueue the claim again.
      if (err.code === "STALE_CASE") again.add(claimId);
      else if (err.code !== "NOT_ASSESSABLE" && err.code !== "NOT_FOUND") { counts.failed++; console.error("assessment", claimId, err.message); }
    } finally {
      running--;
      active.delete(claimId);
      if (again.delete(claimId)) enqueue(claimId);
      pump();
      settle();
    }
  }

  function pump() {
    while (running < concurrency && waiting.length) run(waiting.shift());
  }

  function enqueue(claimId) {
    if (active.has(claimId)) { again.add(claimId); return; }
    if (waiting.includes(claimId)) return;
    waiting.push(claimId);
    pump();
  }

  return {
    enqueue,
    resume() {
      const ids = db.prepare("SELECT id FROM claims WHERE status = 'new' ORDER BY created_at").all().map((r) => r.id);
      ids.forEach(enqueue);
      return ids.length;
    },
    idle: () => (running === 0 && waiting.length === 0 ? Promise.resolve() : new Promise((r) => idleWaiters.push(r))),
    stats: () => ({ waiting: waiting.length, running, concurrency, ...counts }),
  };
}
