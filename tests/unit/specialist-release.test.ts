/**
 * Unit tests for the Release specialist.
 *
 * Two halves:
 *   1. Pure-function tests — SYSTEM_PROMPT shape + buildUserMessage output.
 *      Run unconditionally; no DB needed.
 *   2. Live-Postgres test — runs the stubbed `run()` against a real DB and
 *      verifies the cost+last_specialist write side-effect. Skipped when
 *      DATABASE_URL is unset (matches the issue-metadata.test.ts pattern).
 */

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import releaseSpecialist, {
  RELEASE_SPECIALIST_NAME,
  RELEASE_STATE,
} from "../../src/agents/release/index.js";
import {
  SYSTEM_PROMPT,
  buildUserMessage,
} from "../../src/agents/release/prompt.js";
import type { SpecialistContext } from "../../src/agents/types.js";
import type { MetadataStore } from "../../src/audit/store.js";
import { PostgresMetadataStore } from "../../src/audit/store-postgres.js";
import type { LinearTrackerClient as LinearTracker } from "../../src/tracker/linear.js";
import type { Issue } from "../../src/types.js";

// ---------- Fixtures ----------

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-id-fixture",
    identifier: "STG-TEST-1",
    title: "Add a charge column to the contract detail",
    description: null,
    priority: 1,
    state: "Release",
    branchName: "stg/charge-column",
    url: "https://linear.app/example-org/issue/PROJ-TEST-1",
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<SpecialistContext> = {},
  extra?: Record<string, unknown>,
): SpecialistContext {
  const noop = () => {};
  const ctx: SpecialistContext & { extra?: Record<string, unknown> } = {
    issue: overrides.issue ?? makeIssue(),
    comments: overrides.comments ?? [],
    store: (overrides.store ?? null) as unknown as MetadataStore,
    tracker: (overrides.tracker ?? null) as unknown as LinearTracker,
    workspacePath: overrides.workspacePath ?? "/tmp/symphony-workspace/STG-TEST-1",
    logger: overrides.logger ?? {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    },
    abortController: overrides.abortController ?? new AbortController(),
  };
  if (extra) ctx.extra = extra;
  return ctx;
}

// ---------- Pure-function tests ----------

describe("Release specialist — SYSTEM_PROMPT", () => {
  it("is non-empty and identifies the agent as Release", () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(500);
    expect(SYSTEM_PROMPT).toContain("Symphony's Release specialist");
  });

  it("documents the squash-merge incantation with --delete-branch", () => {
    // The command itself must appear verbatim — both flags matter.
    expect(SYSTEM_PROMPT).toContain("gh pr merge --squash --delete-branch");
  });

  it("explicitly forbids auto-revert", () => {
    // Two related guards — the agent must not take recovery actions on red main.
    expect(SYSTEM_PROMPT).toContain("No auto-revert");
    expect(SYSTEM_PROMPT).toContain("Do NOT call");
    expect(SYSTEM_PROMPT).toContain("gh pr revert");
  });

  it("describes both output sections (Release report + Error)", () => {
    expect(SYSTEM_PROMPT).toContain("## Release report");
    expect(SYSTEM_PROMPT).toContain("## Error");
  });
});

describe("Release specialist — buildUserMessage", () => {
  it("includes the issue identifier and title in the header", () => {
    const ctx = makeCtx({ issue: makeIssue({ identifier: "PROJ-77", title: "Cool change" }) });
    const msg = buildUserMessage(ctx);
    expect(msg).toContain("# Release turn for PROJ-77 — Cool change");
  });

  it("instructs the agent to look up the PR via `Closes <identifier>` search", () => {
    const ctx = makeCtx({ issue: makeIssue({ identifier: "PROJ-99" }) });
    const msg = buildUserMessage(ctx);
    expect(msg).toContain('gh pr list --search "Closes PROJ-99"');
  });

  it("echoes cumulative cost when seeded via ctx.extra", () => {
    const ctx = makeCtx({}, { cumulativeCostUsd: 12.5 });
    const msg = buildUserMessage(ctx);
    expect(msg).toContain("Cumulative cost so far: $12.50");
  });

  it("renders an honest placeholder when cost is unknown", () => {
    const ctx = makeCtx();
    const msg = buildUserMessage(ctx);
    expect(msg).toContain("Cumulative cost so far: (unknown");
  });

  it("reminds the agent to NOT auto-revert in the footer", () => {
    const ctx = makeCtx();
    const msg = buildUserMessage(ctx);
    expect(msg).toContain("DO NOT call `gh pr revert`");
  });
});

describe("Release specialist — module shape", () => {
  it("exposes the canonical name + state", () => {
    expect(releaseSpecialist.name).toBe("release");
    expect(releaseSpecialist.state).toBe("Release");
    // Constants are also exported for orchestrator-side registry wiring.
    expect(RELEASE_SPECIALIST_NAME).toBe("release");
    expect(RELEASE_STATE).toBe("Release");
  });

  it("exposes a non-empty systemPrompt + a callable buildUserMessage", () => {
    expect(releaseSpecialist.systemPrompt.length).toBeGreaterThan(0);
    expect(typeof releaseSpecialist.buildUserMessage).toBe("function");
    expect(typeof releaseSpecialist.run).toBe("function");
  });
});

// ---------- Live-Postgres test (skipped without DATABASE_URL) ----------

const DATABASE_URL = process.env.DATABASE_URL;
const LIVE_SUITE = DATABASE_URL ? describe : describe.skip;

LIVE_SUITE("Release specialist — run() (live Postgres)", () => {
  let pool: pg.Pool;
  const TEST_ISSUE_ID = `00000000-0000-0000-0000-${Date.now().toString().padStart(12, "0")}`;
  const TEST_ISSUE_IDENT = `STG-RELEASE-${Date.now()}`;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, [TEST_ISSUE_ID]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, [TEST_ISSUE_ID]);
  });

  it("records last_specialist=release without bumping any iteration counter or cost", async () => {
    // Pre-seed: issue already has $5 of cumulative cost from prior specialists,
    // and a couple of iteration counters set. Release.run() (stub) should
    // record itself as last_specialist with a $0 cost delta and NOT touch any
    // of the iteration counters.
    await pool.query(
      `INSERT INTO symphony.issue_metadata (
         issue_id, issue_identifier, validation_iteration, plan_iteration,
         pr_validation_iteration, cost_usd, last_specialist
       ) VALUES ($1, $2, 1, 1, 1, 5, 'pr-validation')`,
      [TEST_ISSUE_ID, TEST_ISSUE_IDENT],
    );

    const ctx = makeCtx({
      issue: makeIssue({ id: TEST_ISSUE_ID, identifier: TEST_ISSUE_IDENT }),
      store: new PostgresMetadataStore(pool),
    });

    const result = await releaseSpecialist.run(ctx);

    // Stub returns Succeeded with all-zero counters and no override.
    expect(result.outcome).toBe("Succeeded");
    expect(result.costUsd).toBe(0);
    expect(result.tokens.total).toBe(0);
    expect(result.nextStateOverride ?? null).toBeNull();
    expect(result.error).toBeNull();

    // Side effect: last_specialist flipped, cost unchanged, counters unchanged.
    const row = await pool.query(
      `SELECT validation_iteration, plan_iteration, pr_validation_iteration,
              cost_usd, last_specialist
         FROM symphony.issue_metadata WHERE issue_id = $1`,
      [TEST_ISSUE_ID],
    );
    expect(row.rows[0].last_specialist).toBe("release");
    expect(Number(row.rows[0].cost_usd)).toBeCloseTo(5);
    expect(row.rows[0].validation_iteration).toBe(1);
    expect(row.rows[0].plan_iteration).toBe(1);
    expect(row.rows[0].pr_validation_iteration).toBe(1);
  });
});
