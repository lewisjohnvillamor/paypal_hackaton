// Assessment queue. A claim is stored first and answered at once; Jev runs here, a bounded number
// at a time, so a burst of claims queues instead of opening dozens of model calls together and
// holding every buyer's upload request open. State lives in the database (a claim in status "new"
// has no current proposal), so after a restart `resume()` picks up whatever was waiting.
//
// A model failure never fails a review (it drafts a manual review instead). Anything else that
// throws (a missing catalog photo, a full disk) is retried a few times, and if it keeps failing the
// request is handed to the merchant unreviewed, with the error, rather than left "checking" forever.
import { assessClaim } from "./claims.js";
import { audit, now, tx } from "./db.js";

export const RETRY_DELAYS_MS = [5_000, 30_000];

// Out of retries: the request moves to the merchant's inbox with no draft, and the case page offers
// "Review current photos" so they can run it again by hand.
function giveUp(db, claimId, err) {
  tx(db, () => {
    const r = db.prepare("UPDATE claims SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'new'").run(now(), claimId);
    if (r.changes) audit(db, { claimId, actor: "system", type: "assessment.crashed", payload: { error: String(err?.message || err).slice(0, 300) } });
  });
}

export function assessmentQueue(db, assess, { concurrency = Number(process.env.JEV_CONCURRENCY || 4), suggest = null, match = null, after = null, retryDelays = RETRY_DELAYS_MS } = {}) {
  const tries = new Map(); // claimId -> failed attempts so far
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
      await assessClaim(db, claimId, assess, "system", suggest, match);
      tries.delete(claimId);
      counts.completed++;
      // The refund agent reads the fresh proposal against the merchant's rules.
      if (after) await after(claimId).catch((err) => console.error("agent", claimId, err.message));
    } catch (err) {
      // STALE_CASE: new photos landed mid-assessment; they enqueue the claim again.
      if (err.code === "STALE_CASE") again.add(claimId);
      else if (err.code !== "NOT_ASSESSABLE" && err.code !== "NOT_FOUND") {
        counts.failed++;
        console.error("assessment", claimId, err.message);
        const n = tries.get(claimId) ?? 0;
        if (n < retryDelays.length) {
          tries.set(claimId, n + 1);
          setTimeout(() => enqueue(claimId), retryDelays[n]).unref?.();
        } else {
          tries.delete(claimId);
          try { giveUp(db, claimId, err); } catch (e) { console.error("assessment", claimId, e.message); }
        }
      }
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
