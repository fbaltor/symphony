import type pg from "pg";
import { logger } from "./logger.js";

/**
 * Persistent operator kill-switch. Halts dispatch when
 * engaged WITHOUT aborting in-flight workers — they drain naturally so
 * audit rows + Linear outcome comments still land.
 *
 * Backed by a single-row `symphony.kill_switch` table that's read by
 * the orchestrator on every poll tick. Operators flip it via
 * `POST /admin/kill-switch?op=engage|clear` (token-gated, same
 * `SYMPHONY_ADMIN_TOKEN` as `/admin/reload`).
 *
 * In-memory cache: the orchestrator polls Postgres frequently enough
 * (~30s) that we don't bother caching here — best-effort: a Postgres
 * read failure is treated as "not engaged" so a DB outage doesn't
 * inadvertently halt the pipeline.
 */

export interface KillSwitchState {
  engaged: boolean;
  reason: string | null;
  engagedAt: Date | null;
  engagedBy: string | null;
}

const READ_SQL = `
  SELECT engaged, reason, engaged_at, engaged_by
  FROM kill_switch
  WHERE id = 1
`;

const ENGAGE_SQL = `
  UPDATE kill_switch
  SET engaged = true, reason = $1, engaged_by = $2, engaged_at = now()
  WHERE id = 1
`;

const CLEAR_SQL = `
  UPDATE kill_switch
  SET engaged = false, reason = NULL, engaged_by = NULL, engaged_at = NULL
  WHERE id = 1
`;

const DEFAULT_STATE: KillSwitchState = {
  engaged: false,
  reason: null,
  engagedAt: null,
  engagedBy: null,
};

export async function readKillSwitch(pool: pg.Pool): Promise<KillSwitchState> {
  try {
    const res = await pool.query<{
      engaged: boolean;
      reason: string | null;
      engaged_at: Date | string | null;
      engaged_by: string | null;
    }>(READ_SQL);
    const row = res.rows[0];
    if (!row) return DEFAULT_STATE;
    return {
      engaged: row.engaged,
      reason: row.reason,
      engagedAt:
        row.engaged_at === null
          ? null
          : row.engaged_at instanceof Date
            ? row.engaged_at
            : new Date(row.engaged_at),
      engagedBy: row.engaged_by,
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "kill-switch read failed; treating as not-engaged",
    );
    return DEFAULT_STATE;
  }
}

export async function engageKillSwitch(
  pool: pg.Pool,
  args: { reason?: string; by?: string },
): Promise<void> {
  await pool.query(ENGAGE_SQL, [args.reason ?? null, args.by ?? null]);
  logger.warn(
    { reason: args.reason ?? null, by: args.by ?? null },
    "kill-switch ENGAGED — dispatch halted",
  );
}

export async function clearKillSwitch(pool: pg.Pool): Promise<void> {
  await pool.query(CLEAR_SQL);
  logger.info({}, "kill-switch CLEARED — dispatch resumed");
}
