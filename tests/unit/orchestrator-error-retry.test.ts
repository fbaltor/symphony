import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { computeErrorBackoffMs, Orchestrator } from "../../src/orchestrator/orchestrator.js";
import type { OrchestratorDeps } from "../../src/orchestrator/orchestrator.js";
import type { SymphonyConfig } from "../../src/workflow/config.js";
import type { Issue } from "../../src/types.js";

/**
 * Coverage:
 *   1. `computeErrorBackoffMs` curve — pure-function exercise.
 *   2. `processErrorRetries` releases a parked issue back to active when
 *      the backoff has elapsed.
 *   3. `processErrorRetries` stops at `maxErrorRetries` and posts a
 *      "needs human review" Linear comment instead of moving the issue.
 *   4. `processErrorRetries` is idempotent: a second concurrent invocation
 *      does NOT double-fire the state transition while the first is in
 *      flight (the in-flight set guards the reconciler/loop interaction).
 */

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ABC-1",
    title: "t",
    description: null,
    priority: null,
    state: "Error",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeConfig(): SymphonyConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "test",
      teamId: "team-1",
      activeStates: ["Refinement", "Plan"],
      terminalStates: ["Done"],
      stateTransitions: {},
      announceDispatch: true,
      announceOutcome: true,
      errorStates: ["Error"],
      maxErrorRetries: 5,
      humanReviewStates: ["RFC", "Code Review"],
      prRequiredStates: ["Validate", "Implement"],
      noPrRetryLimit: 3,
    },
    polling: {
      intervalMs: 30_000,
      errorRetryIntervalMs: 300_000,
    },
    workspace: { root: "/tmp/test", gcIntervalMs: 600_000, gcMaxAgeMs: 3_600_000 },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 3,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
      writeCwdsByState: {},
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: "auto",
      threadSandbox: "unrestricted",
      turnSandboxPolicy: "unrestricted",
      turnTimeoutMs: 3_600_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 540_000,
    },
    guardrails: {
      dailyCapUsd: 250,
      perIssueCapUsd: 30,
      perStateCapUsd: {},
    },
    slack: { enabled: false, channelId: null },
    agentRuntime: { runtime: "claude" },
    github: { owner: "example-org", repo: "example-repo", branchPrefix: "symphony" },
  } satisfies SymphonyConfig;
}

interface FakeRow {
  outcome: string;
  finished_at: Date;
}

function makePool(rowsByIssue: Map<string, FakeRow[]>): pg.Pool {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    const issueId = (params?.[0] as string) ?? "";
    const rows = rowsByIssue.get(issueId) ?? [];
    if (sql.includes("COUNT(*)")) {
      const failed = rows.filter((r) => r.outcome !== "Succeeded");
      return { rows: [{ n: String(failed.length) }] };
    }
    if (sql.includes("ORDER BY finished_at DESC")) {
      const failed = rows
        .filter((r) => r.outcome !== "Succeeded")
        .sort((a, b) => b.finished_at.getTime() - a.finished_at.getTime());
      const top = failed[0];
      return { rows: top ? [{ finished_at: top.finished_at }] : [] };
    }
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

interface FakeDeps {
  deps: OrchestratorDeps;
  tracker: {
    fetchIssuesByStates: ReturnType<typeof vi.fn>;
    transitionIssueToState: ReturnType<typeof vi.fn>;
    createComment: ReturnType<typeof vi.fn>;
  };
  pool: pg.Pool;
}

function makeOrchestrator(opts: {
  parkedIssues: Issue[];
  rowsByIssue?: Map<string, FakeRow[]>;
  config?: SymphonyConfig;
}): { orch: Orchestrator; fakes: FakeDeps } {
  const config = opts.config ?? makeConfig();
  const watcherSnapshot = {
    config,
    raw: { promptTemplate: "stub", config: {} },
  };
  const watcher = {
    snapshot: () => watcherSnapshot,
    onChange: vi.fn().mockReturnValue(() => undefined),
  };

  const tracker = {
    fetchIssuesByStates: vi.fn(async () => opts.parkedIssues),
    transitionIssueToState: vi.fn(async (_id: string, state: string) => ({
      identifier: "ABC-1",
      state,
    })),
    createComment: vi.fn(async () => ({ id: "c1", url: "https://" })),
    fetchCandidateIssues: vi.fn(async () => []),
    fetchIssueStatesByIds: vi.fn(async () => []),
    fetchIssueComments: vi.fn(async () => []),
  };

  const runner = {
    kind: "claude",
    startSession: vi.fn(),
    runTurn: vi.fn(),
    endSession: vi.fn(),
  };

  const slack = {
    announceDispatch: vi.fn(async () => undefined),
    announceOutcome: vi.fn(async () => undefined),
  };

  const pool = makePool(opts.rowsByIssue ?? new Map());

  const deps = {
    watcher,
    tracker,
    runner,
    pool,
    slack,
  } as unknown as OrchestratorDeps;

  const orch = new Orchestrator(deps);
  return {
    orch,
    fakes: {
      deps,
      tracker: tracker as unknown as FakeDeps["tracker"],
      pool,
    },
  };
}

describe("computeErrorBackoffMs", () => {
  it("matches the documented curve at low attempt counts", () => {
    // Formula: min(60_000 * 2^attempts, 86_400_000).
    expect(computeErrorBackoffMs(0)).toBe(60_000); // 1 min
    expect(computeErrorBackoffMs(1)).toBe(120_000); // 2 min
    expect(computeErrorBackoffMs(2)).toBe(240_000); // 4 min
    expect(computeErrorBackoffMs(3)).toBe(480_000); // 8 min
    expect(computeErrorBackoffMs(4)).toBe(960_000); // 16 min
    expect(computeErrorBackoffMs(5)).toBe(1_920_000); // 32 min
  });

  it("caps at 24 hours for large attempt counts", () => {
    // 60_000 * 2^11 = 122_880_000ms > 86_400_000ms (24h).
    expect(computeErrorBackoffMs(11)).toBe(86_400_000);
    expect(computeErrorBackoffMs(50)).toBe(86_400_000);
    expect(computeErrorBackoffMs(1_000)).toBe(86_400_000);
  });

  it("handles fractional / negative inputs gracefully", () => {
    expect(computeErrorBackoffMs(-1)).toBe(60_000);
    expect(computeErrorBackoffMs(2.7)).toBe(240_000); // floors to 2
    expect(computeErrorBackoffMs(Number.NaN)).toBe(60_000);
  });
});

describe("Orchestrator.processErrorRetries", () => {
  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    nowSpy = null;
  });

  afterEach(() => {
    if (nowSpy) nowSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("releases a parked issue back to the first active state when the backoff has elapsed", async () => {
    const issue = makeIssue();
    // Two prior failures → backoff is 4 min. Last failure was 10 min ago,
    // so we're past the gate.
    const rows = new Map<string, FakeRow[]>([
      [
        issue.id,
        [
          { outcome: "Failed", finished_at: new Date(Date.now() - 20 * 60_000) },
          { outcome: "Failed", finished_at: new Date(Date.now() - 10 * 60_000) },
        ],
      ],
    ]);
    const { orch, fakes } = makeOrchestrator({ parkedIssues: [issue], rowsByIssue: rows });
    await orch.processErrorRetries();
    expect(fakes.tracker.transitionIssueToState).toHaveBeenCalledTimes(1);
    expect(fakes.tracker.transitionIssueToState).toHaveBeenCalledWith(issue.id, "Refinement");
    expect(fakes.tracker.createComment).not.toHaveBeenCalled();
  });

  it("does NOT release while still inside the backoff window", async () => {
    const issue = makeIssue();
    // 5 attempts → 32 min backoff. Last failure was only 1 min ago.
    const failures: FakeRow[] = Array.from({ length: 5 }, (_, i) => ({
      outcome: "Failed",
      finished_at: new Date(Date.now() - (5 - i) * 60_000),
    }));
    const rows = new Map<string, FakeRow[]>([[issue.id, failures]]);
    const { orch, fakes } = makeOrchestrator({ parkedIssues: [issue], rowsByIssue: rows });
    await orch.processErrorRetries();
    expect(fakes.tracker.transitionIssueToState).not.toHaveBeenCalled();
    expect(fakes.tracker.createComment).not.toHaveBeenCalled();
  });

  it("stops at maxErrorRetries and posts a needs-human-review Linear comment", async () => {
    const issue = makeIssue();
    // 6 failures > maxErrorRetries (5) → exhausted budget.
    const failures: FakeRow[] = Array.from({ length: 6 }, (_, i) => ({
      outcome: "Failed",
      finished_at: new Date(Date.now() - (6 - i) * 24 * 60 * 60_000),
    }));
    const rows = new Map<string, FakeRow[]>([[issue.id, failures]]);
    const { orch, fakes } = makeOrchestrator({ parkedIssues: [issue], rowsByIssue: rows });
    await orch.processErrorRetries();
    expect(fakes.tracker.transitionIssueToState).not.toHaveBeenCalled();
    expect(fakes.tracker.createComment).toHaveBeenCalledTimes(1);
    const [issueIdArg, body] = fakes.tracker.createComment.mock.calls[0] as [string, string];
    expect(issueIdArg).toBe(issue.id);
    expect(body).toContain("auto-retry budget exhausted");
    expect(body).toContain("6 attempts");
    expect(body).toContain("symphony:event=auto_retry_exhausted");
  });

  it("does not double-fire when invoked concurrently for the same issue", async () => {
    const issue = makeIssue();
    const rows = new Map<string, FakeRow[]>([[issue.id, []]]);
    const { orch, fakes } = makeOrchestrator({ parkedIssues: [issue], rowsByIssue: rows });

    // Hold the Linear transition until the second invocation has had a
    // chance to run; resolved once we've confirmed it short-circuited.
    let resolveTransition: (value: { identifier: string; state: string }) => void = () => undefined;
    let transitionPromise: Promise<{ identifier: string; state: string }> | null = null;
    fakes.tracker.transitionIssueToState.mockImplementationOnce(() => {
      transitionPromise = new Promise<{ identifier: string; state: string }>((resolve) => {
        resolveTransition = resolve;
      });
      return transitionPromise;
    });

    const first = orch.processErrorRetries();
    // Spin event loop until the first call has reached the slow transition.
    for (let i = 0; i < 20 && transitionPromise === null; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(transitionPromise).not.toBeNull();
    expect(fakes.tracker.transitionIssueToState).toHaveBeenCalledTimes(1);

    // Second invocation should see the issue in the in-flight set and
    // short-circuit BEFORE issuing another Linear transition.
    const second = orch.processErrorRetries();
    await second;
    expect(fakes.tracker.transitionIssueToState).toHaveBeenCalledTimes(1);

    // Let the first call finish.
    resolveTransition({ identifier: issue.identifier, state: "Refinement" });
    await first;
    expect(fakes.tracker.transitionIssueToState).toHaveBeenCalledTimes(1);
  });

  it("skips when stop() has been called", async () => {
    const issue = makeIssue();
    const { orch, fakes } = makeOrchestrator({ parkedIssues: [issue] });
    await orch.stop();
    await orch.processErrorRetries();
    expect(fakes.tracker.fetchIssuesByStates).not.toHaveBeenCalled();
    expect(fakes.tracker.transitionIssueToState).not.toHaveBeenCalled();
  });
});
