import type pg from "pg";
import { logger } from "../observability/logger.js";

/**
 * Persistent cost counters for the cost-cap middleware.
 *
 *   - daily counter: scope_kind='daily', scope_key=ISO date string
 *   - per-issue counter: scope_kind='issue', scope_key=issueId
 *
 * Atomicity: increments use INSERT ... ON CONFLICT DO UPDATE.
 */

interface ScopeKey {
  kind: "daily" | "issue";
  key: string;
}

export function isoDateUtc(at: Date): string {
  return at.toISOString().slice(0, 10);
}

const INC_SQL = `
  INSERT INTO budget_state (scope_kind, scope_key, day_utc, cost_usd, updated_at)
  VALUES ($1, $2, $3, $4, now())
  ON CONFLICT (scope_kind, scope_key, day_utc)
  DO UPDATE SET cost_usd = budget_state.cost_usd + EXCLUDED.cost_usd,
                updated_at = now()
  RETURNING cost_usd::float AS new_cost
`;

const READ_SQL = `
  SELECT COALESCE(cost_usd::float, 0) AS cost
  FROM budget_state
  WHERE scope_kind = $1 AND scope_key = $2 AND day_utc = $3
`;

export async function incrementBudget(
  pool: pg.Pool,
  scope: ScopeKey,
  costUsd: number,
  at: Date = new Date(),
): Promise<number> {
  if (costUsd <= 0) {
    return readBudget(pool, scope, at);
  }
  try {
    const res = await pool.query<{ new_cost: number }>(INC_SQL, [
      scope.kind,
      scope.key,
      isoDateUtc(at),
      costUsd,
    ]);
    return res.rows[0]?.new_cost ?? 0;
  } catch (err) {
    logger.error({ err: (err as Error).message, scope }, "incrementBudget failed");
    return 0;
  }
}

export async function readBudget(
  pool: pg.Pool,
  scope: ScopeKey,
  at: Date = new Date(),
): Promise<number> {
  try {
    const res = await pool.query<{ cost: number }>(READ_SQL, [
      scope.kind,
      scope.key,
      isoDateUtc(at),
    ]);
    return res.rows[0]?.cost ?? 0;
  } catch (err) {
    logger.error({ err: (err as Error).message, scope }, "readBudget failed");
    return 0;
  }
}
