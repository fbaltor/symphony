/**
 * Issue-metadata accessor — Postgres-backed implementation of the per-issue
 * "custom fields" contract.
 *
 * Linear's GraphQL API doesn't expose user-defined per-issue custom fields
 * (verified via `__schema.mutationType.fields` introspection on 2026-05-06 —
 * only `customViewCreate` exists; per-issue fields are paid-tier + UI-only).
 * Design decision: back the
 * 7 fields with a Postgres table `symphony.issue_metadata` (defined in
 * src/audit/schema.sql).
 *
 * Each row tracks specialist-state for one Linear issue:
 *   - validation_iteration       — Prioritized re-runs
 *   - questions_answered         — true once human moves Questions → Technical plan
 *   - plan_iteration             — Technical plan re-runs
 *   - pr_validation_iteration    — PR validation bounces (capped at 5)
 *   - error_state                — name of escalating stage if Error (manual)
 *   - cost_usd                   — cumulative spend across specialist runs
 *   - last_specialist            — most recent specialist that ran
 *
 * Updates happen at specialist boundaries — orchestrator calls
 * `recordSpecialistRun()` at turn end, specialists themselves never write
 * here directly. This keeps the orchestrator as the single writer (avoids
 * race conditions on concurrent reconciler ticks).
 */

import type pg from "pg";
import { logger } from "../observability/logger.js";

export interface IssueMetadata {
  issueId: string;
  issueIdentifier: string;
  validationIteration: number;
  questionsAnswered: boolean;
  planIteration: number;
  prValidationIteration: number;
  errorState: string | null;
  costUsd: number;
  lastSpecialist: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ROW_TO_METADATA = (row: {
  issue_id: string;
  issue_identifier: string;
  validation_iteration: number;
  questions_answered: boolean;
  plan_iteration: number;
  pr_validation_iteration: number;
  error_state: string | null;
  cost_usd: string; // NUMERIC comes back as string from pg
  last_specialist: string | null;
  created_at: Date;
  updated_at: Date;
}): IssueMetadata => ({
  issueId: row.issue_id,
  issueIdentifier: row.issue_identifier,
  validationIteration: row.validation_iteration,
  questionsAnswered: row.questions_answered,
  planIteration: row.plan_iteration,
  prValidationIteration: row.pr_validation_iteration,
  errorState: row.error_state,
  costUsd: Number(row.cost_usd),
  lastSpecialist: row.last_specialist,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Read the metadata row for an issue. Returns null if no row exists yet
 * (i.e., the issue has never been touched by a specialist).
 *
 * Best-effort: errors are logged + null is returned. Callers should treat
 * a null result as "no prior runs" (counters all 0, flags all false).
 */
export async function getIssueMetadata(
  pool: pg.Pool,
  issueId: string,
): Promise<IssueMetadata | null> {
  try {
    const res = await pool.query(
      `SELECT * FROM symphony.issue_metadata WHERE issue_id = $1`,
      [issueId],
    );
    if (res.rows.length === 0) return null;
    return ROW_TO_METADATA(res.rows[0]);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issueId },
      "getIssueMetadata failed; returning null (caller will treat as fresh)",
    );
    return null;
  }
}

/**
 * UPSERT a fresh row when a specialist runs for the first time on an issue.
 * No-op if a row already exists.
 *
 * Mostly used by the cascade-dispatch path which needs to ensure a row
 * exists for sub-issues before they're handed to specialists.
 */
export async function ensureIssueMetadataRow(
  pool: pg.Pool,
  args: { issueId: string; issueIdentifier: string },
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO symphony.issue_metadata (issue_id, issue_identifier)
         VALUES ($1, $2)
       ON CONFLICT (issue_id) DO NOTHING`,
      [args.issueId, args.issueIdentifier],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issueId: args.issueId },
      "ensureIssueMetadataRow failed; counters may be inconsistent",
    );
  }
}

export interface RecordSpecialistArgs {
  issueId: string;
  issueIdentifier: string;
  /** Which specialist just ran (e.g., "prioritized", "technical-plan"). */
  specialist: string;
  /** Cost of this specialist's run, added to the cumulative total. */
  costUsdDelta: number;
  /**
   * Iteration counter to bump. Each specialist owns ONE counter:
   *   - "prioritized" bumps validation_iteration
   *   - "technical-plan" bumps plan_iteration
   *   - "pr-validation" bumps pr_validation_iteration
   *   - "release" bumps NO counter (it's terminal-ish)
   * `null` means "don't bump any counter" (e.g., a cascade run).
   */
  iterationKey: "validation" | "plan" | "pr_validation" | null;
}

/**
 * Atomic "specialist just finished" write: bump the per-specialist iteration
 * counter, add to cost_usd, set last_specialist, touch updated_at. UPSERTs
 * the row if missing.
 *
 * Best-effort. Failures here corrupt iteration accounting (e.g., a PR
 * validation cap-check might miscount), which is annoying but not
 * load-bearing — the cap is a soft fence, not a security boundary.
 */
export async function recordSpecialistRun(
  pool: pg.Pool,
  args: RecordSpecialistArgs,
): Promise<void> {
  // Map iterationKey → column name. Stays here so callers don't have to
  // remember the SQL column names.
  const counterCol =
    args.iterationKey === "validation"
      ? "validation_iteration"
      : args.iterationKey === "plan"
        ? "plan_iteration"
        : args.iterationKey === "pr_validation"
          ? "pr_validation_iteration"
          : null;

  const counterFragment = counterCol
    ? `${counterCol} = symphony.issue_metadata.${counterCol} + 1, `
    : "";
  const counterInsertVal = counterCol ? "1" : "0";

  try {
    await pool.query(
      `INSERT INTO symphony.issue_metadata (
         issue_id, issue_identifier, validation_iteration, plan_iteration,
         pr_validation_iteration, cost_usd, last_specialist
       ) VALUES (
         $1, $2,
         ${args.iterationKey === "validation" ? counterInsertVal : "0"},
         ${args.iterationKey === "plan" ? counterInsertVal : "0"},
         ${args.iterationKey === "pr_validation" ? counterInsertVal : "0"},
         $3, $4
       )
       ON CONFLICT (issue_id) DO UPDATE
         SET ${counterFragment}
             cost_usd = symphony.issue_metadata.cost_usd + EXCLUDED.cost_usd,
             last_specialist = EXCLUDED.last_specialist,
             updated_at = now()`,
      [args.issueId, args.issueIdentifier, args.costUsdDelta, args.specialist],
    );
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        issueId: args.issueId,
        specialist: args.specialist,
      },
      "recordSpecialistRun failed; iteration counter may be inconsistent",
    );
  }
}

/**
 * Mark an issue as having received its first human answer. Set when the
 * human moves Questions (manual) → Technical plan for the first time.
 * Idempotent.
 */
export async function markQuestionsAnswered(
  pool: pg.Pool,
  args: { issueId: string; issueIdentifier: string },
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO symphony.issue_metadata (issue_id, issue_identifier, questions_answered)
         VALUES ($1, $2, TRUE)
       ON CONFLICT (issue_id) DO UPDATE
         SET questions_answered = TRUE, updated_at = now()`,
      [args.issueId, args.issueIdentifier],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issueId: args.issueId },
      "markQuestionsAnswered failed; flag may be inconsistent",
    );
  }
}

/**
 * Set error_state when a specialist escalates an issue to Error (manual).
 *
 * `state` is the name of the stage that triggered the escalation
 * (e.g., "PR validation" when the iteration cap is hit). Set to null to
 * clear the field (e.g., human re-routes the ticket out of Error).
 */
export async function setErrorState(
  pool: pg.Pool,
  args: {
    issueId: string;
    issueIdentifier: string;
    state: string | null;
  },
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO symphony.issue_metadata (issue_id, issue_identifier, error_state)
         VALUES ($1, $2, $3)
       ON CONFLICT (issue_id) DO UPDATE
         SET error_state = EXCLUDED.error_state, updated_at = now()`,
      [args.issueId, args.issueIdentifier, args.state],
    );
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        issueId: args.issueId,
        state: args.state,
      },
      "setErrorState failed; error_state may be inconsistent",
    );
  }
}

/**
 * PR validation iteration cap helper. Returns `true` if the issue has
 * already hit its iteration cap (5 by default — must escalate to Error).
 *
 * Reads metadata; if no row, returns false (fresh issue, hasn't started yet).
 */
export const PR_VALIDATION_ITERATION_CAP = 5;

export async function isPrValidationCapped(
  pool: pg.Pool,
  issueId: string,
): Promise<boolean> {
  const meta = await getIssueMetadata(pool, issueId);
  if (!meta) return false;
  return meta.prValidationIteration >= PR_VALIDATION_ITERATION_CAP;
}
