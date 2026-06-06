/**
 * Phase C — Postgres-backed store impls.
 *
 * Each class holds a `pg.Pool` and delegates to the EXACT existing functions
 * in `audit/*` + `guardrails/*` with the pool re-supplied as the first arg.
 * No SQL is rewritten here: the wrapped functions stay the single source of
 * truth so the `kind=linear` path is byte-for-byte identical to today and the
 * existing mock-pool unit tests (audit-cost-rollup / audit-reaper /
 * issue-metadata) keep covering them.
 *
 * The only PG that lives directly in this file is the two `list*` query
 * accessors on `PostgresAuditSink` — they exist purely so the `AuditSink`
 * interface is uniform across the memory + Postgres impls (the memory impl
 * needs them to be assertable). They are read-only SELECTs over the same
 * `run_audit` / `running_runs` tables the wrapped writers target.
 */

import type pg from "pg";

import {
  ensureIssueMetadataRow,
  getIssueMetadata,
  isPrValidationCapped,
  markQuestionsAnswered,
  recordSpecialistRun,
  setErrorState,
  type IssueMetadata,
  type RecordSpecialistArgs,
} from "./issue-metadata.js";
import {
  countAttemptsForIssue,
  getCostRollup,
  lastFailedAtForIssue,
  type CostRollup,
} from "./queries.js";
import {
  reapOrphanedRuns,
  recordRunEnd,
  recordRunStart,
  writeRunAudit,
  type AuditRow,
  type RunningRunRow,
} from "./writer.js";
// `recordRunAudit` on the metadata store and `writeRunAudit` on the audit sink
// both target `run_audit` — the metadata store's read queries aggregate that
// same table, so its ingest delegates to the identical writer.
import {
  checkCaps,
  recordCost,
  type CapDecision,
  type CostCapConfig,
} from "../guardrails/cost-cap.js";
import { incrementBudget, readBudget } from "../guardrails/budget-state.js";
import type { AuditSink, BudgetStore, MetadataStore } from "./store.js";

export class PostgresMetadataStore implements MetadataStore {
  constructor(private readonly pool: pg.Pool) {}

  getIssueMetadata(issueId: string): Promise<IssueMetadata | null> {
    return getIssueMetadata(this.pool, issueId);
  }

  ensureIssueMetadataRow(args: {
    issueId: string;
    issueIdentifier: string;
  }): Promise<void> {
    return ensureIssueMetadataRow(this.pool, args);
  }

  recordSpecialistRun(args: RecordSpecialistArgs): Promise<void> {
    return recordSpecialistRun(this.pool, args);
  }

  markQuestionsAnswered(args: {
    issueId: string;
    issueIdentifier: string;
  }): Promise<void> {
    return markQuestionsAnswered(this.pool, args);
  }

  setErrorState(args: {
    issueId: string;
    issueIdentifier: string;
    state: string | null;
  }): Promise<void> {
    return setErrorState(this.pool, args);
  }

  isPrValidationCapped(issueId: string): Promise<boolean> {
    return isPrValidationCapped(this.pool, issueId);
  }

  recordRunAudit(row: AuditRow): Promise<void> {
    return writeRunAudit(this.pool, row);
  }

  countAttemptsForIssue(issueId: string): Promise<number> {
    return countAttemptsForIssue(this.pool, issueId);
  }

  lastFailedAtForIssue(issueId: string): Promise<Date | null> {
    return lastFailedAtForIssue(this.pool, issueId);
  }

  getCostRollup(): Promise<CostRollup> {
    return getCostRollup(this.pool);
  }
}

export class PostgresAuditSink implements AuditSink {
  constructor(private readonly pool: pg.Pool) {}

  writeRunAudit(row: AuditRow): Promise<void> {
    return writeRunAudit(this.pool, row);
  }

  recordRunStart(row: RunningRunRow): Promise<void> {
    return recordRunStart(this.pool, row);
  }

  recordRunEnd(args: { issueId: string; instanceId: string }): Promise<void> {
    return recordRunEnd(this.pool, args);
  }

  reapOrphanedRuns(currentInstanceId: string): Promise<number> {
    return reapOrphanedRuns(this.pool, currentInstanceId);
  }

  async listRunAudits(): Promise<AuditRow[]> {
    const res = await this.pool.query<{
      issue_id: string;
      issue_identifier: string;
      attempt: number | null;
      session_id: string | null;
      started_at: Date;
      finished_at: Date;
      outcome: string;
      runtime: string;
      model: string | null;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cost_usd: string | number;
      error: string | null;
      prompt_version: string | null;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    }>(
      `SELECT issue_id, issue_identifier, attempt, session_id, started_at,
              finished_at, outcome, runtime, model, input_tokens, output_tokens,
              total_tokens, cost_usd, error, prompt_version,
              cache_creation_input_tokens, cache_read_input_tokens
         FROM run_audit
        ORDER BY started_at ASC`,
    );
    return res.rows.map((r) => ({
      issueId: r.issue_id,
      issueIdentifier: r.issue_identifier,
      attempt: r.attempt,
      sessionId: r.session_id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      outcome: r.outcome,
      runtime: r.runtime,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens,
      costUsd: Number(r.cost_usd),
      error: r.error,
      promptVersion: r.prompt_version,
      cacheCreationInputTokens: r.cache_creation_input_tokens,
      cacheReadInputTokens: r.cache_read_input_tokens,
    }));
  }

  async listRunningRuns(): Promise<RunningRunRow[]> {
    const res = await this.pool.query<{
      issue_id: string;
      issue_identifier: string;
      instance_id: string;
      attempt: number | null;
      session_id: string | null;
    }>(
      `SELECT issue_id, issue_identifier, instance_id, attempt, session_id
         FROM running_runs
        ORDER BY started_at ASC`,
    );
    return res.rows.map((r) => ({
      issueId: r.issue_id,
      issueIdentifier: r.issue_identifier,
      instanceId: r.instance_id,
      attempt: r.attempt,
      sessionId: r.session_id,
    }));
  }
}

export class PostgresBudgetStore implements BudgetStore {
  constructor(private readonly pool: pg.Pool) {}

  readBudget(
    scope: { kind: "daily" | "issue"; key: string },
    at: Date,
  ): Promise<number> {
    return readBudget(this.pool, scope, at);
  }

  incrementBudget(
    scope: { kind: "daily" | "issue"; key: string },
    costUsd: number,
    at: Date,
  ): Promise<number> {
    return incrementBudget(this.pool, scope, costUsd, at);
  }

  recordCost(
    issueId: string,
    costUsd: number,
    at: Date,
  ): Promise<{ dailyUsed: number; perIssueUsed: number }> {
    return recordCost(this.pool, issueId, costUsd, at);
  }

  checkCaps(
    cfg: CostCapConfig,
    issueId: string,
    at: Date,
  ): Promise<CapDecision> {
    return checkCaps(this.pool, cfg, issueId, at);
  }
}
