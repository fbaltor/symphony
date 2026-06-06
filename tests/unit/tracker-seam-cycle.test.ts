import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator, type OrchestratorDeps } from "../../src/orchestrator/orchestrator.js";
import { MemoryTracker } from "../../src/tracker/memory.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";
import type { Issue } from "../../src/types.js";
import type { SymphonyConfig } from "../../src/workflow/config.js";
import type { WorkflowSnapshot, WorkflowWatcher } from "../../src/workflow/watch.js";
import type {
  AgentRunner,
  AgentSessionHandle,
  RunTurnResult,
} from "../../src/agent/runner.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { SlackObserver } from "../../src/observability/slack.js";

/**
 * Phase A — tracker seam. A full poll→dispatch→transition→reconcile cycle
 * driven entirely by an in-memory `IssueTracker` (`MemoryTracker`), with NO
 * Linear.
 *
 * The seam under test: `OrchestratorDeps.tracker` is typed as `IssueTracker`
 * (not the concrete `LinearTrackerClient`), so a `MemoryTracker` plugs in and
 * the orchestrator's poll loop runs end-to-end. These tests assert the
 * orchestrator's OBSERVABLE effects through the tracker — dispatch counts and
 * state advances — rather than internal bookkeeping.
 *
 * Two distinct dispatch behaviors are exercised, and the tests are careful NOT
 * to conflate them (the original conflation is what this rework fixes):
 *
 *   - AUTO-ADVANCE (no dispatch): a NON-specialist active state with a
 *     configured `state_transitions` edge (e.g. `Active → Done`) is
 *     auto-advanced in one tick WITHOUT dispatching an agent — this is the
 *     orchestrator's free fast path. The seam is still exercised: the candidate
 *     read and the transition write-back both flow through the
 *     `IssueTracker`-typed `MemoryTracker`. (behavior 1)
 *
 *   - DISPATCH: a SPECIALIST-owned active state (e.g. `Prioritized`) is the
 *     dispatchable case. The auto-advance fast path is gated on `!hasSpecialist`
 *     and the cascade-only skip is gated on `!hasSpecialist && !hasTransition`,
 *     so ONLY specialist states fall through to `dispatch()` and drive an agent
 *     turn through the injected `AgentRunner`. We give the specialist state a
 *     SELF-LOOP edge (`Prioritized → Prioritized`) so the post-turn auto-advance
 *     is a no-op and the issue stays put — letting us assert dispatch counts
 *     without the state racing forward. (behaviors 2, 3, 4)
 */

/* --------------------------- config + fixtures --------------------------- */

function makeConfig(overrides?: {
  tracker?: Partial<SymphonyConfig["tracker"]>;
  agent?: Partial<SymphonyConfig["agent"]>;
  workspaceRoot?: string;
}): SymphonyConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "lin_test",
      teamId: "team-1",
      activeStates: ["Active"],
      terminalStates: ["Done", "Canceled"],
      humanReviewStates: [],
      stateTransitions: { Active: "Done" },
      announceDispatch: false,
      announceOutcome: false,
      prRequiredStates: [],
      noPrRetryLimit: 3,
      errorStates: ["Error"],
      maxErrorRetries: 5,
      ...overrides?.tracker,
    },
    polling: { intervalMs: 30_000, errorRetryIntervalMs: 300_000 },
    workspace: { root: overrides?.workspaceRoot ?? "/tmp/test-symphony-cycle" },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 1,
      maxRetryBackoffMs: 60_000,
      maxConcurrentAgentsByState: {},
      writeCwdsByState: {},
      ...overrides?.agent,
    },
    codex: {
      command: "codex",
      approvalPolicy: "auto",
      threadSandbox: "unrestricted",
      turnSandboxPolicy: "unrestricted",
      turnTimeoutMs: 60_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 60_000,
    },
    guardrails: { dailyCapUsd: 0, perIssueCapUsd: 0, perStateCapUsd: {} },
    slack: { enabled: false, channelId: null },
    agentRuntime: { runtime: "claude", model: null },
    github: { owner: "acme", repo: "widgets" },
  } as unknown as SymphonyConfig;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "MEM-1",
    title: overrides.title ?? "Cycle issue",
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? "Active",
    branchName: null,
    url: null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? "2026-06-01T00:00:00Z",
    updatedAt: null,
  };
}

/** Fake pool: every query resolves to an empty result set. The orchestrator's
 *  guardrail / kill-switch / budget / audit reads all degrade gracefully to
 *  "no rows" → caps inactive, kill-switch disengaged, budget 0. */
function makeFakePool(): OrchestratorDeps["pool"] {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as OrchestratorDeps["pool"];
}

function makeSlack(): SlackObserver {
  return {
    announceDispatch: vi.fn(async () => undefined),
    announceOutcome: vi.fn(async () => undefined),
    announceRejection: vi.fn(async () => undefined),
  } as unknown as SlackObserver;
}

const FINAL_EVENT: AgentEvent = {
  event: "turn_completed",
  timestamp: Date.now(),
  pid: null,
  message: "done",
};

function runResult(outcome: RunTurnResult["outcome"]): RunTurnResult {
  return {
    outcome,
    finalEvent: FINAL_EVENT,
    usageDelta: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}

/**
 * Controllable fake AgentRunner. `startSession` increments a dispatch
 * counter so bullet 2 can assert the exact number of dispatches in one tick.
 * `runTurn` returns the configured outcome. When `gate` is supplied, the
 * turn blocks on it — used by bullet 3 to keep a worker in-flight while the
 * reconciler runs.
 */
function makeRunner(opts?: {
  outcome?: RunTurnResult["outcome"];
  turnGate?: Promise<void>;
}): AgentRunner & {
  startCalls: number;
  startedIssues: string[];
} {
  const runner = {
    kind: "fake",
    startCalls: 0,
    startedIssues: [] as string[],
    startSession: vi.fn(async (args: { issue: Issue }): Promise<AgentSessionHandle> => {
      runner.startCalls += 1;
      runner.startedIssues.push(args.issue.id);
      return {
        sessionId: `sess-${runner.startCalls}`,
        threadId: `thread-${runner.startCalls}`,
        pid: null,
        workspacePath: "/tmp/ws",
        events: (async function* () {})(),
      };
    }),
    runTurn: vi.fn(async (): Promise<RunTurnResult> => {
      if (opts?.turnGate) await opts.turnGate;
      return runResult(opts?.outcome ?? "completed");
    }),
    endSession: vi.fn(async () => undefined),
  };
  return runner as unknown as AgentRunner & { startCalls: number; startedIssues: string[] };
}

function makeWatcher(config: SymphonyConfig): WorkflowWatcher {
  const snapshot: WorkflowSnapshot = {
    raw: { config: {} as Record<string, unknown>, promptTemplate: "PROMPT {{ issue.identifier }}" },
    config,
    loadedAt: Date.now(),
  };
  return {
    snapshot: () => snapshot,
    onChange: () => () => undefined,
  } as unknown as WorkflowWatcher;
}

interface Harness {
  orchestrator: Orchestrator;
  tracker: MemoryTracker;
  runner: AgentRunner & { startCalls: number; startedIssues: string[] };
}

function makeHarness(args: {
  config: SymphonyConfig;
  seed: Issue[];
  runner?: AgentRunner & { startCalls: number; startedIssues: string[] };
}): Harness {
  const tracker = new MemoryTracker(args.seed);
  const runner = args.runner ?? makeRunner();
  const deps: OrchestratorDeps = {
    watcher: makeWatcher(args.config),
    // The seam: assigning a MemoryTracker (typed IssueTracker) to the
    // tracker dep must type-check. Today the dep is LinearTrackerClient,
    // so this line is a compile error until the seam lands.
    tracker: tracker as IssueTracker,
    runner,
    pool: makeFakePool(),
    slack: makeSlack(),
  };
  const orchestrator = new Orchestrator(deps);
  return { orchestrator, tracker, runner };
}

/** Drive exactly one poll tick (the private poll loop). */
async function pollOnce(orchestrator: Orchestrator): Promise<void> {
  await (orchestrator as unknown as { tick: () => Promise<void> }).tick();
}

/** Wait until every in-flight worker promise has settled (post-finally I/O
 *  included), or time out. The orchestrator tracks these in a private set. */
async function drainWorkers(orchestrator: Orchestrator): Promise<void> {
  const set = (orchestrator as unknown as { workerPromises: Set<Promise<void>> }).workerPromises;
  const running = (orchestrator as unknown as { state: { running: Map<string, unknown> } }).state
    .running;
  for (let i = 0; i < 200; i++) {
    if (set.size === 0 && running.size === 0) return;
    await Promise.race([
      Promise.allSettled([...set]),
      new Promise((r) => setTimeout(r, 5)),
    ]);
  }
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "symphony-seam-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/* ------------------------------ behavior 1 ----------------------------- */

describe("behavior 1: a non-specialist FORWARD-transition state auto-advances WITHOUT dispatching", () => {
  it("advances Active → Done in one tick and dispatches NO agent", async () => {
    // `Active` has no owning specialist and a FORWARD edge
    // (`state_transitions["Active"] = "Done"`), so the orchestrator's
    // auto-advance fast path fires the transition directly and skips dispatch.
    const config = makeConfig({ workspaceRoot: tmpRoot });
    const { orchestrator, tracker, runner } = makeHarness({
      config,
      seed: [makeIssue({ id: "a", identifier: "MEM-1", state: "Active" })],
    });

    await pollOnce(orchestrator);
    await drainWorkers(orchestrator);
    await orchestrator.stop();

    // No dispatch: the auto-advance is free — no agent turn was started.
    expect(runner.startCalls).toBe(0);
    expect(runner.startedIssues).toEqual([]);

    // Advanced to the configured next state, written back through the
    // IssueTracker-typed MemoryTracker.
    const [after] = await tracker.fetchIssueStatesByIds(["a"]);
    expect(after?.state).toBe("Done");
  });

  it("does NOT advance (and does NOT dispatch) a non-specialist state with NO forward edge", async () => {
    // Falsifiable counterpart: a non-specialist active state with an EMPTY
    // state_transitions map is cascade-only — there's no edge to advance along
    // and no specialist to dispatch, so the issue must stay put and the runner
    // must stay idle. If the auto-advance path were over-eager (advancing on a
    // missing edge) or the dispatch path were over-eager (dispatching a
    // cascade-only state), this assertion would fail.
    const config = makeConfig({
      workspaceRoot: tmpRoot,
      tracker: { activeStates: ["Active"], stateTransitions: {} },
    });
    const { orchestrator, tracker, runner } = makeHarness({
      config,
      seed: [makeIssue({ id: "a", identifier: "MEM-1", state: "Active" })],
    });

    await pollOnce(orchestrator);
    await drainWorkers(orchestrator);
    await orchestrator.stop();

    expect(runner.startCalls).toBe(0);
    const [after] = await tracker.fetchIssueStatesByIds(["a"]);
    expect(after?.state).toBe("Active");
  });
});

/* ------------------------- behaviors 2 & 3 ----------------------------- */

/**
 * Config for the DISPATCH behaviors. `Prioritized` is a SPECIALIST-owned state
 * (so it is NOT eligible for the free auto-advance fast path, which is gated on
 * `!hasSpecialist`). Its SELF-LOOP edge (`state_transitions["Prioritized"] =
 * "Prioritized"`) makes the post-turn auto-advance a no-op, so a dispatched
 * issue stays `Prioritized` and we can assert dispatch counts cleanly.
 */
const DISPATCH_STATE = "Prioritized";

function makeDispatchConfig(overrides?: {
  workspaceRoot?: string;
  agent?: Partial<SymphonyConfig["agent"]>;
}): SymphonyConfig {
  return makeConfig({
    workspaceRoot: overrides?.workspaceRoot,
    tracker: { activeStates: [DISPATCH_STATE], stateTransitions: { [DISPATCH_STATE]: DISPATCH_STATE } },
    agent: overrides?.agent,
  });
}

describe("behavior 2: a specialist-owned dispatchable state dispatches an agent and stays put", () => {
  it("dispatches the single eligible issue and leaves it in its state (self-loop, no forward advance)", async () => {
    const config = makeDispatchConfig({ workspaceRoot: tmpRoot });
    const { orchestrator, tracker, runner } = makeHarness({
      config,
      seed: [makeIssue({ id: "a", identifier: "MEM-1", state: DISPATCH_STATE })],
    });

    await pollOnce(orchestrator);
    await drainWorkers(orchestrator);
    await orchestrator.stop();

    // Dispatched exactly once via the injected runner.
    expect(runner.startCalls).toBe(1);
    expect(runner.startedIssues).toEqual(["a"]);

    // The self-loop transition (Prioritized → Prioritized) is a no-op move —
    // the issue is still Prioritized, never advanced past its state.
    const [after] = await tracker.fetchIssueStatesByIds(["a"]);
    expect(after?.state).toBe(DISPATCH_STATE);
  });
});

describe("behavior 3: concurrency cap bounds dispatch per tick", () => {
  it("dispatches exactly N when there are N+1 eligible issues and the limit is N", async () => {
    const N = 2;
    const config = makeDispatchConfig({
      workspaceRoot: tmpRoot,
      agent: { maxConcurrentAgents: N, maxTurns: 1, maxRetryBackoffMs: 60_000, maxConcurrentAgentsByState: {} },
    });
    // Block the turn so the N workers stay occupied for the duration of the
    // single tick — otherwise a fast worker would free its slot and the tick
    // could dispatch the remainder too.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner = makeRunner({ turnGate: gate });
    const { orchestrator, runner: r } = makeHarness({
      config,
      seed: [
        makeIssue({ id: "a", identifier: "MEM-1", state: DISPATCH_STATE, priority: 1 }),
        makeIssue({ id: "b", identifier: "MEM-2", state: DISPATCH_STATE, priority: 2 }),
        makeIssue({ id: "c", identifier: "MEM-3", state: DISPATCH_STATE, priority: 3 }),
      ],
      runner,
    });

    await pollOnce(orchestrator);

    // Exactly N dispatched in this tick; the (N+1)th stayed queued.
    expect(r.startCalls).toBe(N);

    release();
    await drainWorkers(orchestrator);
    await orchestrator.stop();
  });

  it("leaves the remainder queued (still active) after the capped tick", async () => {
    const N = 1;
    const config = makeDispatchConfig({
      workspaceRoot: tmpRoot,
      agent: { maxConcurrentAgents: N, maxTurns: 1, maxRetryBackoffMs: 60_000, maxConcurrentAgentsByState: {} },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner = makeRunner({ turnGate: gate });
    const { orchestrator, tracker, runner: r } = makeHarness({
      config,
      seed: [
        makeIssue({ id: "a", identifier: "MEM-1", state: DISPATCH_STATE, priority: 1 }),
        makeIssue({ id: "b", identifier: "MEM-2", state: DISPATCH_STATE, priority: 2 }),
      ],
      runner,
    });

    await pollOnce(orchestrator);
    expect(r.startCalls).toBe(N);

    // The undispatched issue remains in its active state, still pollable.
    const stillActive = await tracker.fetchCandidateIssues([DISPATCH_STATE]);
    const queuedIds = stillActive.map((i: Issue) => i.id);
    expect(queuedIds).toContain("b");

    release();
    await drainWorkers(orchestrator);
    await orchestrator.stop();
  });
});

/* ------------------------------ behavior 4 ----------------------------- */

describe("behavior 4: reconciliation cancels an in-flight run whose issue went ineligible", () => {
  it("cancels the worker and does not re-dispatch when the issue moved to a terminal state mid-flight", async () => {
    // Dispatch behavior, so the specialist-owned self-loop state keeps a real
    // worker in-flight (the auto-advance fast path would never dispatch one).
    const config = makeDispatchConfig({ workspaceRoot: tmpRoot });
    // Keep the worker in-flight across reconcile by gating its turn.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner = makeRunner({ turnGate: gate });
    const { orchestrator, tracker, runner: r } = makeHarness({
      config,
      seed: [makeIssue({ id: "a", identifier: "MEM-1", state: DISPATCH_STATE })],
      runner,
    });

    // Tick 1: dispatch the issue; its worker blocks on the gate (in-flight).
    await pollOnce(orchestrator);
    expect(r.startCalls).toBe(1);

    // Out-of-band, the issue moves to an ineligible (terminal) state — as if
    // a human dragged it to Done while the agent was mid-turn.
    await tracker.transitionIssueToState("a", "Done");

    // Tick 2: reconciliation runs first; it must observe the terminal state
    // and cancel the in-flight worker (abort()).
    await pollOnce(orchestrator);

    // Cancellation tore down the session.
    expect(r.endSession).toHaveBeenCalled();

    release();
    await drainWorkers(orchestrator);

    // Tick 3: the issue is terminal, so it must NOT be re-dispatched.
    const before = r.startCalls;
    await pollOnce(orchestrator);
    await drainWorkers(orchestrator);
    await orchestrator.stop();

    expect(r.startCalls).toBe(before);
  });
});
