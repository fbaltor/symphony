import type pg from "pg";
import { incrementBudget, isoDateUtc, readBudget } from "./budget-state.js";

/**
 * Cost-cap middleware (Symphony extension; not in spec).
 *
 *   - Pre-dispatch check: reject if either daily or per-issue cap is already
 *     exceeded. The check is advisory — it doesn't kill in-flight turns.
 *   - Post-turn record: increment both counters by the turn's cost.
 *
 * Both reads and writes are best-effort: if Postgres is unreachable, the
 * cap reverts to "permit" so the orchestrator stays alive.
 */

export interface CostCapConfig {
  dailyCapUsd: number;
  perIssueCapUsd: number;
}

export interface CapDecision {
  allowed: boolean;
  reason?: string;
  dailyUsed: number;
  perIssueUsed: number;
}

export async function checkCaps(
  pool: pg.Pool,
  cfg: CostCapConfig,
  issueId: string,
): Promise<CapDecision> {
  const today = new Date();
  const [daily, perIssue] = await Promise.all([
    readBudget(pool, { kind: "daily", key: isoDateUtc(today) }, today),
    readBudget(pool, { kind: "issue", key: issueId }, today),
  ]);

  if (cfg.dailyCapUsd > 0 && daily >= cfg.dailyCapUsd) {
    return {
      allowed: false,
      reason: `daily cap exceeded ($${daily.toFixed(2)} >= $${cfg.dailyCapUsd.toFixed(2)})`,
      dailyUsed: daily,
      perIssueUsed: perIssue,
    };
  }
  if (cfg.perIssueCapUsd > 0 && perIssue >= cfg.perIssueCapUsd) {
    return {
      allowed: false,
      reason: `per-issue cap exceeded ($${perIssue.toFixed(2)} >= $${cfg.perIssueCapUsd.toFixed(2)})`,
      dailyUsed: daily,
      perIssueUsed: perIssue,
    };
  }
  return { allowed: true, dailyUsed: daily, perIssueUsed: perIssue };
}

export async function recordCost(
  pool: pg.Pool,
  issueId: string,
  costUsd: number,
): Promise<{ dailyUsed: number; perIssueUsed: number }> {
  const today = new Date();
  const [dailyUsed, perIssueUsed] = await Promise.all([
    incrementBudget(pool, { kind: "daily", key: isoDateUtc(today) }, costUsd, today),
    incrementBudget(pool, { kind: "issue", key: issueId }, costUsd, today),
  ]);
  return { dailyUsed, perIssueUsed };
}
