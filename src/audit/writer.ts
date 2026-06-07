import type pg from "pg";
import { logger } from "../observability/logger.js";

/**
 * In-flight run tracking.
 *
 * Each worker writes a `running_runs` row on dispatch and deletes it
 * on terminal outcome. If the container dies (OOM, OOM-aware SIGKILL,
 * Cloud Run scale-down without grace), the row stays. The next
 * orchestrator boot's reaper finds these rows, writes synthetic
 * `outcome=Killed` audit rows, and deletes them — closing the
 * cost-truth gap where 6 OOM'd Implement
 * dispatches produced ZERO audit rows.
 */

export interface RunningRunRow {
  issueId: string;
  issueIdentifier: string;
  instanceId: string;
  attempt: number | null;
  sessionId: string | null;
}

/**
 * Best-effort: log + swallow on failure. Tracking is observability,
 * not correctness — a worker that fails to record itself still runs.
 */
export async function recordRunStart(
  pool: pg.Pool,
  row: RunningRunRow,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO running_runs (issue_id, issue_identifier, instance_id, attempt, session_id)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (issue_id, instance_id) DO UPDATE
         SET attempt = EXCLUDED.attempt,
             session_id = EXCLUDED.session_id,
             started_at = now()`,
      [row.issueId, row.issueIdentifier, row.instanceId, row.attempt, row.sessionId],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issue: row.issueIdentifier },
      "recordRunStart failed; continuing",
    );
  }
}

export async function recordRunEnd(
  pool: pg.Pool,
  args: { issueId: string; instanceId: string },
): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM running_runs WHERE issue_id = $1 AND instance_id = $2`,
      [args.issueId, args.instanceId],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issue: args.issueId },
      "recordRunEnd failed; continuing (row will reap on next boot)",
    );
  }
}

/**
 * On boot, find rows from previous instances and write synthetic
 * `outcome=Killed` audit rows. Should be invoked AFTER acquireInstanceLock
 * succeeds (so we know the current instance_id). Runs once at boot;
 * subsequent worker lifecycles use recordRunStart/recordRunEnd directly.
 *
 * `currentInstanceId` is excluded so concurrent in-flight workers on
 * THIS instance aren't reaped. Only previous-instance rows are
 * candidates.
 *
 * Returns the number of rows reaped (for logging + tests).
 */
export async function reapOrphanedRuns(
  pool: pg.Pool,
  currentInstanceId: string,
): Promise<number> {
  let reaped = 0;
  try {
    const res = await pool.query<{
      issue_id: string;
      issue_identifier: string;
      instance_id: string;
      attempt: number | null;
      session_id: string | null;
      started_at: Date;
    }>(
      `SELECT issue_id, issue_identifier, instance_id, attempt, session_id, started_at
         FROM running_runs
        WHERE instance_id != $1`,
      [currentInstanceId],
    );
    for (const row of res.rows) {
      const finishedAt = new Date();
      await writeRunAudit(pool, {
        issueId: row.issue_id,
        issueIdentifier: row.issue_identifier,
        attempt: row.attempt,
        sessionId: row.session_id,
        startedAt: row.started_at,
        finishedAt,
        outcome: "Killed",
        runtime: "claude",
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        error: "container died before turn completed (reaped on next boot)",
        extra: {
          killed: true,
          reapedFromInstance: row.instance_id,
          reapedByInstance: currentInstanceId,
        },
      });
      // Best-effort delete after audit. If this fails, next boot reaps
      // again — the synthetic audit is idempotent on (issue_id, attempt)
      // because attempt is unique per turn and the run_audit table
      // doesn't enforce a unique constraint anyway, so duplicate Killed
      // rows are tolerable.
      await pool
        .query(`DELETE FROM running_runs WHERE issue_id = $1 AND instance_id = $2`, [
          row.issue_id,
          row.instance_id,
        ])
        .catch((err) =>
          logger.warn(
            { err: (err as Error).message, issue: row.issue_identifier },
            "reapOrphanedRuns: delete failed; row will retry on next boot",
          ),
        );
      reaped += 1;
    }
    if (reaped > 0) {
      logger.warn(
        { reaped, currentInstanceId },
        "reapOrphanedRuns: wrote synthetic Killed audit rows for previous-instance runs",
      );
    }
  } catch (err) {
    // The reaper is observability — failure here doesn't block boot.
    logger.warn(
      { err: (err as Error).message },
      "reapOrphanedRuns failed; previous-instance runs will be re-reaped on next boot",
    );
  }
  return reaped;
}

export interface AuditRow {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  sessionId: string | null;
  startedAt: Date;
  finishedAt: Date;
  outcome: string;
  runtime: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  error: string | null;
  /**
   * per-run prompt provenance. Set this from the build SHA
   * (`readGitSha()`) until per-stage prompt modules land; once
   * `src/agents/<state>/prompt.ts` exists, set to the prompt file's
   * content hash so a regression to a specific prompt is post-hoc
   * analyzable.
   */
  promptVersion?: string | null;
  /**
   * Anthropic prompt-cache observability.
   * Both fields default to 0 in the schema, so older callers that don't
   * pass them produce a row with cache_*_tokens = 0 and don't break.
   * Optional in the AuditRow type for the same reason — the orphan-reaper
   * `Killed` rows pass zeros explicitly and shouldn't have to.
   */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  extra?: Record<string, unknown>;
}

const INSERT_SQL = `
  INSERT INTO run_audit (
    issue_id, issue_identifier, attempt, session_id,
    started_at, finished_at, outcome, runtime, model,
    input_tokens, output_tokens, total_tokens, cost_usd,
    error, prompt_version,
    cache_creation_input_tokens, cache_read_input_tokens,
    extra
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
  )
`;

/**
 * Best-effort audit row writer. Errors are logged and swallowed — the spec
 * (§14.2) requires that observability failures do NOT crash the orchestrator.
 */
export async function writeRunAudit(pool: pg.Pool, row: AuditRow): Promise<void> {
  try {
    await pool.query(INSERT_SQL, [
      row.issueId,
      row.issueIdentifier,
      row.attempt,
      row.sessionId,
      row.startedAt,
      row.finishedAt,
      row.outcome,
      row.runtime,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.totalTokens,
      row.costUsd,
      row.error,
      row.promptVersion ?? null,
      // 0 default mirrors the SQL DEFAULT 0; older callers
      // (orphan reaper passing only the 14 historical fields) end up with
      // 0 here, which is the right answer — a Killed run has no usage.
      row.cacheCreationInputTokens ?? 0,
      row.cacheReadInputTokens ?? 0,
      row.extra ? JSON.stringify(row.extra) : null,
    ]);
  } catch (err) {
    const e = err as Error;
    logger.error(
      { err: e.message, stack: e.stack, issue: row.issueIdentifier },
      "writeRunAudit failed; continuing",
    );
  }
}
