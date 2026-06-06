/**
 * Phase C — Postgres abstraction: behavioral contract suite.
 *
 * These tests define the OBSERVABLE contract for the three new stores
 * introduced in phase C:
 *
 *   - MetadataStore  (wraps src/audit/issue-metadata.ts + src/audit/queries.ts)
 *   - AuditSink      (wraps src/audit/writer.ts)
 *   - BudgetStore    (wraps src/guardrails/budget-state.ts + cost-cap.ts)
 *
 * Strategy (decided in the phase brief):
 *   - The suite asserts real in-memory semantics against the MEMORY impls
 *     (`MemoryMetadataStore`, `MemoryAuditSink`, `MemoryBudgetStore`).
 *   - Each contract is written as a parameterized `*Contract(makeStore)`
 *     function so the SAME assertions can later run against a Postgres impl
 *     in integration. Right now only the memory impls are wired (the repo
 *     has no live DB and no pg-mem, and we must not add one).
 *
 * Methods on the stores mirror the existing module functions with the
 * leading `pool` argument dropped (it becomes `this`). We assert observable
 * behavior — counters increment, caps trip at threshold N, audit rows are
 * recorded and queryable — NOT SQL strings (those stay covered by the
 * existing mock-pool unit tests: issue-metadata / audit-cost-rollup /
 * audit-reaper).
 *
 * RED until phase C lands `src/audit/store{,-memory}.ts`.
 */

import { describe, expect, it } from "vitest";

import type {
  MetadataStore,
  AuditSink,
  BudgetStore,
} from "../../src/audit/store.js";
import {
  MemoryMetadataStore,
  MemoryAuditSink,
  MemoryBudgetStore,
} from "../../src/audit/store-memory.js";

import {
  PR_VALIDATION_ITERATION_CAP,
  type RecordSpecialistArgs,
} from "../../src/audit/issue-metadata.js";
import type { AuditRow, RunningRunRow } from "../../src/audit/writer.js";
import type { CostCapConfig } from "../../src/guardrails/cost-cap.js";

const ISSUE_ID = "00000000-0000-0000-0000-000000000001";
const ISSUE_IDENT = "STG-TEST-1";

// Convenience builders so the tests read cleanly.
function specialistRun(
  over: Partial<RecordSpecialistArgs> = {},
): RecordSpecialistArgs {
  return {
    issueId: ISSUE_ID,
    issueIdentifier: ISSUE_IDENT,
    specialist: "prioritized",
    costUsdDelta: 1,
    iterationKey: "validation",
    ...over,
  };
}

function auditRow(over: Partial<AuditRow> = {}): AuditRow {
  return {
    issueId: ISSUE_ID,
    issueIdentifier: ISSUE_IDENT,
    attempt: 1,
    sessionId: "session-1",
    startedAt: new Date("2026-06-05T10:00:00Z"),
    finishedAt: new Date("2026-06-05T10:05:00Z"),
    outcome: "Succeeded",
    runtime: "claude",
    model: "claude-opus-4-7",
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    costUsd: 1.25,
    error: null,
    ...over,
  };
}

function runningRow(over: Partial<RunningRunRow> = {}): RunningRunRow {
  return {
    issueId: ISSUE_ID,
    issueIdentifier: ISSUE_IDENT,
    instanceId: "rev-00020-abc",
    attempt: 1,
    sessionId: "session-1",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// MetadataStore contract
// ---------------------------------------------------------------------------

export function metadataStoreContract(makeStore: () => MetadataStore): void {
  describe("MetadataStore contract", () => {
    it("getIssueMetadata returns null for an unknown issue (fresh)", async () => {
      const store = makeStore();
      expect(await store.getIssueMetadata(ISSUE_ID)).toBeNull();
    });

    it("ensureIssueMetadataRow creates a fresh row with zeroed counters/flags", async () => {
      const store = makeStore();
      await store.ensureIssueMetadataRow({
        issueId: ISSUE_ID,
        issueIdentifier: ISSUE_IDENT,
      });
      const meta = await store.getIssueMetadata(ISSUE_ID);
      expect(meta).not.toBeNull();
      expect(meta!.issueId).toBe(ISSUE_ID);
      expect(meta!.issueIdentifier).toBe(ISSUE_IDENT);
      expect(meta!.validationIteration).toBe(0);
      expect(meta!.questionsAnswered).toBe(false);
      expect(meta!.planIteration).toBe(0);
      expect(meta!.prValidationIteration).toBe(0);
      expect(meta!.errorState).toBeNull();
      expect(meta!.costUsd).toBe(0);
      expect(meta!.lastSpecialist).toBeNull();
    });

    it("ensureIssueMetadataRow is idempotent (no overwrite of an existing row)", async () => {
      const store = makeStore();
      await store.ensureIssueMetadataRow({ issueId: ISSUE_ID, issueIdentifier: ISSUE_IDENT });
      await store.recordSpecialistRun(specialistRun({ costUsdDelta: 3 }));
      // ensure again — must NOT reset the accumulated state.
      await store.ensureIssueMetadataRow({ issueId: ISSUE_ID, issueIdentifier: ISSUE_IDENT });
      const meta = await store.getIssueMetadata(ISSUE_ID);
      expect(meta!.validationIteration).toBe(1);
      expect(meta!.costUsd).toBeCloseTo(3);
    });

    it("recordSpecialistRun bumps the validation counter for iterationKey=validation", async () => {
      const store = makeStore();
      await store.recordSpecialistRun(
        specialistRun({ specialist: "prioritized", iterationKey: "validation", costUsdDelta: 1.5 }),
      );
      const meta = await store.getIssueMetadata(ISSUE_ID);
      expect(meta!.validationIteration).toBe(1);
      expect(meta!.planIteration).toBe(0);
      expect(meta!.prValidationIteration).toBe(0);
      expect(meta!.costUsd).toBeCloseTo(1.5);
      expect(meta!.lastSpecialist).toBe("prioritized");
    });

    it("recordSpecialistRun accumulates counter + cost across repeated runs", async () => {
      const store = makeStore();
      await store.recordSpecialistRun(specialistRun({ costUsdDelta: 1.5 }));
      await store.recordSpecialistRun(specialistRun({ costUsdDelta: 0.7 }));
      const meta = await store.getIssueMetadata(ISSUE_ID);
      expect(meta!.validationIteration).toBe(2);
      expect(meta!.costUsd).toBeCloseTo(2.2);
    });

    it("recordSpecialistRun bumps independent counters per iterationKey", async () => {
      const store = makeStore();
      await store.recordSpecialistRun(
        specialistRun({ specialist: "prioritized", iterationKey: "validation", costUsdDelta: 1 }),
      );
      await store.recordSpecialistRun(
        specialistRun({ specialist: "technical-plan", iterationKey: "plan", costUsdDelta: 2 }),
      );
      await store.recordSpecialistRun(
        specialistRun({
          specialist: "pr-validation",
          iterationKey: "pr_validation",
          costUsdDelta: 3,
        }),
      );
      const meta = await store.getIssueMetadata(ISSUE_ID);
      expect(meta!.validationIteration).toBe(1);
      expect(meta!.planIteration).toBe(1);
      expect(meta!.prValidationIteration).toBe(1);
      expect(meta!.costUsd).toBeCloseTo(6);
      expect(meta!.lastSpecialist).toBe("pr-validation");
    });

    it("recordSpecialistRun with iterationKey=null records cost/specialist but bumps no counter", async () => {
      const store = makeStore();
      await store.recordSpecialistRun(
        specialistRun({ specialist: "release", iterationKey: null, costUsdDelta: 5 }),
      );
      const meta = await store.getIssueMetadata(ISSUE_ID);
      expect(meta!.validationIteration).toBe(0);
      expect(meta!.planIteration).toBe(0);
      expect(meta!.prValidationIteration).toBe(0);
      expect(meta!.costUsd).toBeCloseTo(5);
      expect(meta!.lastSpecialist).toBe("release");
    });

    it("markQuestionsAnswered flips the flag and is idempotent", async () => {
      const store = makeStore();
      await store.markQuestionsAnswered({ issueId: ISSUE_ID, issueIdentifier: ISSUE_IDENT });
      expect((await store.getIssueMetadata(ISSUE_ID))!.questionsAnswered).toBe(true);
      await store.markQuestionsAnswered({ issueId: ISSUE_ID, issueIdentifier: ISSUE_IDENT });
      expect((await store.getIssueMetadata(ISSUE_ID))!.questionsAnswered).toBe(true);
    });

    it("setErrorState writes the stage name and clears with null", async () => {
      const store = makeStore();
      await store.setErrorState({
        issueId: ISSUE_ID,
        issueIdentifier: ISSUE_IDENT,
        state: "PR validation",
      });
      expect((await store.getIssueMetadata(ISSUE_ID))!.errorState).toBe("PR validation");
      await store.setErrorState({
        issueId: ISSUE_ID,
        issueIdentifier: ISSUE_IDENT,
        state: null,
      });
      expect((await store.getIssueMetadata(ISSUE_ID))!.errorState).toBeNull();
    });

    it("isPrValidationCapped is false on a fresh issue", async () => {
      const store = makeStore();
      expect(await store.isPrValidationCapped(ISSUE_ID)).toBe(false);
    });

    it("isPrValidationCapped is false strictly below the cap and true at the cap", async () => {
      const store = makeStore();
      // One below the cap → still permitted.
      for (let i = 0; i < PR_VALIDATION_ITERATION_CAP - 1; i++) {
        await store.recordSpecialistRun(
          specialistRun({ specialist: "pr-validation", iterationKey: "pr_validation" }),
        );
      }
      expect(await store.isPrValidationCapped(ISSUE_ID)).toBe(false);
      // The Nth run reaches the cap → tripped.
      await store.recordSpecialistRun(
        specialistRun({ specialist: "pr-validation", iterationKey: "pr_validation" }),
      );
      const meta = await store.getIssueMetadata(ISSUE_ID);
      expect(meta!.prValidationIteration).toBe(PR_VALIDATION_ITERATION_CAP);
      expect(await store.isPrValidationCapped(ISSUE_ID)).toBe(true);
    });

    it("metadata is isolated per issueId", async () => {
      const store = makeStore();
      const other = "00000000-0000-0000-0000-000000000002";
      await store.recordSpecialistRun(specialistRun({ costUsdDelta: 2 }));
      await store.recordSpecialistRun(
        specialistRun({ issueId: other, issueIdentifier: "STG-TEST-2", costUsdDelta: 9 }),
      );
      expect((await store.getIssueMetadata(ISSUE_ID))!.costUsd).toBeCloseTo(2);
      expect((await store.getIssueMetadata(other))!.costUsd).toBeCloseTo(9);
    });

    describe("retry-accounting queries (over recorded audit history)", () => {
      // countAttemptsForIssue / lastFailedAtForIssue / getCostRollup read the
      // run_audit history. In the Postgres world that history is the
      // run_audit table; the MetadataStore exposes a way to record audit
      // history so these read queries have something to aggregate. We seed
      // via `recordRunAudit` — the store's own observable write path for
      // audit rows — rather than poking SQL.

      it("countAttemptsForIssue counts only non-Succeeded runs", async () => {
        const store = makeStore();
        await store.recordRunAudit(auditRow({ outcome: "Succeeded" }));
        await store.recordRunAudit(auditRow({ outcome: "Failed" }));
        await store.recordRunAudit(auditRow({ outcome: "TimedOut" }));
        await store.recordRunAudit(auditRow({ outcome: "CanceledByReconciliation" }));
        expect(await store.countAttemptsForIssue(ISSUE_ID)).toBe(3);
      });

      it("countAttemptsForIssue returns 0 for an issue with no history", async () => {
        const store = makeStore();
        expect(await store.countAttemptsForIssue("no-such-issue")).toBe(0);
      });

      it("lastFailedAtForIssue returns null when there is no prior failure", async () => {
        const store = makeStore();
        await store.recordRunAudit(auditRow({ outcome: "Succeeded" }));
        expect(await store.lastFailedAtForIssue(ISSUE_ID)).toBeNull();
      });

      it("lastFailedAtForIssue returns the most recent non-Succeeded finished_at", async () => {
        const store = makeStore();
        const older = new Date("2026-06-05T09:00:00Z");
        const newer = new Date("2026-06-05T11:00:00Z");
        await store.recordRunAudit(auditRow({ outcome: "Failed", finishedAt: older }));
        await store.recordRunAudit(auditRow({ outcome: "Failed", finishedAt: newer }));
        // A later Succeeded run must NOT shadow the failure anchor.
        await store.recordRunAudit(
          auditRow({ outcome: "Succeeded", finishedAt: new Date("2026-06-05T12:00:00Z") }),
        );
        const at = await store.lastFailedAtForIssue(ISSUE_ID);
        expect(at).not.toBeNull();
        expect(at!.getTime()).toBe(newer.getTime());
      });

      it("getCostRollup aggregates recorded runs per issue into the CostRollup shape", async () => {
        const store = makeStore();
        await store.recordRunAudit(
          auditRow({ issueIdentifier: "STG-A", costUsd: 2 }),
        );
        await store.recordRunAudit(
          auditRow({ issueIdentifier: "STG-A", costUsd: 3 }),
        );
        await store.recordRunAudit(
          auditRow({ issueIdentifier: "STG-B", costUsd: 1.5 }),
        );
        const rollup = await store.getCostRollup();
        expect(rollup).toHaveProperty("todayUsd");
        expect(rollup).toHaveProperty("monthUsd");
        expect(Array.isArray(rollup.byIssue)).toBe(true);
        const a = rollup.byIssue.find((r) => r.identifier === "STG-A");
        const b = rollup.byIssue.find((r) => r.identifier === "STG-B");
        expect(a).toBeDefined();
        expect(a!.totalUsd).toBeCloseTo(5);
        expect(a!.runs).toBe(2);
        expect(b!.totalUsd).toBeCloseTo(1.5);
        expect(b!.runs).toBe(1);
      });

      it("getCostRollup byIssue is sorted by total spend descending", async () => {
        const store = makeStore();
        await store.recordRunAudit(auditRow({ issueIdentifier: "LOW", costUsd: 1 }));
        await store.recordRunAudit(auditRow({ issueIdentifier: "HIGH", costUsd: 50 }));
        await store.recordRunAudit(auditRow({ issueIdentifier: "MID", costUsd: 10 }));
        const rollup = await store.getCostRollup();
        const idents = rollup.byIssue.map((r) => r.identifier);
        expect(idents.indexOf("HIGH")).toBeLessThan(idents.indexOf("MID"));
        expect(idents.indexOf("MID")).toBeLessThan(idents.indexOf("LOW"));
      });

      it("getCostRollup returns a zeroed rollup when nothing has been recorded", async () => {
        const store = makeStore();
        const rollup = await store.getCostRollup();
        expect(rollup.todayUsd).toBe(0);
        expect(rollup.monthUsd).toBe(0);
        expect(rollup.byIssue).toEqual([]);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// AuditSink contract
// ---------------------------------------------------------------------------

export function auditSinkContract(makeSink: () => AuditSink): void {
  describe("AuditSink contract", () => {
    it("writeRunAudit records a row that is then observable/queryable", async () => {
      const sink = makeSink();
      await sink.writeRunAudit(auditRow({ outcome: "Succeeded", costUsd: 1.25 }));
      const rows = await sink.listRunAudits();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("Succeeded");
      expect(rows[0]!.issueIdentifier).toBe(ISSUE_IDENT);
      expect(rows[0]!.costUsd).toBeCloseTo(1.25);
    });

    it("writeRunAudit appends — multiple rows accumulate in order", async () => {
      const sink = makeSink();
      await sink.writeRunAudit(auditRow({ attempt: 1 }));
      await sink.writeRunAudit(auditRow({ attempt: 2 }));
      const rows = await sink.listRunAudits();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
    });

    it("recordRunStart tracks a running row that recordRunEnd removes", async () => {
      const sink = makeSink();
      await sink.recordRunStart(runningRow());
      expect(await sink.listRunningRuns()).toHaveLength(1);
      await sink.recordRunEnd({ issueId: ISSUE_ID, instanceId: "rev-00020-abc" });
      expect(await sink.listRunningRuns()).toHaveLength(0);
    });

    it("recordRunStart upserts on (issueId, instanceId) — no duplicate running rows", async () => {
      const sink = makeSink();
      await sink.recordRunStart(runningRow({ attempt: 1, sessionId: "s1" }));
      await sink.recordRunStart(runningRow({ attempt: 2, sessionId: "s2" }));
      const running = await sink.listRunningRuns();
      expect(running).toHaveLength(1);
      expect(running[0]!.attempt).toBe(2);
      expect(running[0]!.sessionId).toBe("s2");
    });

    it("reapOrphanedRuns writes a synthetic Killed audit row for each dead-instance run and removes it", async () => {
      const sink = makeSink();
      await sink.recordRunStart(
        runningRow({ issueId: "ia", issueIdentifier: "AGENT-A", instanceId: "rev-old" }),
      );
      await sink.recordRunStart(
        runningRow({ issueId: "ib", issueIdentifier: "AGENT-B", instanceId: "rev-old" }),
      );
      const reaped = await sink.reapOrphanedRuns("rev-new");
      expect(reaped).toBe(2);

      // Running rows for the dead instance are gone.
      expect(await sink.listRunningRuns()).toHaveLength(0);

      // Two synthetic Killed audit rows landed, observable via the sink.
      const audits = await sink.listRunAudits();
      const killed = audits.filter((r) => r.outcome === "Killed");
      expect(killed).toHaveLength(2);
      expect(killed.every((r) => r.costUsd === 0)).toBe(true);
    });

    it("reapOrphanedRuns excludes the current instance — its runs are NOT reaped", async () => {
      const sink = makeSink();
      await sink.recordRunStart(runningRow({ instanceId: "rev-self" }));
      await sink.recordRunStart(
        runningRow({ issueId: "ic", issueIdentifier: "AGENT-C", instanceId: "rev-old" }),
      );
      const reaped = await sink.reapOrphanedRuns("rev-self");
      expect(reaped).toBe(1);
      // The current instance's running row survives.
      const survivors = await sink.listRunningRuns();
      expect(survivors).toHaveLength(1);
      expect(survivors[0]!.instanceId).toBe("rev-self");
    });

    it("reapOrphanedRuns is 0 when there are no dead-instance rows", async () => {
      const sink = makeSink();
      await sink.recordRunStart(runningRow({ instanceId: "rev-self" }));
      expect(await sink.reapOrphanedRuns("rev-self")).toBe(0);
    });
  });
}

// ---------------------------------------------------------------------------
// BudgetStore contract
// ---------------------------------------------------------------------------

export function budgetStoreContract(makeStore: () => BudgetStore): void {
  describe("BudgetStore contract", () => {
    const AT = new Date("2026-06-05T10:00:00Z");

    it("readBudget is 0 for an untouched scope", async () => {
      const store = makeStore();
      expect(await store.readBudget({ kind: "daily", key: "2026-06-05" }, AT)).toBe(0);
      expect(await store.readBudget({ kind: "issue", key: ISSUE_ID }, AT)).toBe(0);
    });

    it("incrementBudget accumulates and returns the running total", async () => {
      const store = makeStore();
      const scope = { kind: "issue" as const, key: ISSUE_ID };
      expect(await store.incrementBudget(scope, 1.5, AT)).toBeCloseTo(1.5);
      expect(await store.incrementBudget(scope, 2, AT)).toBeCloseTo(3.5);
      expect(await store.readBudget(scope, AT)).toBeCloseTo(3.5);
    });

    it("incrementBudget with a non-positive delta is a no-op that returns the current total", async () => {
      const store = makeStore();
      const scope = { kind: "issue" as const, key: ISSUE_ID };
      await store.incrementBudget(scope, 4, AT);
      expect(await store.incrementBudget(scope, 0, AT)).toBeCloseTo(4);
      expect(await store.incrementBudget(scope, -10, AT)).toBeCloseTo(4);
      expect(await store.readBudget(scope, AT)).toBeCloseTo(4);
    });

    it("daily and issue scopes are independent counters", async () => {
      const store = makeStore();
      await store.incrementBudget({ kind: "daily", key: "2026-06-05" }, 3, AT);
      await store.incrementBudget({ kind: "issue", key: ISSUE_ID }, 5, AT);
      expect(await store.readBudget({ kind: "daily", key: "2026-06-05" }, AT)).toBeCloseTo(3);
      expect(await store.readBudget({ kind: "issue", key: ISSUE_ID }, AT)).toBeCloseTo(5);
    });

    it("recordCost increments both daily and per-issue counters", async () => {
      const store = makeStore();
      const { dailyUsed, perIssueUsed } = await store.recordCost(ISSUE_ID, 2.5, AT);
      expect(dailyUsed).toBeCloseTo(2.5);
      expect(perIssueUsed).toBeCloseTo(2.5);
      // A second issue shares the daily counter but has its own per-issue one.
      const r2 = await store.recordCost("other-issue", 1, AT);
      expect(r2.dailyUsed).toBeCloseTo(3.5);
      expect(r2.perIssueUsed).toBeCloseTo(1);
    });

    describe("checkCaps", () => {
      const cfg: CostCapConfig = { dailyCapUsd: 10, perIssueCapUsd: 5 };

      it("allows when both counters are below their caps", async () => {
        const store = makeStore();
        await store.recordCost(ISSUE_ID, 4, AT);
        const decision = await store.checkCaps(cfg, ISSUE_ID, AT);
        expect(decision.allowed).toBe(true);
        expect(decision.perIssueUsed).toBeCloseTo(4);
      });

      it("denies once per-issue spend reaches the per-issue cap", async () => {
        const store = makeStore();
        await store.recordCost(ISSUE_ID, 5, AT); // == perIssueCapUsd
        const decision = await store.checkCaps(cfg, ISSUE_ID, AT);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toMatch(/per-issue/i);
        expect(decision.perIssueUsed).toBeCloseTo(5);
      });

      it("denies once daily spend reaches the daily cap (across issues)", async () => {
        const store = makeStore();
        // Spread across two issues so the per-issue cap is not the trigger.
        await store.recordCost("issue-a", 4, AT);
        await store.recordCost("issue-b", 4, AT);
        await store.recordCost("issue-c", 2, AT); // daily now == 10
        const decision = await store.checkCaps(cfg, "issue-c", AT);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toMatch(/daily/i);
        expect(decision.dailyUsed).toBeCloseTo(10);
      });

      it("a later checkCaps reflects spend accumulated by prior recordCost calls", async () => {
        const store = makeStore();
        // Just under the per-issue cap, then push it over the threshold.
        await store.recordCost(ISSUE_ID, 4.99, AT);
        expect((await store.checkCaps(cfg, ISSUE_ID, AT)).allowed).toBe(true);
        await store.recordCost(ISSUE_ID, 0.01, AT);
        expect((await store.checkCaps(cfg, ISSUE_ID, AT)).allowed).toBe(false);
      });

      it("a cap of 0 disables that dimension (no denial regardless of spend)", async () => {
        const store = makeStore();
        const disabled: CostCapConfig = { dailyCapUsd: 0, perIssueCapUsd: 0 };
        await store.recordCost(ISSUE_ID, 999, AT);
        expect((await store.checkCaps(disabled, ISSUE_ID, AT)).allowed).toBe(true);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Wire the contracts to the MEMORY impls (the only impl available now).
// The same `*Contract` functions are exported so the Postgres impls can be
// wired in an integration suite later.
// ---------------------------------------------------------------------------

describe("MemoryMetadataStore", () => {
  metadataStoreContract(() => new MemoryMetadataStore());
});

describe("MemoryAuditSink", () => {
  auditSinkContract(() => new MemoryAuditSink());
});

describe("MemoryBudgetStore", () => {
  budgetStoreContract(() => new MemoryBudgetStore());
});
