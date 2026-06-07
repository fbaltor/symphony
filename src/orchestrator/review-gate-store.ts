import type pg from "pg";
import { logger } from "../observability/logger.js";

/**
 * Persistent backing store for the orchestrator's `lastSeenState` Map.
 *
 * closes the gap where the in-memory Map reset on every
 * Cloud Run revision rollover, leaving the first reconciler tick after a
 * restart unable to detect unauthorized review-gate moves (no `prev` to
 * compare against). Read on startup, written through on every set/delete.
 *
 * Best-effort: Postgres failures log a warn and continue. The in-memory
 * Map remains the source of truth during a process; the DB is the
 * cross-restart hand-off.
 */
export class ReviewGateStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Load all persisted (issue_id, last_seen_state) rows. Called by the
   * orchestrator at boot to seed the in-memory Map. Returns an empty Map
   * on any DB failure (operator just gets a brief reduced-coverage window
   * until a fresh dispatch repopulates).
   */
  async loadAll(): Promise<Map<string, string>> {
    try {
      const res = await this.pool.query<{ issue_id: string; last_seen_state: string }>(
        `SELECT issue_id, last_seen_state FROM review_gate_state`,
      );
      const out = new Map<string, string>();
      for (const r of res.rows) out.set(r.issue_id, r.last_seen_state);
      logger.info(
        { count: out.size },
        "review-gate state restored from symphony.review_gate_state",
      );
      return out;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "review-gate state load failed; starting with empty map",
      );
      return new Map();
    }
  }

  async set(issueId: string, lastSeenState: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO review_gate_state (issue_id, last_seen_state, updated_at)
           VALUES ($1, $2, now())
         ON CONFLICT (issue_id) DO UPDATE
           SET last_seen_state = EXCLUDED.last_seen_state,
               updated_at = now()`,
        [issueId, lastSeenState],
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, issueId },
        "review-gate state persist failed; in-memory still updated",
      );
    }
  }

  async delete(issueId: string): Promise<void> {
    try {
      await this.pool.query(`DELETE FROM review_gate_state WHERE issue_id = $1`, [issueId]);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, issueId },
        "review-gate state delete failed; in-memory cleared anyway",
      );
    }
  }
}

/**
 * A `Map<string,string>` subclass that writes through to a `ReviewGateStore`
 * on every `set` / `delete`. Constructed by the orchestrator and passed to
 * the reconciler in place of the previous plain-Map. The reconciler keeps
 * mutating it as `lastSeenState`; persistence happens transparently.
 *
 * `set` / `delete` fire-and-forget the DB write so reconciler latency
 * isn't gated on a Postgres round-trip. The in-memory state is always
 * canonical for the rest of the run.
 */
export class WriteThroughLastSeenMap extends Map<string, string> {
  constructor(private readonly store: ReviewGateStore) {
    super();
  }

  override set(key: string, value: string): this {
    super.set(key, value);
    void this.store.set(key, value);
    return this;
  }

  override delete(key: string): boolean {
    void this.store.delete(key);
    return super.delete(key);
  }
}
