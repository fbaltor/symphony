import { randomUUID } from "node:crypto";
import type pg from "pg";
import { logger } from "../observability/logger.js";
import { sleep } from "../lib/time.js";

/**
 * Single-orchestrator advisory lock (Symphony extension).
 *
 * Cloud Run revision rollouts briefly run two instances. The spec assumes a
 * single authoritative orchestrator. We coordinate via:
 *
 *   1. `pg_try_advisory_lock(LOCK_KEY)` for in-band exclusion within a session.
 *   2. A heartbeat row (`symphony.instance_lock`) that tracks the active
 *      instance ID + last-heartbeat-at. New instances wait up to ACQUIRE_WAIT_MS
 *      for the existing heartbeat to age past LEASE_MS before claiming.
 *   3. Cooperative handoff via `symphony.instance_lock_handoff`:
 *      when a new instance can't claim the lock immediately (because the
 *      old revision is still healthy + heartbeating), it INSERTs a request
 *      row. The old revision's heartbeat tick polls this table; if it sees
 *      a request from a DIFFERENT instance_id that's recent (< 60s old),
 *      it fires `onHandoffRequested()` so main.ts can trigger the same
 *      shutdown path as SIGTERM. The early-release-on-shutdown then
 *      frees the advisory lock and the new revision proceeds.
 *
 *      Without this, Cloud Run won't SIGTERM the old revision until the
 *      new one is healthy, but the new one can't be healthy without the
 *      lock — classic deadlock. The earlier mitigation: manual
 *      `pg_terminate_backend(pid)` on every deploy.
 */

// "Symp" packed into a 32-bit int — fits comfortably in JS's safe-integer range
// and pg's bigint parameter binding accepts a regular number for this size.
const LOCK_KEY = 0x53796d70;
const HEARTBEAT_INTERVAL_MS = 5_000;
const LEASE_MS = 15_000;
const ACQUIRE_WAIT_MS = 30_000;
/**
 * how recent a handoff request must be before the heartbeat
 * tick honors it. Bounded to prevent stale rows from a dead revision
 * triggering the live one to step down. 60s is well above the 30s
 * Cloud Run revision-startup window plus DB roundtrip slack.
 */
const HANDOFF_RECENCY_MS = 60_000;

const LOG_EVENT_LOCK_HELD = "instance lock held; waiting for it to age out";
const LOG_EVENT_ADVISORY_RETRY = "advisory lock not yet free; retrying in 1s";
const LOG_EVENT_LOCK_ACQUIRED = "acquired instance lock";
const LOG_EVENT_HANDOFF_REQUESTED =
  "handoff requested by another instance; firing onHandoffRequested";
const LOG_EVENT_HANDOFF_WROTE = "wrote handoff request — waiting for old instance to release";
const LOG_EVENT_HANDOFF_CLEARED = "cleared handoff request after acquiring lock";

export interface InstanceLockHandle {
  instanceId: string;
  release: () => Promise<void>;
}

export interface AcquireInstanceLockOpts {
  /**
   * invoked on the old (lock-holding) instance when the heartbeat
   * tick sees a fresh handoff request from a new instance. Should kick off
   * the same shutdown path as SIGTERM — typically `void shutdown("handoff")`
   * in main.ts. Idempotent in main.ts via the `shuttingDown` flag.
   */
  onHandoffRequested?: () => void;
}

export async function acquireInstanceLock(
  pool: pg.Pool,
  opts: AcquireInstanceLockOpts = {},
): Promise<InstanceLockHandle> {
  const instanceId = `${process.env.K_REVISION ?? "local"}-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();

  // Step 1: wait for the previous heartbeat to age past LEASE_MS, OR until
  // ACQUIRE_WAIT_MS elapses. : on the first observed-fresh heartbeat,
  // write a handoff request so the old instance steps down voluntarily —
  // otherwise we'd deadlock waiting for a SIGTERM Cloud Run won't send.
  let wroteHandoffRequest = false;
  while (Date.now() - startedAt < ACQUIRE_WAIT_MS) {
    const row = await readHeartbeat(pool);
    if (!row || isStale(row.heartbeat_at)) break;
    logger.info(
      {
        existing: row.instance_id,
        lastHeartbeatAt: row.heartbeat_at,
      },
      LOG_EVENT_LOCK_HELD,
    );
    if (!wroteHandoffRequest) {
      // signal the old instance to step down. Idempotent
      // upsert; multiple new instances racing would each overwrite their
      // peer's row with their own instance_id, but the recipient (old
      // instance) only cares that SOMEONE ELSE is asking.
      try {
        await pool.query(
          `INSERT INTO symphony.instance_lock_handoff (id, requesting_instance_id, requested_at)
             VALUES (1, $1, now())
           ON CONFLICT (id) DO UPDATE
             SET requesting_instance_id = EXCLUDED.requesting_instance_id,
                 requested_at = EXCLUDED.requested_at`,
          [instanceId],
        );
        wroteHandoffRequest = true;
        logger.info({ instanceId }, LOG_EVENT_HANDOFF_WROTE);
      } catch (err) {
        // Non-fatal: handoff is an optimization, the wait loop still
        // works on its own (just slower because it depends on the
        // existing instance's natural SIGTERM path).
        logger.warn(
          { err: (err as Error).message },
          "handoff request write failed; falling back to passive wait",
        );
      }
    }
    await sleep(2_000);
  }

  // Step 2: try to take the advisory lock. We use a long-lived dedicated
  // client so the advisory lock survives outside transactions.
  const client = await pool.connect();
  // Defensive: pg.PoolClient is an EventEmitter and emits `error` when the
  // underlying socket dies (e.g. cloud-sql-proxy sidecar SIGTERM during
  // a Cloud Run rollout). Without this listener Node treats it as
  // unhandled and crashes the process — which we observed on rev
  // 00004-v4g during the  Plan turn drain. We log + swallow;
  // gracefulStop will detect drain completion via the workerPromises
  // tracking and main.ts exits cleanly.
  client.on("error", (err) => {
    logger.warn(
      { err: err.message },
      "instance-lock client error (likely sidecar SIGTERM); swallowing",
    );
  });

  // Retry pg_try_advisory_lock for up to ADVISORY_LOCK_RETRY_MS. The wait
  // loop above breaks when the heartbeat is stale, but staleness alone
  // doesn't guarantee the previous instance's PG SESSION has ended — a
  // session-scoped advisory lock (held by the prior instance's drain
  // path) survives until the actual TCP/process termination, which can
  // be 5–10s past the last heartbeat. Without this retry, the new
  // revision booted just-too-early and crashed with "failed to acquire
  // pg_try_advisory_lock", leaving symphony down for ~1h on the
  // hot-patch #8 redeploy (rev 00009-9g6, 15:16:04 → orchestrator dead).
  let lockHeld = false;
  const advisoryStartedAt = Date.now();
  const ADVISORY_LOCK_RETRY_MS = 60_000; // 1 min — well within Cloud Run's startup probe window
  let lastAdvisoryErr: unknown = null;
  try {
    while (Date.now() - advisoryStartedAt < ADVISORY_LOCK_RETRY_MS) {
      try {
        const res = await client.query<{ pg_try_advisory_lock: boolean }>(
          "SELECT pg_try_advisory_lock($1::bigint)",
          [LOCK_KEY],
        );
        lockHeld = res.rows[0]?.pg_try_advisory_lock === true;
        if (lockHeld) break;
      } catch (queryErr) {
        // Transient socket / pool errors during the previous instance's
        // proxy shutdown — log + retry instead of giving up.
        lastAdvisoryErr = queryErr;
        logger.warn(
          { err: (queryErr as Error).message },
          "pg_try_advisory_lock query failed; retrying",
        );
      }
      logger.info({ elapsedMs: Date.now() - advisoryStartedAt }, LOG_EVENT_ADVISORY_RETRY);
      await sleep(1_000);
    }
    if (!lockHeld) {
      throw new Error(
        `failed to acquire pg_try_advisory_lock(${String(LOCK_KEY)}) after ${ADVISORY_LOCK_RETRY_MS}ms; another instance is holding it (last query err: ${lastAdvisoryErr ? (lastAdvisoryErr as Error).message : "n/a"})`,
      );
    }
  } catch (err) {
    // Single release path. The previous version called client.release() both
    // before the throw and again in the catch, which surfaced as
    // "Release called on client which has already been released to the pool"
    // when bootstrap retried after a transient lock-contended start.
    client.release();
    throw err;
  }

  // Steps 3+4 are wrapped so any failure here releases the lock + client we
  // just acquired. Without this, an INSERT failure would leave the advisory
  // lock held forever and block every future instance.
  let heartbeatTimer: NodeJS.Timeout;
  try {
    // Step 3: write our heartbeat row. Use the same `client` so it shares the
    // session with the advisory lock.
    await client.query(
      `INSERT INTO instance_lock (id, instance_id, acquired_at, heartbeat_at)
         VALUES (1, $1, now(), now())
       ON CONFLICT (id) DO UPDATE
         SET instance_id = EXCLUDED.instance_id,
             acquired_at = EXCLUDED.acquired_at,
             heartbeat_at = EXCLUDED.heartbeat_at`,
      [instanceId],
    );

    // Step 4: heartbeat on a timer. Heartbeats MUST run on the same session
    // (`client`) that holds the advisory lock — `pg_try_advisory_lock` is
    // session-scoped, so a heartbeat on a random pool connection would
    // silently lose the lock signal.
    //
    // each tick also polls `instance_lock_handoff` for a fresh
    // request from a DIFFERENT instance_id. If found, fire the
    // `onHandoffRequested` callback (typically wired to `shutdown` in
    // main.ts). The callback is fired only once per handle lifetime via
    // the `handoffSignaled` guard so a slow shutdown path doesn't get
    // re-entered every 5s.
    let handoffSignaled = false;
    heartbeatTimer = setInterval(() => {
      // Fire the heartbeat first — we want to keep the lease fresh even
      // if the handoff poll fails.
      client
        .query(`UPDATE instance_lock SET heartbeat_at = now() WHERE instance_id = $1`, [instanceId])
        .catch((err) => logger.warn({ err: err.message }, "heartbeat update failed"));

      // Then check for a handoff request. Single-row read keyed on (id=1)
      // — cheap (~0.5ms p50). Use the pool (not `client`) so a stuck
      // session client doesn't block the poll.
      if (!handoffSignaled && opts.onHandoffRequested) {
        pool
          .query<{ requesting_instance_id: string; requested_at: Date }>(
            `SELECT requesting_instance_id, requested_at
               FROM symphony.instance_lock_handoff
              WHERE id = 1
                AND requesting_instance_id != $1
                AND requested_at > now() - ($2::int || ' milliseconds')::interval`,
            [instanceId, HANDOFF_RECENCY_MS],
          )
          .then((res) => {
            if (res.rows.length > 0 && !handoffSignaled) {
              handoffSignaled = true;
              const requester = res.rows[0]?.requesting_instance_id ?? "<unknown>";
              logger.info(
                { requester, self: instanceId },
                LOG_EVENT_HANDOFF_REQUESTED,
              );
              try {
                opts.onHandoffRequested?.();
              } catch (cbErr) {
                logger.warn(
                  { err: (cbErr as Error).message },
                  "onHandoffRequested callback threw",
                );
              }
            }
          })
          .catch((err) =>
            // Non-fatal — handoff polling is an optimization. Without it
            // we still rely on Cloud Run's eventual SIGTERM (which is
            // exactly the deadlock  fixes, but the existing
            // 540s drain timeout means we recover within 5-10 min).
            logger.warn({ err: err.message }, "handoff poll failed"),
          );
      }
    }, HEARTBEAT_INTERVAL_MS);
  } catch (err) {
    // Roll back: drop the advisory lock and return the client to the pool so
    // the next deploy doesn't get wedged.
    await client
      .query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY])
      .catch((unlockErr) =>
        logger.warn(
          { err: (unlockErr as Error).message },
          "pg_advisory_unlock during rollback failed",
        ),
      );
    client.release();
    const e = err as { code?: string; message?: string };
    if (e.code === "42P01") {
      throw new Error(
        "symphony.instance_lock table not found — run scripts/migrate.sh before starting the daemon",
      );
    }
    throw err;
  }

  logger.info({ instanceId }, LOG_EVENT_LOCK_ACQUIRED);

  // clear our own handoff request row now that we have the
  // lock. Without this, the row would linger and the heartbeat-tick
  // poll on this NEW instance would see its own request as a "handoff
  // request from another instance" if it ever runs against itself
  // (which the WHERE clause filters out, but tidiness matters and we
  // also want to avoid confusing a future operator who looks at the
  // table). Best-effort — if the delete fails the recency window
  // (HANDOFF_RECENCY_MS) self-clears it after 60s.
  pool
    .query(`DELETE FROM symphony.instance_lock_handoff WHERE requesting_instance_id = $1`, [
      instanceId,
    ])
    .then(() => logger.info({ instanceId }, LOG_EVENT_HANDOFF_CLEARED))
    .catch((err) => logger.warn({ err: err.message }, "handoff row delete failed (non-fatal)"));

  // Idempotency guard. The shutdown path in `main.ts` calls `release()`
  // EARLY (right after `gracefulStop` halts dispatches synchronously) so
  // the next Cloud Run revision can boot + dispatch while this instance
  // drains in-flight turns. The legacy post-drain `release()` call still
  // runs as a defensive fallback in case the early call ever gets skipped
  // (e.g. an exception path). A second invocation must be a safe no-op:
  // calling `client.release()` twice on a pg PoolClient throws "Release
  // called on client which has already been released" — observed on
  // multiple revs before this guard landed.
  let released = false;
  return {
    instanceId,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeatTimer);
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "pg_advisory_unlock failed");
      } finally {
        client.release();
      }
    },
  };
}

interface HeartbeatRow {
  instance_id: string;
  heartbeat_at: Date;
}

async function readHeartbeat(pool: pg.Pool): Promise<HeartbeatRow | null> {
  try {
    const res = await pool.query<HeartbeatRow>(
      `SELECT instance_id, heartbeat_at FROM instance_lock WHERE id = 1`,
    );
    return res.rows[0] ?? null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "readHeartbeat failed (table may not exist yet)");
    return null;
  }
}

function isStale(heartbeatAt: Date): boolean {
  return Date.now() - heartbeatAt.getTime() > LEASE_MS;
}
