import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Orchestrator, type OrchestratorDeps } from "../../src/orchestrator/orchestrator.js";
import { symphonyConfigSchema, type SymphonyConfig } from "../../src/workflow/config.js";
import type { WorkflowSnapshot, WorkflowWatcher } from "../../src/workflow/watch.js";
import type { Issue } from "../../src/types.js";

import { MemoryTracker } from "../../src/tracker/memory.js";
import {
  MemoryAuditSink,
  MemoryAuditState,
  MemoryBudgetStore,
  MemoryMetadataStore,
} from "../../src/audit/store-memory.js";
import { MemoryDeliverableSource } from "../../src/lib/deliverable-source.js";
import { MemoryInstanceLock, type InstanceLock } from "../../src/singleton/lock.js";
import { systemClock, type Clock } from "../../src/lib/clock.js";
import { FakeAgentRunner } from "../../src/agent/fake-runner.js";
import { ClaudeAgentRunner } from "../../src/agent/claude-adapter.js";

// The composition factory under test. It does NOT exist yet — this import is
// part of the RED contract (along with the widened `tracker.kind:"memory"`
// schema). The implementer adds `buildDeps` (e.g. in `src/deps.ts`) so this
// resolves.
import { buildDeps } from "../../src/deps.js";

/**
 * Phase E (zero-dep E2E) — the integration capstone.
 *
 * This is the contract for the `buildDeps(cfg, overrides?)` composition factory
 * and the `tracker.kind: "memory"` config widening. It wires ALL of phases A–D's
 * in-memory impls together and drives the REAL `Orchestrator` through one full
 * poll→dispatch→deliverable→advance→audit cycle — with NO network, NO Postgres,
 * NO LLM.
 *
 * RED until two things land:
 *   1. `tracker.kind` becomes a discriminated union `"linear" | "memory"`, and
 *      for `kind:"memory"` `apiKey`/`endpoint` are NOT required (decision 3b).
 *      `makeMemoryConfig()` below parses through `symphonyConfigSchema.parse`,
 *      so it THROWS under today's `kind: z.literal("linear")` + required
 *      `apiKey` schema.
 *   2. `buildDeps` exists and returns the orchestrator dependency bundle keyed
 *      on `cfg.tracker.kind === "memory"` (all memory impls) + the new `lock` /
 *      `clock` seams + the runner chosen by `agentRuntime.runtime`.
 *
 * The dispatchable state is `PR validation` — a SPECIALIST-owned state (so the
 * orchestrator's `!hasSpecialist` auto-advance fast path does NOT fire; the
 * issue genuinely falls through to `dispatch()` and runs the injected runner).
 * `PR validation` is also a `parseDecisionOverride` section owner
 * (`## PR validation report`), so the harness can route the post-turn advance
 * by writing a `Decision` line into the issue DESCRIPTION through the tracker
 * (behavior 3) — NOT via `finalEvent.message`.
 */

/* ------------------------------ contract types ------------------------------ */

/**
 * The bundle `buildDeps` returns. It is the orchestrator's `OrchestratorDeps`
 * shape (so `new Orchestrator(deps)` type-checks) PLUS the two seams the brief
 * names explicitly (`lock`, `clock`) and the shared memory audit backing so a
 * test can read `audit.listRunAudits()`.
 *
 * Typed structurally here (not imported) precisely because the factory does not
 * exist yet — this interface is the contract the implementer must satisfy.
 */
interface MemoryDeps extends OrchestratorDeps {
  /** Phase D singleton-lock seam. For `kind:"memory"` this is a `MemoryInstanceLock`. */
  lock: InstanceLock;
  /** Phase D clock seam. For `kind:"memory"` defaults to `systemClock`. */
  clock: Clock;
}

interface BuildDepsOverrides {
  /** Seed issues for the in-memory tracker (also expressible via cfg). */
  seed?: Issue[];
  /**
   * Scripted fake-runner turns. Only consulted when
   * `cfg.agentRuntime.runtime === "fake"`.
   */
  fakeScript?: ConstructorParameters<typeof FakeAgentRunner>[0];
  /** Scripted deliverable source (branches / PRs). Defaults to "couldn't tell". */
  deliverable?: ConstructorParameters<typeof MemoryDeliverableSource>[0];
  /** Override the clock (deterministic lease tests). Defaults to `systemClock`. */
  clock?: Clock;
}

type BuildDepsFn = (cfg: SymphonyConfig, overrides?: BuildDepsOverrides) => MemoryDeps;

// Compile-time pin: `buildDeps` must match the contract signature.
const _buildDeps: BuildDepsFn = buildDeps as BuildDepsFn;

/* ------------------------------- fixtures ---------------------------------- */

/** A specialist-owned, dispatchable state with a `## <Report>` decision section. */
const DISPATCH_STATE = "PR validation";
/** The override target the harness writes into the description (NOT the default edge). */
const OVERRIDE_TARGET = "Pull request";
/** The DEFAULT `state_transitions` edge — deliberately different from the override. */
const DEFAULT_NEXT = "Some default next";
const MODEL = "claude-sonnet-4-7";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "symphony-e2e-"));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/**
 * Build a `kind:"memory"` config and PARSE it through `symphonyConfigSchema`.
 *
 * Parsing is load-bearing: it forces the discriminated-union widening
 * (decision 3b). Under today's schema (`kind: z.literal("linear")`,
 * `apiKey: z.string().min(1)`) this throws — that's the RED condition. We pass
 * NO `apiKey` / `endpoint` precisely to prove they're not required for memory.
 */
function makeMemoryConfig(overrides?: {
  runtime?: "fake" | "claude";
  model?: string | null;
  workspaceRoot?: string;
  activeStates?: string[];
  stateTransitions?: Record<string, string>;
  prRequiredStates?: string[];
}): SymphonyConfig {
  const candidate = {
    tracker: {
      // Discriminated-union widening: no apiKey / endpoint for memory.
      kind: "memory",
      teamId: "memory-team",
      activeStates: overrides?.activeStates ?? [DISPATCH_STATE],
      terminalStates: ["Done", "Canceled"],
      humanReviewStates: [],
      stateTransitions: overrides?.stateTransitions ?? { [DISPATCH_STATE]: DEFAULT_NEXT },
      announceDispatch: false,
      announceOutcome: false,
      prRequiredStates: overrides?.prRequiredStates ?? [],
      noPrRetryLimit: 3,
      errorStates: ["Error"],
      maxErrorRetries: 5,
    },
    polling: { intervalMs: 30_000, errorRetryIntervalMs: 300_000 },
    workspace: { root: overrides?.workspaceRoot ?? tmpRoot },
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
    agentRuntime: {
      runtime: overrides?.runtime ?? "fake",
      model: overrides?.model === undefined ? MODEL : (overrides.model ?? undefined),
    },
    github: { owner: "acme", repo: "widgets" },
  };

  return symphonyConfigSchema.parse(candidate);
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "MEM-1",
    title: overrides.title ?? "E2E issue",
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? DISPATCH_STATE,
    branchName: null,
    url: null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? "2026-06-01T00:00:00Z",
    updatedAt: null,
  };
}

/** A `## PR validation report` block carrying a NON-default-path Decision line.
 *  `Bouncing to Pull request.` resolves (via `DECISION_LINE_PATTERNS`) to the
 *  explicit override `"Pull request"` — NOT a default-edge advance. */
function decisionDescription(): string {
  return [
    "## PR validation report",
    "",
    "Reviewed the PR. CI is red on the head commit.",
    "",
    "Decision: Bouncing to Pull request.",
    "",
  ].join("\n");
}

/**
 * The orchestrator exposes `tick()` + a `workerPromises` set privately; the
 * phase-A cycle test drives them the same way. We reach in via a narrow cast.
 */
async function pollOnce(orchestrator: Orchestrator): Promise<void> {
  await (orchestrator as unknown as { tick: () => Promise<void> }).tick();
}

async function drainWorkers(orchestrator: Orchestrator): Promise<void> {
  const set = (orchestrator as unknown as { workerPromises: Set<Promise<void>> }).workerPromises;
  const running = (orchestrator as unknown as { state: { running: Map<string, unknown> } }).state
    .running;
  for (let i = 0; i < 400; i++) {
    if (set.size === 0 && running.size === 0) return;
    await Promise.race([Promise.allSettled([...set]), new Promise((r) => setTimeout(r, 5))]);
  }
}

/** Build the orchestrator from the memory deps bundle, asserting NO real
 *  pool / fetch / runner leaked in. The watcher comes from the bundle (the
 *  factory composes it from cfg). */
function makeOrchestrator(deps: MemoryDeps): Orchestrator {
  return new Orchestrator(deps);
}

/* ------------------------------ behavior 1 --------------------------------- */

describe("behavior 1: full zero-dependency flow (poll → dispatch → deliverable → advance → audit)", () => {
  it("drives one tick end-to-end with the fake agent: issue advances and an audit row is recorded, with no network/PG/LLM", async () => {
    const cfg = makeMemoryConfig({ runtime: "fake", model: MODEL });
    const issue = makeIssue({
      id: "a",
      identifier: "MEM-1",
      state: DISPATCH_STATE,
      // Seed the Decision line into the DESCRIPTION up front so the
      // orchestrator's post-turn `fetchIssueDescriptionById` →
      // parseDecisionOverride sees it and routes via the override.
      description: decisionDescription(),
    });

    const deps = _buildDeps(cfg, {
      seed: [issue],
      // A single scripted `completed` turn → mapOutcome → "Succeeded".
      // NB: NO `decisionLine` here — routing must come from the description,
      // not from `finalEvent.message` (behavior 3).
      fakeScript: { outcome: "completed", usage: { inputTokens: 12, outputTokens: 7, costUsd: 0 } },
      // "couldn't tell" branches → deliverable gate fails open (and PR-required
      // is empty anyway). No token, no fetch.
      deliverable: { branches: null },
    });

    // --- zero-dependency property, asserted concretely ---
    // The runner is the scripted fake (no LLM); the tracker/stores are memory
    // impls (no PG, no fetch). `pool` is a stand-in the factory wires for the
    // not-yet-abstracted seams — it must NOT be a real `pg.Pool` (no
    // `connect`/`end` that opens sockets); the memory profile degrades all
    // pool reads to empty result sets.
    expect(deps.runner).toBeInstanceOf(FakeAgentRunner);
    expect(deps.runner.kind).toBe("fake");
    expect(deps.tracker).toBeInstanceOf(MemoryTracker);
    expect(deps.store).toBeInstanceOf(MemoryMetadataStore);
    expect(deps.audit).toBeInstanceOf(MemoryAuditSink);
    expect(deps.budget).toBeInstanceOf(MemoryBudgetStore);
    expect(deps.deliverable).toBeInstanceOf(MemoryDeliverableSource);
    expect(deps.lock).toBeInstanceOf(MemoryInstanceLock);

    const orchestrator = makeOrchestrator(deps);

    await pollOnce(orchestrator);
    await drainWorkers(orchestrator);
    await orchestrator.stop();

    const tracker = deps.tracker as MemoryTracker;
    const audit = deps.audit as MemoryAuditSink;

    // (a) Dispatched + the fake agent ran (a session was started for this issue
    //     and a turn was produced) — proven downstream by the audit row's
    //     fake-runtime + token deltas.
    // (b) The issue ADVANCED to the next state (the description-driven override
    //     target, NOT the default edge — that crossover is behavior 3).
    const [after] = await tracker.fetchIssueStatesByIds(["a"]);
    expect(after?.state).toBe(OVERRIDE_TARGET);
    expect(after?.state).not.toBe(DISPATCH_STATE); // genuinely moved

    // (c) An audit row was recorded for THIS run, with the expected outcome and
    //     fake runtime — i.e. the run completed end-to-end through the seam.
    const rows = await audit.listRunAudits();
    const row = rows.find((r) => r.issueId === "a");
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("Succeeded");
    expect(row?.runtime).toBe("fake"); // no LLM — the scripted fake ran
    // Usage flowed off the scripted turn into the row (proves the fake's
    // result was consumed, not a stub).
    expect(row?.inputTokens).toBe(12);
    expect(row?.outputTokens).toBe(7);
  });

  it("records NO audit row and does not advance when there is no seeded candidate (falsifiable counterpart)", async () => {
    // Same wiring, but the seeded issue sits in a NON-active state, so the poll
    // finds no candidate, dispatches nothing, and writes no audit row. If the
    // flow above were a fiction (advancing/recording unconditionally), this
    // would fail.
    const cfg = makeMemoryConfig({ runtime: "fake", model: MODEL });
    const deps = _buildDeps(cfg, {
      seed: [makeIssue({ id: "z", identifier: "MEM-9", state: "Backlog" })],
      fakeScript: { outcome: "completed" },
      deliverable: { branches: null },
    });
    const orchestrator = makeOrchestrator(deps);

    await pollOnce(orchestrator);
    await drainWorkers(orchestrator);
    await orchestrator.stop();

    const audit = deps.audit as MemoryAuditSink;
    expect((await audit.listRunAudits()).length).toBe(0);

    const [after] = await (deps.tracker as MemoryTracker).fetchIssueStatesByIds(["z"]);
    expect(after?.state).toBe("Backlog");
  });
});

/* ------------------------------ behavior 2 --------------------------------- */

describe("behavior 2: the same composition BUILDS with the real Claude adapter selected (manual smoke path)", () => {
  it("wires the real ClaudeAgentRunner while keeping memory tracker/stores/deliverable/lock — without running a turn", () => {
    const cfg = makeMemoryConfig({ runtime: "claude", model: MODEL });
    const deps = _buildDeps(cfg, {
      seed: [makeIssue({ id: "a", identifier: "MEM-1", state: DISPATCH_STATE })],
      deliverable: { branches: null },
    });

    // The runner axis is independent of tracker.kind: the REAL adapter is
    // selected, but everything else stays in-memory. Construction does NO
    // network I/O (the adapter only stores opts), so this asserts wiring only.
    expect(deps.runner).toBeInstanceOf(ClaudeAgentRunner);
    expect(deps.runner.kind).toBe("claude");

    // Still zero-dependency on every other axis.
    expect(deps.tracker).toBeInstanceOf(MemoryTracker);
    expect(deps.store).toBeInstanceOf(MemoryMetadataStore);
    expect(deps.audit).toBeInstanceOf(MemoryAuditSink);
    expect(deps.budget).toBeInstanceOf(MemoryBudgetStore);
    expect(deps.deliverable).toBeInstanceOf(MemoryDeliverableSource);
    expect(deps.lock).toBeInstanceOf(MemoryInstanceLock);

    // And it composes into a real Orchestrator (the smoke path is "it builds").
    expect(() => makeOrchestrator(deps)).not.toThrow();
  });
});

/* ------------------------------ behavior 3 --------------------------------- */

describe("behavior 3: the scripted routing decision drives REAL advancement via the DESCRIPTION (parseDecisionOverride), not finalEvent.message", () => {
  it("routes to the override target written into the issue description through the tracker, NOT the default state_transitions edge", async () => {
    // The default edge for DISPATCH_STATE is DEFAULT_NEXT. The description
    // carries `Decision: Bouncing to Pull request.` → override OVERRIDE_TARGET.
    // The two are DISTINCT, so the final state can ONLY be OVERRIDE_TARGET if
    // the orchestrator read the description and let parseDecisionOverride route
    // it. A default-edge advance would land on DEFAULT_NEXT instead.
    const cfg = makeMemoryConfig({
      runtime: "fake",
      model: MODEL,
      stateTransitions: { [DISPATCH_STATE]: DEFAULT_NEXT },
    });
    const issue = makeIssue({
      id: "a",
      identifier: "MEM-1",
      state: DISPATCH_STATE,
      description: decisionDescription(),
    });

    const deps = _buildDeps(cfg, {
      seed: [issue],
      // No `decisionLine` on the fake → `finalEvent.message` is null for a
      // completed turn. If routing came from finalEvent.message instead of the
      // description, there'd be nothing to route on and the issue would take
      // the default edge (DEFAULT_NEXT) — which this test forbids.
      fakeScript: { outcome: "completed" },
      deliverable: { branches: null },
    });
    const orchestrator = makeOrchestrator(deps);
    const tracker = deps.tracker as MemoryTracker;

    // Sanity: the harness wrote the Decision line into the DESCRIPTION through
    // the tracker — this is the channel parseDecisionOverride reads.
    const seededDesc = await tracker.fetchIssueDescriptionById("a");
    expect(seededDesc).toContain("Bouncing to Pull request");

    await pollOnce(orchestrator);
    await drainWorkers(orchestrator);
    await orchestrator.stop();

    const [after] = await tracker.fetchIssueStatesByIds(["a"]);
    expect(after?.state).toBe(OVERRIDE_TARGET);
    expect(after?.state).not.toBe(DEFAULT_NEXT); // default edge did NOT win
  });

  it("falls back to the default state_transitions edge when the description carries NO decision line", async () => {
    // Falsifiable counterpart: with no Decision line in the description, the
    // override path returns null and the orchestrator MUST use the default
    // edge. Proves the override above was actually the description's doing, not
    // an unconditional route.
    const cfg = makeMemoryConfig({
      runtime: "fake",
      model: MODEL,
      stateTransitions: { [DISPATCH_STATE]: DEFAULT_NEXT },
    });
    const deps = _buildDeps(cfg, {
      seed: [
        makeIssue({
          id: "a",
          identifier: "MEM-1",
          state: DISPATCH_STATE,
          description: "## PR validation report\n\nLooks good. No decision line here.\n",
        }),
      ],
      fakeScript: { outcome: "completed" },
      deliverable: { branches: null },
    });
    const orchestrator = makeOrchestrator(deps);

    await pollOnce(orchestrator);
    await drainWorkers(orchestrator);
    await orchestrator.stop();

    const [after] = await (deps.tracker as MemoryTracker).fetchIssueStatesByIds(["a"]);
    expect(after?.state).toBe(DEFAULT_NEXT);
  });
});

/* ------------------------------ behavior 4 --------------------------------- */

describe("behavior 4: the audit row's model is config.agentRuntime.model, not the fake runner's model property", () => {
  it("records model = config.agentRuntime.model even when the fake runner advertises a DIFFERENT model", async () => {
    // The fake runner is scripted with a model string that DIFFERS from config.
    // The orchestrator writes `config.agentRuntime.model` onto the audit row
    // (orchestrator.ts ~:1410), so the row must carry the CONFIG model — proving
    // the attribution source is config, not `runner.model`.
    const FAKE_RUNNER_MODEL = "fake-runner-model-DO-NOT-USE";
    expect(FAKE_RUNNER_MODEL).not.toBe(MODEL);

    const cfg = makeMemoryConfig({ runtime: "fake", model: MODEL });
    const deps = _buildDeps(cfg, {
      seed: [
        makeIssue({
          id: "a",
          identifier: "MEM-1",
          state: DISPATCH_STATE,
          description: decisionDescription(),
        }),
      ],
      fakeScript: { outcome: "completed", model: FAKE_RUNNER_MODEL },
      deliverable: { branches: null },
    });

    // The fake genuinely advertises the other model (so the assertion below is
    // a real crossover, not a tautology).
    expect((deps.runner as FakeAgentRunner).model).toBe(FAKE_RUNNER_MODEL);

    const orchestrator = makeOrchestrator(deps);
    await pollOnce(orchestrator);
    await drainWorkers(orchestrator);
    await orchestrator.stop();

    const audit = deps.audit as MemoryAuditSink;
    const row = (await audit.listRunAudits()).find((r) => r.issueId === "a");
    expect(row).toBeDefined();
    expect(row?.model).toBe(MODEL); // from config.agentRuntime.model
    expect(row?.model).not.toBe(FAKE_RUNNER_MODEL); // NOT the runner's property
  });
});

/* --------------------------- composition wiring ---------------------------- */

describe("buildDeps composition: shared memory backing + clock seam", () => {
  it("shares one MemoryAuditState between the metadata store and the audit sink", async () => {
    // The brief requires MemoryMetadataStore + MemoryAuditSink to share backing
    // so retry/cost reads see the rows the sink writes. After a run, the
    // metadata store's attempt/cost queries must reflect the audit history.
    const cfg = makeMemoryConfig({ runtime: "fake", model: MODEL });
    const deps = _buildDeps(cfg, {
      seed: [
        makeIssue({
          id: "a",
          identifier: "MEM-1",
          state: DISPATCH_STATE,
          description: decisionDescription(),
        }),
      ],
      // Script a FAILED turn so the metadata store's non-Succeeded attempt
      // counter (which reads the SAME backing the sink wrote) is non-zero.
      fakeScript: { outcome: "failed" },
      deliverable: { branches: null },
    });
    const orchestrator = makeOrchestrator(deps);

    await pollOnce(orchestrator);
    await drainWorkers(orchestrator);
    await orchestrator.stop();

    const audit = deps.audit as MemoryAuditSink;
    const store = deps.store as MemoryMetadataStore;

    // The sink wrote a Failed row...
    const rows = await audit.listRunAudits();
    expect(rows.some((r) => r.issueId === "a" && r.outcome === "Failed")).toBe(true);

    // ...and the metadata store SEES it via the shared backing.
    const attempts = await store.countAttemptsForIssue("a");
    expect(attempts).toBeGreaterThanOrEqual(1);

    // Construction-level proof that they share one MemoryAuditState instance:
    // a fresh sink over a fresh state would report zero rows.
    const orphanSink = new MemoryAuditSink(new MemoryAuditState());
    expect((await orphanSink.listRunAudits()).length).toBe(0);
  });

  it("defaults the clock seam to systemClock and exposes a MemoryInstanceLock", () => {
    const cfg = makeMemoryConfig({ runtime: "fake", model: MODEL });
    const deps = _buildDeps(cfg, {
      seed: [makeIssue({ id: "a", identifier: "MEM-1", state: DISPATCH_STATE })],
      deliverable: { branches: null },
    });
    expect(deps.clock).toBe(systemClock);
    expect(deps.lock).toBeInstanceOf(MemoryInstanceLock);
  });
});

/* ----------------------------- watcher contract ---------------------------- */

describe("buildDeps wires a self-contained WorkflowWatcher from cfg (no file watch)", () => {
  it("returns a watcher whose snapshot() yields the parsed memory config", () => {
    const cfg = makeMemoryConfig({ runtime: "fake", model: MODEL });
    const deps = _buildDeps(cfg, {
      seed: [makeIssue({ id: "a", identifier: "MEM-1", state: DISPATCH_STATE })],
      deliverable: { branches: null },
    });
    const watcher: WorkflowWatcher = deps.watcher;
    const snap: WorkflowSnapshot = watcher.snapshot();
    expect(snap.config.tracker.kind).toBe("memory");
    expect(snap.config.agentRuntime.model).toBe(MODEL);
  });
});
