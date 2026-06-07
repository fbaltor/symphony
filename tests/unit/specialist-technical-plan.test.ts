/**
 * Technical plan specialist — unit tests.
 *
 * Covers prompt-builder shape (the contract the orchestrator + AGENTS.md
 * autonomy gate keys off), Specialist interface bindings, and — when
 * DATABASE_URL is set — the live-Postgres path that bumps the plan_iteration
 * counter. No real LLM calls.
 */

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getIssueMetadata } from "../../src/audit/issue-metadata.js";
import technicalPlanSpecialist, {
  SYSTEM_PROMPT,
  buildUserMessage,
} from "../../src/agents/technical-plan/index.js";
import type { SpecialistContext } from "../../src/agents/types.js";
import type { MetadataStore } from "../../src/audit/store.js";
import { PostgresMetadataStore } from "../../src/audit/store-postgres.js";
import type { LinearTrackerClient as LinearTracker } from "../../src/tracker/linear.js";
import type { Issue } from "../../src/types.js";

/** A minimal description that has Goals / Context / Questions populated. */
const PARENT_DESCRIPTION = [
  "Original human request: charge column on the contract detail page.",
  "",
  "## Goals",
  "",
  "- Show a Charge column on the contract detail table.",
  "- Scope analytics revenue to non-deleted contracts.",
  "",
  "## Context",
  "",
  "Lives in `apps/frontend/legal-admin/src/contracts/detail.tsx`. Existing analytics queries don't filter `deletedAt`.",
  "",
  "## Questions",
  "",
  "1. Should the column show gross or net?",
  "2. Should the analytics filter ripple into the dashboard widget too?",
  "",
].join("\n");

/** Build a synthetic SpecialistContext for prompt-builder tests. */
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-uuid-001",
    identifier: "PROJ-7",
    title: "Charge column on contract detail",
    description: PARENT_DESCRIPTION,
    priority: 2,
    state: "Technical plan",
    branchName: null,
    url: "https://linear.app/example-org/issue/PROJ-7",
    labels: [],
    blockedBy: [],
    createdAt: "2026-05-01T10:00:00Z",
    updatedAt: "2026-05-06T15:00:00Z",
    ...overrides,
  };
}

function makeContext(overrides: Partial<SpecialistContext> = {}): SpecialistContext {
  // The store / tracker are only consulted by run(); prompt-builder tests don't
  // touch them. Cast through unknown so the test fixtures stay shallow.
  const fakeStore = {} as unknown as MetadataStore;
  const fakeTracker = {} as unknown as LinearTracker;
  const noopLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  return {
    issue: makeIssue(),
    comments: [],
    store: fakeStore,
    tracker: fakeTracker,
    workspacePath: "/tmp/symphony/workspaces/stg-7",
    logger: noopLogger,
    abortController: new AbortController(),
    ...overrides,
  };
}

describe("technical-plan specialist — module shape", () => {
  it("exports a Specialist with name=technical-plan and state=Technical plan", () => {
    expect(technicalPlanSpecialist.name).toBe("technical-plan");
    expect(technicalPlanSpecialist.state).toBe("Technical plan");
  });

  it("exposes a non-empty promptVersion", () => {
    expect(typeof technicalPlanSpecialist.promptVersion).toBe("string");
    expect(technicalPlanSpecialist.promptVersion.length).toBeGreaterThan(0);
  });

  it("re-exports SYSTEM_PROMPT identical to systemPrompt on the default export", () => {
    expect(technicalPlanSpecialist.systemPrompt).toBe(SYSTEM_PROMPT);
  });
});

describe("technical-plan SYSTEM_PROMPT", () => {
  it("is a non-empty string and identifies the specialist", () => {
    expect(typeof SYSTEM_PROMPT).toBe("string");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(200);
    expect(SYSTEM_PROMPT).toContain("Technical plan specialist");
  });

  it("names every one of the 7 managed sub-issue sections", () => {
    // The autonomy gate (AGENTS.md "Symphony-driven prompts") and downstream
    // PR validation key off these exact heading strings — drift here breaks
    // the whole pipeline.
    expect(SYSTEM_PROMPT).toContain("## Scope");
    expect(SYSTEM_PROMPT).toContain("## Files to change");
    expect(SYSTEM_PROMPT).toContain("## Implementation steps");
    expect(SYSTEM_PROMPT).toContain("## Tests to pass");
    expect(SYSTEM_PROMPT).toContain("## Branch");
    expect(SYSTEM_PROMPT).toContain("## PR title + body");
    expect(SYSTEM_PROMPT).toContain("## Exit criteria");
  });

  it("documents the symphony/<sub-linear-id-lowercased> branch convention", () => {
    // The branch must use the SUB's identifier, not the parent's.
    expect(SYSTEM_PROMPT).toContain("symphony/<sub-linear-id-lowercased>");
    // And explicitly calls out the lowercase rule.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("lowercased");
  });

  it("warns the agent NOT to use the parent's identifier in branch / PR title / Closes", () => {
    // Guards the 2026-05-07 cutover bug. The Technical plan agent had written
    // `Closes PROJ-5` (parent) into a sub's PR template, which made Linear
    // auto-move the wrong issue when the PR landed. The prompt must
    // explicitly surface the SUB-vs-parent distinction and the
    // SUB-LINEAR-ID convention for branch / title / Closes.
    expect(SYSTEM_PROMPT).toContain("[<SUB-LINEAR-ID>]");
    // The "DO NOT use the parent's identifier" warning must appear verbatim.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain(
      "do not use the parent's identifier",
    );
  });

  it("documents the re-plan idempotency rule (keep / create / archive)", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("re-plan");
    expect(SYSTEM_PROMPT).toMatch(/archive/i);
    // Specialists must not delete sub-issues on re-plan.
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("never delete");
  });

  it("forbids opening PRs and transitioning the parent state", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("file write access");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("transition the parent");
  });

  it("references the Closes <SUB-LINEAR-ID> / PR template requirement", () => {
    // The Closes line must use the SUB's identifier so Linear's GitHub
    // integration moves the SUB to Pull request when the PR opens.
    expect(SYSTEM_PROMPT).toContain("Closes <SUB-LINEAR-ID>");
    expect(SYSTEM_PROMPT).toContain("PULL_REQUEST_TEMPLATE.md");
  });
});

describe("technical-plan buildUserMessage", () => {
  it("includes the issue identifier and title in the header", () => {
    const msg = buildUserMessage(makeContext());
    expect(msg).toContain("PROJ-7");
    expect(msg).toContain("Charge column on contract detail");
  });

  it("extracts the parent's Goals / Context / Questions sections", () => {
    const msg = buildUserMessage(makeContext());
    expect(msg).toContain("Charge column on the contract detail table");
    expect(msg).toContain("apps/frontend/legal-admin/src/contracts/detail.tsx");
    expect(msg).toContain("Should the column show gross or net?");
  });

  it("surfaces a graceful placeholder when Goals is missing", () => {
    const ctx = makeContext({
      issue: makeIssue({ description: "Just a one-liner with no managed sections." }),
    });
    const msg = buildUserMessage(ctx);
    expect(msg).toContain("no Goals section found");
  });

  it("renders human-answer comments oldest-first", () => {
    const comments = [
      { author: "alice", createdAt: "2026-05-06T10:00:00Z", body: "Net, please." },
      { author: "bob", createdAt: "2026-05-06T11:00:00Z", body: "And yes, ripple to the dashboard." },
    ];
    const msg = buildUserMessage(makeContext({ comments }));
    expect(msg).toContain("Net, please.");
    expect(msg).toContain("ripple to the dashboard");
    // Order check: alice's body must appear before bob's.
    expect(msg.indexOf("Net, please.")).toBeLessThan(msg.indexOf("ripple to the dashboard"));
  });

  it("notes the absence of comments on a first-plan path with no answers yet", () => {
    const msg = buildUserMessage(makeContext({ comments: [] }));
    expect(msg).toContain("no substantive comments");
  });

  it("lists existing sub-issues on the re-plan path", () => {
    const ctx = {
      ...makeContext(),
      existingSubs: [
        {
          identifier: "PROJ-8",
          title: "Add Charge column UI",
          scope: "Render the column in the table; no analytics changes here.",
        },
        {
          identifier: "PROJ-9",
          title: "Filter analytics by deletedAt",
          scope: "Backend-only; ignore the dashboard widget.",
        },
      ],
    };
    const msg = buildUserMessage(ctx);
    expect(msg).toContain("re-plan path");
    expect(msg).toContain("PROJ-8");
    expect(msg).toContain("PROJ-9");
    expect(msg).toContain("Render the column in the table");
    expect(msg).toContain("Filter analytics by deletedAt");
  });

  it("points the agent at the cloned monorepo workspace and AGENTS.md", () => {
    const msg = buildUserMessage(makeContext());
    expect(msg).toContain("/tmp/symphony/workspaces/stg-7");
    expect(msg).toContain("AGENTS.md");
    expect(msg).toContain("docs/adr/");
  });
});

// ---------------------------------------------------------------------------
// Live-Postgres coverage for run() — gated on DATABASE_URL like the rest of
// the suite (see tests/unit/issue-metadata.test.ts for the same pattern).
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const LIVE_SUITE = DATABASE_URL ? describe : describe.skip;

LIVE_SUITE("technical-plan run() (live Postgres)", () => {
  let pool: pg.Pool;
  const TEST_ISSUE_ID = `00000000-0000-0000-0000-${Date.now().toString().padStart(12, "0")}`;
  const TEST_IDENT = `STG-PLAN-${Date.now()}`;

  // The Cloud SQL proxy can take a few seconds to wake up on cold connections;
  // use the same generous hookTimeout the rest of Symphony's live-DB tests
  // implicitly rely on.
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(`SELECT 1`);
  }, 30_000);

  afterAll(async () => {
    await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, [TEST_ISSUE_ID]);
    await pool.end();
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, [TEST_ISSUE_ID]);
  }, 30_000);

  it("bumps plan_iteration and returns Succeeded with zero cost", async () => {
    const ctx: SpecialistContext = {
      issue: makeIssue({ id: TEST_ISSUE_ID, identifier: TEST_IDENT }),
      comments: [],
      store: new PostgresMetadataStore(pool),
      tracker: {} as unknown as LinearTracker,
      workspacePath: "/tmp/test-workspace",
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      abortController: new AbortController(),
    };

    const result = await technicalPlanSpecialist.run(ctx);

    expect(result.outcome).toBe("Succeeded");
    expect(result.costUsd).toBe(0);
    expect(result.tokens.total).toBe(0);
    expect(result.error).toBeNull();

    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta).not.toBeNull();
    expect(meta!.planIteration).toBe(1);
    expect(meta!.lastSpecialist).toBe("technical-plan");
  });

  it("plan_iteration increments across multiple run() calls", async () => {
    const ctx: SpecialistContext = {
      issue: makeIssue({ id: TEST_ISSUE_ID, identifier: TEST_IDENT }),
      comments: [],
      store: new PostgresMetadataStore(pool),
      tracker: {} as unknown as LinearTracker,
      workspacePath: "/tmp/test-workspace",
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      abortController: new AbortController(),
    };

    await technicalPlanSpecialist.run(ctx);
    await technicalPlanSpecialist.run(ctx);

    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.planIteration).toBe(2);
    // No other counters should be touched by technical-plan.
    expect(meta!.validationIteration).toBe(0);
    expect(meta!.prValidationIteration).toBe(0);
  });
});
