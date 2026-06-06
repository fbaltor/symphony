import type pg from "pg";
import type { PgPoolType } from "./audit/client.js";
import { createPool } from "./audit/client.js";
import type { SymphonyConfig } from "./workflow/config.js";
import { WorkflowWatcher } from "./workflow/watch.js";
import type { OrchestratorDeps } from "./orchestrator/orchestrator.js";
import type { AgentRunner } from "./agent/runner.js";
import { createAgentRunner } from "./agent/runner-factory.js";
import { buildMcpServers } from "./agent/mcp-config.js";
import { LinearTrackerClient } from "./tracker/linear.js";
import { MemoryTracker } from "./tracker/memory.js";
import {
  MemoryAuditSink,
  MemoryAuditState,
  MemoryBudgetStore,
  MemoryMetadataStore,
} from "./audit/store-memory.js";
import {
  PostgresAuditSink,
  PostgresBudgetStore,
  PostgresMetadataStore,
} from "./audit/store-postgres.js";
import { GithubDeliverableSource, MemoryDeliverableSource } from "./lib/deliverable-source.js";
import { MemoryInstanceLock, PostgresInstanceLock, type InstanceLock } from "./singleton/lock.js";
import { systemClock, type Clock } from "./lib/clock.js";
import { SlackObserver } from "./observability/slack.js";
import type { Issue } from "./types.js";
import type { FakeAgentRunner } from "./agent/fake-runner.js";
import type { MemoryDeliverableSourceScript } from "./lib/deliverable-source.js";

/**
 * Phase E (zero-dep E2E) — the composition factory.
 *
 * `buildDeps(cfg, overrides?)` builds the orchestrator's dependency bundle,
 * keyed on `cfg.tracker.kind` (decision 3b — `tracker.kind` is the single
 * source of truth for the whole profile):
 *
 *   - `kind: "memory"` → ALL in-memory impls (MemoryTracker, the shared-backing
 *     MemoryMetadataStore + MemoryAuditSink, MemoryBudgetStore,
 *     MemoryDeliverableSource, MemoryInstanceLock, a degrade-to-empty pool, a
 *     disabled SlackObserver, and a watcher composed from cfg). The runner is
 *     chosen by `agentRuntime.runtime` (fake → FakeAgentRunner, claude → the
 *     real ClaudeAgentRunner). NO network, NO Postgres, NO LLM is touched at
 *     construction.
 *   - `kind: "linear"` → the production impls main.ts has always built
 *     (createPool, LinearTrackerClient, Postgres stores, GithubDeliverableSource,
 *     PostgresInstanceLock, a real SlackObserver). Behavior-identical to today;
 *     main.ts stays the only composition root that owns boot orchestration
 *     (lock acquire, orphan reaper, viewer-id fetch, watcher start, HTTP, signal
 *     handling, drain) using the bundle's `pool` / `lock` / `tracker`.
 *
 * The returned bundle is `OrchestratorDeps` plus the two phase-D seams the E2E
 * contract names explicitly (`lock`, `clock`) so callers can drive lock acquire
 * and inject a deterministic clock.
 */
export interface Deps extends OrchestratorDeps {
  /** Phase D singleton-lock seam. Memory → MemoryInstanceLock; linear → PostgresInstanceLock. */
  lock: InstanceLock;
  /** Phase D clock seam. Defaults to `systemClock`; overridable for lease tests. */
  clock: Clock;
}

export interface BuildDepsOverrides {
  /** Seed issues for the in-memory tracker (`kind: memory` only). */
  seed?: Issue[];
  /** Scripted fake-runner turns. Consulted only when `agentRuntime.runtime === "fake"`. */
  fakeScript?: ConstructorParameters<typeof FakeAgentRunner>[0];
  /** Scripted deliverable source (branches / PRs). Defaults to "couldn't tell". */
  deliverable?: MemoryDeliverableSourceScript;
  /** Override the clock (deterministic lease tests). Defaults to `systemClock`. */
  clock?: Clock;
  /**
   * Linear-profile runtime inputs supplied by main.ts (the only composition
   * root that reads these env-derived values). Ignored for `kind: memory`.
   */
  linear?: LinearProfileInputs;
}

/**
 * The env-derived runtime inputs the `kind: linear` profile needs. main.ts
 * owns the env reads + the file-watching `WorkflowWatcher` (so `/admin/reload`
 * keeps working) and hands them here, so this factory stays a pure wiring step.
 */
export interface LinearProfileInputs {
  /** The file-watching watcher main.ts started (owns reload). */
  watcher: WorkflowWatcher;
  /** `DATABASE_URL` resolved in main.ts. */
  databaseUrl: string;
  /** Postgres schema (defaults to `symphony` in main.ts). */
  dbSchema: string;
  /** Resolved Slack bot token (env), or undefined to disable. */
  slackToken?: string;
  /** Resolved Slack channel id (env), or undefined. */
  slackChannel?: string;
}

export function buildDeps(cfg: SymphonyConfig, overrides: BuildDepsOverrides = {}): Deps {
  if (cfg.tracker.kind === "memory") {
    return buildMemoryDeps(cfg, overrides);
  }
  return buildLinearDeps(cfg, overrides);
}

/* ----------------------------- memory profile ----------------------------- */

function buildMemoryDeps(cfg: SymphonyConfig, overrides: BuildDepsOverrides): Deps {
  const clock = overrides.clock ?? systemClock;

  const tracker = new MemoryTracker(overrides.seed ?? [], {
    teamId: cfg.tracker.teamId ?? "memory-team",
  });

  // One shared audit history so the metadata store's retry/cost reads see the
  // rows the audit sink writes (mirrors the single Postgres run_audit table).
  const auditState = new MemoryAuditState();
  const store = new MemoryMetadataStore(auditState);
  const audit = new MemoryAuditSink(auditState);
  const budget = new MemoryBudgetStore();

  const deliverable = new MemoryDeliverableSource(overrides.deliverable ?? { branches: null });

  const lock = new MemoryInstanceLock({ clock });

  // The runner axis is independent of tracker.kind: fake (default for E2E) or
  // the real Claude adapter, chosen by config. The fake's script comes from the
  // overrides; the claude adapter only stores opts (no I/O at construction).
  const runner: AgentRunner = createAgentRunner(cfg, { fakeScript: overrides.fakeScript });

  // Disabled SlackObserver — no token, no channel, silent no-op.
  const slack = new SlackObserver({ token: undefined, channelId: undefined });

  // A self-contained watcher built from cfg (no file watch).
  const watcher = WorkflowWatcher.fromConfig(cfg);

  return {
    watcher,
    tracker,
    runner,
    store,
    audit,
    budget,
    deliverable,
    pool: degradeToEmptyPool(),
    slack,
    lock,
    clock,
  };
}

/* ----------------------------- linear profile ----------------------------- */

function buildLinearDeps(cfg: SymphonyConfig, overrides: BuildDepsOverrides): Deps {
  const trackerCfg = cfg.tracker;
  // Narrow the discriminated union to the linear variant (apiKey: string). This
  // branch is only reached for `kind === "linear"`; the guard makes the type
  // narrowing explicit (and is a defensive invariant).
  if (trackerCfg.kind !== "linear") {
    throw new Error(`buildLinearDeps called with tracker.kind=${trackerCfg.kind}`);
  }
  const linear = overrides.linear;
  if (!linear) {
    throw new Error(
      "buildDeps(kind=linear) requires overrides.linear (watcher + databaseUrl + schema); " +
        "the linear profile's env-derived inputs are owned by the composition root (main.ts).",
    );
  }

  const pool = createPool({ databaseUrl: linear.databaseUrl, schema: linear.dbSchema });

  // Phase C: Postgres-backed stores — exact thin wrappers over today's audit /
  // guardrail functions, so the kind=linear profile behaves byte-for-byte.
  const store = new PostgresMetadataStore(pool);
  const audit = new PostgresAuditSink(pool);
  const budget = new PostgresBudgetStore(pool);

  // Phase D: advisory lock through the InstanceLock seam (delegates to the
  // unchanged acquireInstanceLock).
  const lock = new PostgresInstanceLock(pool);

  const tracker = new LinearTrackerClient({
    endpoint: trackerCfg.endpoint,
    apiKey: trackerCfg.apiKey,
    projectSlug: trackerCfg.projectSlug,
    teamId: trackerCfg.teamId,
  });

  // Re-resolve MCP servers per turn so freshly minted GitHub App tokens are
  // used; pass the tracker so the in-process linear_graphql tool reuses
  // Symphony's Linear auth.
  const runner = createAgentRunner(cfg, {
    claude: { mcpServersResolver: () => buildMcpServers({ tracker }) },
  });

  const slackChannelResolved = cfg.slack.channelId ?? linear.slackChannel ?? undefined;
  const slack = cfg.slack.enabled
    ? new SlackObserver({ token: linear.slackToken, channelId: slackChannelResolved, pool })
    : new SlackObserver({ token: undefined, channelId: undefined });

  // Phase D: the deliverable gate reads GitHub through this seam (resolves the
  // GH-App token internally). owner/repo are guaranteed by preflightValidate.
  const deliverable = new GithubDeliverableSource({
    owner: cfg.github.owner,
    repo: cfg.github.repo,
  });

  return {
    watcher: linear.watcher,
    tracker,
    runner,
    store,
    audit,
    budget,
    deliverable,
    pool,
    slack,
    lock,
    clock: overrides.clock ?? systemClock,
  };
}

/* ------------------------------- empty pool ------------------------------- */

/**
 * A `pg.Pool` stand-in for the `kind: memory` profile, for the seams not yet
 * abstracted off the raw pool (`ReviewGateStore`, the kill-switch read,
 * reconcile's actor lookup, the cascade's metadata ensure). Every `query`
 * resolves to an EMPTY result set and `connect` / `end` are no-ops, so NO
 * socket is ever opened. The callers all wrap their pool queries in try/catch +
 * degrade to empty, so an empty result set is the no-op those paths expect.
 */
export function degradeToEmptyPool(): PgPoolType {
  const emptyResult = { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
  const pool = {
    query: async () => emptyResult,
    connect: async () => {
      throw new Error("degradeToEmptyPool: connect() is not supported under kind=memory");
    },
    end: async () => undefined,
    on: () => pool,
    removeListener: () => pool,
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  } as unknown as pg.Pool;
  return pool;
}
