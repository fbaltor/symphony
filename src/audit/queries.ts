import type pg from "pg";
import { logger } from "../observability/logger.js";

/**
 * Read-side queries against `symphony.run_audit` used by the orchestrator's
 * Error → auto-retry recovery loop (`processErrorRetries()`).
 *
 * The audit table is the canonical record of every turn the orchestrator has
 * dispatched (success or failure); using it as the authority for "how many
 * times has this issue failed?" avoids carrying yet another in-memory counter
 * that would reset on every Cloud Run rollout. It also means the retry
 * accounting survives orchestrator restarts — important because the parking
 * loop's intent is to handle infrastructure blips, which often coincide with
 * orchestrator restarts.
 *
 * All queries are best-effort: on Postgres failure we log a warning and
 * return null / 0 so the orchestrator falls back to safe behavior (treat as
 * "no history yet, retry once") rather than crashing the tick.
 */

/**
 * Count the number of `symphony.run_audit` rows for `issueId` whose outcome
 * is NOT `Succeeded`. Used by `processErrorRetries()` as the attempt counter
 * driving exponential backoff and the `maxErrorRetries` budget check.
 *
 * `Succeeded` is the only outcome that means "this turn produced a real
 * deliverable"; everything else (`Failed`, `TimedOut`, `Stalled`,
 * `CanceledByReconciliation`) counts toward the retry budget. We deliberately
 * include `CanceledByReconciliation` because the most common reason for
 * cancellation in production is the per-issue cost cap firing — that IS a
 * failure for the purposes of the parking loop.
 */
export async function countAttemptsForIssue(pool: pg.Pool, issueId: string): Promise<number> {
  try {
    const res = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM run_audit WHERE issue_id = $1 AND outcome <> 'Succeeded'`,
      [issueId],
    );
    const raw = res.rows[0]?.n;
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issueId },
      "countAttemptsForIssue failed; treating as 0 attempts",
    );
    return 0;
  }
}

/**
 * Latest `finished_at` for a non-`Succeeded` run on `issueId`, or `null` when
 * none. Used as the start-of-backoff anchor: `delay = now - lastFailedAt`.
 *
 * Returns `null` (not a sentinel timestamp) so callers can distinguish "no
 * prior failure" from "failed at epoch 0" — the former should retry
 * immediately, the latter should wait the full backoff.
 */
export async function lastFailedAtForIssue(pool: pg.Pool, issueId: string): Promise<Date | null> {
  try {
    const res = await pool.query<{ finished_at: Date | string | null }>(
      `SELECT finished_at FROM run_audit
       WHERE issue_id = $1 AND outcome <> 'Succeeded'
       ORDER BY finished_at DESC
       LIMIT 1`,
      [issueId],
    );
    const raw = res.rows[0]?.finished_at;
    if (!raw) return null;
    if (raw instanceof Date) return raw;
    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issueId },
      "lastFailedAtForIssue failed; treating as no prior failure",
    );
    return null;
  }
}

export interface CostRollupRow {
  identifier: string;
  totalUsd: number;
  runs: number;
  firstSeen: string;
  lastSeen: string;
}

export interface CostRollup {
  todayUsd: number;
  monthUsd: number;
  byIssue: CostRollupRow[];
}

const TODAY_SQL = `
  SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
  FROM run_audit
  WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
`;

const MONTH_SQL = `
  SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
  FROM run_audit
  WHERE started_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
`;

// Per-issue rollup, lifetime — operators care about hot-spending issues
// regardless of the daily/monthly window. Top 20 by total cost so the
// payload stays small.
const BY_ISSUE_SQL = `
  SELECT
    issue_identifier AS identifier,
    COALESCE(SUM(cost_usd), 0)::float8 AS total_usd,
    COUNT(*)::int AS runs,
    MIN(started_at) AS first_seen,
    MAX(started_at) AS last_seen
  FROM run_audit
  GROUP BY issue_identifier
  ORDER BY total_usd DESC
  LIMIT 20
`;

export async function getCostRollup(pool: pg.Pool): Promise<CostRollup> {
  try {
    const [todayRes, monthRes, byIssueRes] = await Promise.all([
      pool.query<{ total: number }>(TODAY_SQL),
      pool.query<{ total: number }>(MONTH_SQL),
      pool.query<{
        identifier: string;
        total_usd: number;
        runs: number;
        first_seen: Date;
        last_seen: Date;
      }>(BY_ISSUE_SQL),
    ]);
    return {
      todayUsd: round2(todayRes.rows[0]?.total ?? 0),
      monthUsd: round2(monthRes.rows[0]?.total ?? 0),
      byIssue: byIssueRes.rows.map((r) => ({
        identifier: r.identifier,
        totalUsd: round2(r.total_usd),
        runs: r.runs,
        firstSeen: toIso(r.first_seen),
        lastSeen: toIso(r.last_seen),
      })),
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "getCostRollup query failed; returning zeroed rollup",
    );
    return { todayUsd: 0, monthUsd: 0, byIssue: [] };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toIso(d: Date | string | null | undefined): string {
  if (!d) return "";
  if (typeof d === "string") return d;
  return d.toISOString();
}
