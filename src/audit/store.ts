/**
 * Phase C — Postgres abstraction: store interfaces.
 *
 * The orchestrator and specialists used to thread a raw `pg.Pool` and call
 * free functions (`getIssueMetadata(pool, …)`, `writeRunAudit(pool, …)`,
 * `checkCaps(pool, …)`, …). This file declares three narrow interfaces that
 * mirror those functions with the leading `pool` argument dropped (it becomes
 * `this`):
 *
 *   - `MetadataStore` — issue_metadata reads/writes (issue-metadata.ts) plus
 *     the run_audit-derived retry/cost-rollup read queries (queries.ts).
 *   - `AuditSink`     — run_audit + running_runs writes and the orphan reaper
 *     (writer.ts), with list accessors so in-memory impls are assertable.
 *   - `BudgetStore`   — budget_state counters + the cost-cap decision
 *     (budget-state.ts + cost-cap.ts).
 *
 * Two impls satisfy each interface:
 *   - `store-postgres.ts` — EXACT thin wrappers that delegate to the existing
 *     functions unchanged, so the `kind=linear` path is byte-for-byte
 *     identical to today.
 *   - `store-memory.ts` — real in-memory semantics for the zero-dependency
 *     E2E profile, validated by `tests/unit/store-contract.test.ts`.
 *
 * Types are reused from the modules being wrapped — they are imported and
 * re-exported here, never redeclared, so the two impls and their callers
 * share one source of truth.
 */

import type {
  IssueMetadata,
  RecordSpecialistArgs,
} from "./issue-metadata.js";
import type { CostRollup } from "./queries.js";
import type { AuditRow, RunningRunRow } from "./writer.js";
import type { CapDecision, CostCapConfig } from "../guardrails/cost-cap.js";

export type {
  IssueMetadata,
  RecordSpecialistArgs,
  CostRollup,
  AuditRow,
  RunningRunRow,
  CapDecision,
  CostCapConfig,
};

/**
 * Per-issue specialist metadata + the run_audit-derived retry/cost queries.
 *
 * Mirrors `src/audit/issue-metadata.ts` and `src/audit/queries.ts` with the
 * leading `pool` argument dropped.
 */
export interface MetadataStore {
  /** issue-metadata.ts#getIssueMetadata */
  getIssueMetadata(issueId: string): Promise<IssueMetadata | null>;
  /** issue-metadata.ts#ensureIssueMetadataRow */
  ensureIssueMetadataRow(args: {
    issueId: string;
    issueIdentifier: string;
  }): Promise<void>;
  /** issue-metadata.ts#recordSpecialistRun */
  recordSpecialistRun(args: RecordSpecialistArgs): Promise<void>;
  /** issue-metadata.ts#markQuestionsAnswered */
  markQuestionsAnswered(args: {
    issueId: string;
    issueIdentifier: string;
  }): Promise<void>;
  /** issue-metadata.ts#setErrorState */
  setErrorState(args: {
    issueId: string;
    issueIdentifier: string;
    state: string | null;
  }): Promise<void>;
  /** issue-metadata.ts#isPrValidationCapped */
  isPrValidationCapped(issueId: string): Promise<boolean>;

  /**
   * Ingest a run_audit row into the history the retry/cost read queries
   * aggregate. The Postgres impl writes the same `run_audit` table
   * `AuditSink.writeRunAudit` targets; the memory impl shares one backing
   * store with its paired `MemoryAuditSink`. Exposed so the metadata store's
   * read queries (`countAttemptsForIssue` / `lastFailedAtForIssue` /
   * `getCostRollup`) have an observable write path to aggregate over.
   */
  recordRunAudit(row: AuditRow): Promise<void>;
  /** queries.ts#countAttemptsForIssue (reads run_audit history) */
  countAttemptsForIssue(issueId: string): Promise<number>;
  /** queries.ts#lastFailedAtForIssue (reads run_audit history) */
  lastFailedAtForIssue(issueId: string): Promise<Date | null>;
  /** queries.ts#getCostRollup (aggregates run_audit history) */
  getCostRollup(): Promise<CostRollup>;
}

/**
 * Run-audit + running-run writes and the orphan reaper.
 *
 * Mirrors `src/audit/writer.ts` with the leading `pool` argument dropped. The
 * `list*` accessors are query helpers the memory contract suite uses to assert
 * recorded rows; the Postgres impl backs them with the same SELECTs.
 */
export interface AuditSink {
  /** writer.ts#writeRunAudit */
  writeRunAudit(row: AuditRow): Promise<void>;
  /** writer.ts#recordRunStart */
  recordRunStart(row: RunningRunRow): Promise<void>;
  /** writer.ts#recordRunEnd */
  recordRunEnd(args: { issueId: string; instanceId: string }): Promise<void>;
  /** writer.ts#reapOrphanedRuns — returns the number of rows reaped. */
  reapOrphanedRuns(currentInstanceId: string): Promise<number>;

  /** Query accessor: every recorded run_audit row, insertion order. */
  listRunAudits(): Promise<AuditRow[]>;
  /** Query accessor: the currently-tracked running_runs rows. */
  listRunningRuns(): Promise<RunningRunRow[]>;
}

/**
 * Budget counters + the cost-cap decision.
 *
 * Mirrors `src/guardrails/budget-state.ts` and `src/guardrails/cost-cap.ts`
 * with the leading `pool` argument dropped. Each method takes a trailing
 * `at: Date` so tests can pin the day-of-month bucket; it mirrors the `at`
 * argument the underlying functions already accept.
 */
export interface BudgetStore {
  /** budget-state.ts#readBudget */
  readBudget(
    scope: { kind: "daily" | "issue"; key: string },
    at: Date,
  ): Promise<number>;
  /** budget-state.ts#incrementBudget */
  incrementBudget(
    scope: { kind: "daily" | "issue"; key: string },
    costUsd: number,
    at: Date,
  ): Promise<number>;
  /** cost-cap.ts#recordCost */
  recordCost(
    issueId: string,
    costUsd: number,
    at: Date,
  ): Promise<{ dailyUsed: number; perIssueUsed: number }>;
  /** cost-cap.ts#checkCaps */
  checkCaps(
    cfg: CostCapConfig,
    issueId: string,
    at: Date,
  ): Promise<CapDecision>;
}
