/**
 * Unit tests for the PR validation specialist.
 *
 * Two flavors:
 *
 *   1. Pure / no-DB tests assert SYSTEM_PROMPT + buildUserMessage shape.
 *      These run unconditionally — they're the "this prompt module exports
 *      what the orchestrator expects" guard.
 *
 *   2. Live-Postgres tests exercise `run(ctx)` end-to-end against the
 *      `symphony.issue_metadata` table. They run only when `DATABASE_URL`
 *      is set (matches the `tests/unit/issue-metadata.test.ts` convention).
 */

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import prValidation from "../../src/agents/pr-validation/index.js";
import {
  SYSTEM_PROMPT,
  buildUserMessage,
} from "../../src/agents/pr-validation/prompt.js";
import {
  PR_VALIDATION_ITERATION_CAP,
  ensureIssueMetadataRow,
  getIssueMetadata,
} from "../../src/audit/issue-metadata.js";
import type { SpecialistContext } from "../../src/agents/types.js";
import type { MetadataStore } from "../../src/audit/store.js";
import { PostgresMetadataStore } from "../../src/audit/store-postgres.js";
import type { Issue } from "../../src/types.js";

// -----------------------------------------------------------------------------
// Pure / no-DB tests
// -----------------------------------------------------------------------------

describe("pr-validation specialist — prompt + module shape", () => {
  it("SYSTEM_PROMPT is non-empty and identifies the agent", () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT).toContain("PR validation");
  });

  it("SYSTEM_PROMPT mentions iteration cap = 5", () => {
    // The cap literal `5` must appear AND the named constant value must
    // match. Both checks together guard against accidental drift.
    expect(SYSTEM_PROMPT).toMatch(/\b5\b/);
    expect(PR_VALIDATION_ITERATION_CAP).toBe(5);
  });

  it("SYSTEM_PROMPT mentions the gh tools the agent will use", () => {
    expect(SYSTEM_PROMPT).toContain("gh run list");
    expect(SYSTEM_PROMPT).toContain("gh api");
  });

  it("SYSTEM_PROMPT documents the bounce vs. advance vs. escalate decision tree", () => {
    expect(SYSTEM_PROMPT).toContain("Release");
    expect(SYSTEM_PROMPT).toContain("Pull request");
    expect(SYSTEM_PROMPT).toContain("Error (manual)");
  });

  it("Specialist.name is 'pr-validation'", () => {
    expect(prValidation.name).toBe("pr-validation");
  });

  it("Specialist.state is 'PR validation'", () => {
    expect(prValidation.state).toBe("PR validation");
  });

  it("Specialist.promptVersion is a non-empty string", () => {
    // getPromptVersion() falls back to "dev" when no env is set.
    expect(prValidation.promptVersion).toBeTypeOf("string");
    expect(prValidation.promptVersion.length).toBeGreaterThan(0);
  });

  describe("buildUserMessage(ctx)", () => {
    /** Minimal SpecialistContext shape that buildUserMessage cares about. */
    function makeCtx(overrides: {
      identifier?: string;
      title?: string;
      description?: string | null;
      url?: string | null;
      stashedIter?: number | null;
    }): SpecialistContext {
      const issue: Issue = {
        id: "00000000-0000-0000-0000-000000000001",
        identifier: overrides.identifier ?? "PROJ-999",
        title: overrides.title ?? "Test ticket",
        description: overrides.description ?? null,
        priority: 2,
        state: "PR validation",
        branchName: null,
        url: overrides.url ?? "https://linear.app/test/issue/PROJ-999",
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      };
      const ctx: SpecialistContext = {
        issue,
        comments: [],
        // store / tracker are unused by buildUserMessage; cast to keep TS happy.
        store: {} as unknown as MetadataStore,
        tracker: {} as unknown as SpecialistContext["tracker"],
        workspacePath: "/tmp/test-workspace",
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        abortController: new AbortController(),
      };
      if (overrides.stashedIter !== undefined && overrides.stashedIter !== null) {
        (ctx as unknown as { __prValidationIteration: number }).__prValidationIteration =
          overrides.stashedIter;
      }
      return ctx;
    }

    it("includes the issue identifier in the header", () => {
      const msg = buildUserMessage(makeCtx({ identifier: "PROJ-555" }));
      expect(msg).toContain("PROJ-555");
    });

    it("echoes Scope and Exit criteria sections when present", () => {
      const description = [
        "## Scope",
        "",
        "Refactor the badge component.",
        "",
        "## Exit criteria",
        "",
        "All existing badge snapshots pass.",
      ].join("\n");
      const msg = buildUserMessage(makeCtx({ description }));
      expect(msg).toContain("Refactor the badge component.");
      expect(msg).toContain("All existing badge snapshots pass.");
    });

    it("flags missing sections with a placeholder rather than crashing", () => {
      const msg = buildUserMessage(makeCtx({ description: "(no sections at all)" }));
      // Body should still render — just with a guidance placeholder so the
      // agent knows to bounce/escalate instead of silently doing nothing.
      expect(msg).toContain("no `## Scope` section");
      expect(msg).toContain("no `## Exit criteria` section");
    });

    it("includes the stashed iteration counter (current attempt = stashed + 1)", () => {
      const msg = buildUserMessage(makeCtx({ stashedIter: 2 }));
      expect(msg).toContain("Current iteration (this turn): 3");
    });

    it("includes the workspace path so the agent knows where to run gh", () => {
      const msg = buildUserMessage(makeCtx({}));
      expect(msg).toContain("/tmp/test-workspace");
    });

    it("repeats the iteration cap so the agent can't miss it", () => {
      const msg = buildUserMessage(makeCtx({}));
      // The user message restates the cap so a long context window doesn't
      // dilute the system prompt's cap rule. Check both the literal 5 and
      // the escalation-state-name appear.
      expect(msg).toMatch(/Iteration cap: 5/);
      expect(msg).toContain("Error (manual)");
    });
  });
});

// -----------------------------------------------------------------------------
// Live-Postgres tests for run()
// -----------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SUITE = DATABASE_URL ? describe : describe.skip;

SUITE("pr-validation specialist — run() against live Postgres", () => {
  let pool: pg.Pool;
  // Keep the test issue ID unique-per-process to avoid cross-run interference.
  const TEST_ISSUE_ID = `00000000-0000-0000-0000-${Date.now().toString().padStart(12, "0")}`;
  const TEST_ISSUE_IDENT = `STG-PRVAL-${Date.now()}`;

  /** Build a SpecialistContext sufficient for run() — pool is the only thing it actually uses. */
  function makeCtx(): SpecialistContext {
    const issue: Issue = {
      id: TEST_ISSUE_ID,
      identifier: TEST_ISSUE_IDENT,
      title: "Test PR validation",
      description: [
        "## Scope",
        "",
        "Stub scope.",
        "",
        "## Exit criteria",
        "",
        "Stub exit.",
      ].join("\n"),
      priority: null,
      state: "PR validation",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    };
    return {
      issue,
      comments: [],
      store: new PostgresMetadataStore(pool),
      tracker: {} as unknown as SpecialistContext["tracker"],
      workspacePath: "/tmp/test-workspace",
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      abortController: new AbortController(),
    };
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, [
      TEST_ISSUE_ID,
    ]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, [
      TEST_ISSUE_ID,
    ]);
  });

  it("on a fresh issue: bumps pr_validation_iteration to 1 and returns Succeeded", async () => {
    const result = await prValidation.run(makeCtx());
    expect(result.outcome).toBe("Succeeded");
    expect(result.nextStateOverride).toBeUndefined();

    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta).not.toBeNull();
    expect(meta!.prValidationIteration).toBe(1);
    expect(meta!.lastSpecialist).toBe("pr-validation");
  });

  it("at the cap: returns Escalated + nextStateOverride = 'Error (manual)' and writes error_state", async () => {
    // Pre-seed the row at the cap.
    await ensureIssueMetadataRow(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
    });
    await pool.query(
      `UPDATE symphony.issue_metadata
         SET pr_validation_iteration = $1
       WHERE issue_id = $2`,
      [PR_VALIDATION_ITERATION_CAP, TEST_ISSUE_ID],
    );

    const result = await prValidation.run(makeCtx());
    expect(result.outcome).toBe("Escalated");
    expect(result.nextStateOverride).toBe("Error (manual)");
    expect(result.error).toMatch(/iteration cap/i);
    expect(result.comment).toBeTruthy();

    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.errorState).toBe("PR validation");
    // Counter must NOT bump on the capped path — a capped issue stays at 5.
    expect(meta!.prValidationIteration).toBe(PR_VALIDATION_ITERATION_CAP);
  });
});
