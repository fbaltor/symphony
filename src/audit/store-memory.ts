/**
 * Phase C — in-memory store impls (zero-dependency E2E profile).
 *
 * These reproduce the OBSERVABLE semantics of the Postgres-backed functions
 * without a database. The behavioral contract is pinned by
 * `tests/unit/store-contract.test.ts`; this file is the impl those tests run
 * against.
 *
 * Shared backing (per the phase brief): `MemoryMetadataStore`'s retry/cost
 * read queries (`countAttemptsForIssue`, `lastFailedAtForIssue`,
 * `getCostRollup`) aggregate run_audit history — the SAME history a
 * `MemoryAuditSink` writes. So both classes hold a reference to one
 * `MemoryAuditState`. The metadata store also exposes a `recordRunAudit`
 * ingest (its own observable write path for audit rows) so the contract suite
 * can seed history without poking at the sink.
 *
 * Construction:
 *   - `new MemoryMetadataStore()` — fresh metadata map + fresh audit history.
 *   - `new MemoryAuditSink()` — fresh audit history.
 *   - To share one history (E2E composition root), pass a `MemoryAuditState`
 *     instance into both: `new MemoryMetadataStore(state)` +
 *     `new MemoryAuditSink(state)`.
 */

import { PR_VALIDATION_ITERATION_CAP } from "./issue-metadata.js";
import type { IssueMetadata, RecordSpecialistArgs } from "./issue-metadata.js";
import type { CostRollup, CostRollupRow } from "./queries.js";
import type { AuditRow, RunningRunRow } from "./writer.js";
import type { CapDecision, CostCapConfig } from "../guardrails/cost-cap.js";
import type { AuditSink, BudgetStore, MetadataStore } from "./store.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDateUtc(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Shared run_audit + running_runs backing. One instance can be handed to both
 * a `MemoryMetadataStore` (which reads it for retry/cost queries) and a
 * `MemoryAuditSink` (which writes it), so they see the same history — exactly
 * as the Postgres tables are one shared store.
 */
export class MemoryAuditState {
  /** run_audit rows, append-only, insertion order. */
  readonly audits: AuditRow[] = [];
  /** running_runs rows, keyed logically by (issueId, instanceId). */
  readonly running: RunningRunRow[] = [];
}

export class MemoryMetadataStore implements MetadataStore {
  private readonly rows = new Map<string, IssueMetadata>();
  private readonly audit: MemoryAuditState;

  constructor(audit: MemoryAuditState = new MemoryAuditState()) {
    this.audit = audit;
  }

  private now(): Date {
    return new Date();
  }

  private fresh(issueId: string, issueIdentifier: string): IssueMetadata {
    const ts = this.now();
    return {
      issueId,
      issueIdentifier,
      validationIteration: 0,
      questionsAnswered: false,
      planIteration: 0,
      prValidationIteration: 0,
      errorState: null,
      costUsd: 0,
      lastSpecialist: null,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  /** Upsert: return the existing row or insert a fresh one and return it. */
  private upsert(issueId: string, issueIdentifier: string): IssueMetadata {
    let row = this.rows.get(issueId);
    if (!row) {
      row = this.fresh(issueId, issueIdentifier);
      this.rows.set(issueId, row);
    }
    return row;
  }

  getIssueMetadata(issueId: string): Promise<IssueMetadata | null> {
    const row = this.rows.get(issueId);
    // Defensive copy so callers can't mutate our backing row.
    return Promise.resolve(row ? { ...row } : null);
  }

  ensureIssueMetadataRow(args: {
    issueId: string;
    issueIdentifier: string;
  }): Promise<void> {
    // INSERT ... ON CONFLICT DO NOTHING — never overwrite an existing row.
    if (!this.rows.has(args.issueId)) {
      this.rows.set(args.issueId, this.fresh(args.issueId, args.issueIdentifier));
    }
    return Promise.resolve();
  }

  recordSpecialistRun(args: RecordSpecialistArgs): Promise<void> {
    const row = this.upsert(args.issueId, args.issueIdentifier);
    switch (args.iterationKey) {
      case "validation":
        row.validationIteration += 1;
        break;
      case "plan":
        row.planIteration += 1;
        break;
      case "pr_validation":
        row.prValidationIteration += 1;
        break;
      case null:
        // No counter bump (e.g. release / cascade run).
        break;
    }
    row.costUsd += args.costUsdDelta;
    row.lastSpecialist = args.specialist;
    row.updatedAt = this.now();
    return Promise.resolve();
  }

  markQuestionsAnswered(args: {
    issueId: string;
    issueIdentifier: string;
  }): Promise<void> {
    const row = this.upsert(args.issueId, args.issueIdentifier);
    row.questionsAnswered = true;
    row.updatedAt = this.now();
    return Promise.resolve();
  }

  setErrorState(args: {
    issueId: string;
    issueIdentifier: string;
    state: string | null;
  }): Promise<void> {
    const row = this.upsert(args.issueId, args.issueIdentifier);
    row.errorState = args.state;
    row.updatedAt = this.now();
    return Promise.resolve();
  }

  isPrValidationCapped(issueId: string): Promise<boolean> {
    const row = this.rows.get(issueId);
    if (!row) return Promise.resolve(false);
    return Promise.resolve(row.prValidationIteration >= PR_VALIDATION_ITERATION_CAP);
  }

  /**
   * Seed run_audit history (the memory analog of an INSERT into run_audit).
   * Shares the backing with any `MemoryAuditSink` constructed over the same
   * `MemoryAuditState`.
   */
  recordRunAudit(row: AuditRow): Promise<void> {
    this.audit.audits.push(row);
    return Promise.resolve();
  }

  countAttemptsForIssue(issueId: string): Promise<number> {
    const n = this.audit.audits.filter(
      (r) => r.issueId === issueId && r.outcome !== "Succeeded",
    ).length;
    return Promise.resolve(n);
  }

  lastFailedAtForIssue(issueId: string): Promise<Date | null> {
    const failed = this.audit.audits.filter(
      (r) => r.issueId === issueId && r.outcome !== "Succeeded",
    );
    if (failed.length === 0) return Promise.resolve(null);
    const latest = failed.reduce((acc, r) =>
      r.finishedAt.getTime() > acc.finishedAt.getTime() ? r : acc,
    );
    return Promise.resolve(latest.finishedAt);
  }

  getCostRollup(): Promise<CostRollup> {
    const now = new Date();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );

    let todayUsd = 0;
    let monthUsd = 0;
    const byIssueMap = new Map<
      string,
      { totalUsd: number; runs: number; firstSeen: Date; lastSeen: Date }
    >();

    for (const r of this.audit.audits) {
      if (r.startedAt.getTime() >= dayStart.getTime()) todayUsd += r.costUsd;
      if (r.startedAt.getTime() >= monthStart.getTime()) monthUsd += r.costUsd;

      const agg = byIssueMap.get(r.issueIdentifier);
      if (!agg) {
        byIssueMap.set(r.issueIdentifier, {
          totalUsd: r.costUsd,
          runs: 1,
          firstSeen: r.startedAt,
          lastSeen: r.startedAt,
        });
      } else {
        agg.totalUsd += r.costUsd;
        agg.runs += 1;
        if (r.startedAt.getTime() < agg.firstSeen.getTime()) agg.firstSeen = r.startedAt;
        if (r.startedAt.getTime() > agg.lastSeen.getTime()) agg.lastSeen = r.startedAt;
      }
    }

    const byIssue: CostRollupRow[] = Array.from(byIssueMap.entries())
      .map(([identifier, agg]) => ({
        identifier,
        totalUsd: round2(agg.totalUsd),
        runs: agg.runs,
        firstSeen: agg.firstSeen.toISOString(),
        lastSeen: agg.lastSeen.toISOString(),
      }))
      // Lifetime per-issue rollup, hottest spend first (mirrors BY_ISSUE_SQL's
      // ORDER BY total_usd DESC LIMIT 20).
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, 20);

    return Promise.resolve({
      todayUsd: round2(todayUsd),
      monthUsd: round2(monthUsd),
      byIssue,
    });
  }
}

export class MemoryAuditSink implements AuditSink {
  private readonly state: MemoryAuditState;

  constructor(state: MemoryAuditState = new MemoryAuditState()) {
    this.state = state;
  }

  writeRunAudit(row: AuditRow): Promise<void> {
    this.state.audits.push(row);
    return Promise.resolve();
  }

  recordRunStart(row: RunningRunRow): Promise<void> {
    // Upsert on (issueId, instanceId) — no duplicate running rows.
    const idx = this.state.running.findIndex(
      (r) => r.issueId === row.issueId && r.instanceId === row.instanceId,
    );
    if (idx >= 0) {
      this.state.running[idx] = row;
    } else {
      this.state.running.push(row);
    }
    return Promise.resolve();
  }

  recordRunEnd(args: { issueId: string; instanceId: string }): Promise<void> {
    const idx = this.state.running.findIndex(
      (r) => r.issueId === args.issueId && r.instanceId === args.instanceId,
    );
    if (idx >= 0) this.state.running.splice(idx, 1);
    return Promise.resolve();
  }

  reapOrphanedRuns(currentInstanceId: string): Promise<number> {
    // Candidates: every running row NOT owned by the current instance.
    const orphans = this.state.running.filter(
      (r) => r.instanceId !== currentInstanceId,
    );
    for (const row of orphans) {
      const finishedAt = new Date();
      this.state.audits.push({
        issueId: row.issueId,
        issueIdentifier: row.issueIdentifier,
        attempt: row.attempt,
        sessionId: row.sessionId,
        startedAt: finishedAt,
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
          reapedFromInstance: row.instanceId,
          reapedByInstance: currentInstanceId,
        },
      });
    }
    // Remove the reaped running rows in place.
    for (let i = this.state.running.length - 1; i >= 0; i--) {
      const r = this.state.running[i];
      if (r && r.instanceId !== currentInstanceId) this.state.running.splice(i, 1);
    }
    return Promise.resolve(orphans.length);
  }

  listRunAudits(): Promise<AuditRow[]> {
    return Promise.resolve(this.state.audits.slice());
  }

  listRunningRuns(): Promise<RunningRunRow[]> {
    return Promise.resolve(this.state.running.slice());
  }
}

export class MemoryBudgetStore implements BudgetStore {
  // Keyed by `${kind}::${key}::${dayUtc}` to mirror the (scope_kind,
  // scope_key, day_utc) primary key of `budget_state`.
  private readonly counters = new Map<string, number>();

  private keyFor(
    scope: { kind: "daily" | "issue"; key: string },
    at: Date,
  ): string {
    return `${scope.kind}::${scope.key}::${isoDateUtc(at)}`;
  }

  readBudget(
    scope: { kind: "daily" | "issue"; key: string },
    at: Date,
  ): Promise<number> {
    return Promise.resolve(this.counters.get(this.keyFor(scope, at)) ?? 0);
  }

  incrementBudget(
    scope: { kind: "daily" | "issue"; key: string },
    costUsd: number,
    at: Date,
  ): Promise<number> {
    const k = this.keyFor(scope, at);
    const current = this.counters.get(k) ?? 0;
    // Non-positive deltas are a no-op that returns the current total (mirrors
    // budget-state.ts#incrementBudget's `if (costUsd <= 0) return read(...)`).
    if (costUsd <= 0) return Promise.resolve(current);
    const next = current + costUsd;
    this.counters.set(k, next);
    return Promise.resolve(next);
  }

  async recordCost(
    issueId: string,
    costUsd: number,
    at: Date,
  ): Promise<{ dailyUsed: number; perIssueUsed: number }> {
    const dailyUsed = await this.incrementBudget(
      { kind: "daily", key: isoDateUtc(at) },
      costUsd,
      at,
    );
    const perIssueUsed = await this.incrementBudget(
      { kind: "issue", key: issueId },
      costUsd,
      at,
    );
    return { dailyUsed, perIssueUsed };
  }

  async checkCaps(
    cfg: CostCapConfig,
    issueId: string,
    at: Date,
  ): Promise<CapDecision> {
    const daily = await this.readBudget({ kind: "daily", key: isoDateUtc(at) }, at);
    const perIssue = await this.readBudget({ kind: "issue", key: issueId }, at);

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
}
