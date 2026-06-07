import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { RawWorkflow } from "./loader.js";

/**
 * Spec §5.3 + §6 — typed config view derived from `WORKFLOW.md` front matter.
 *
 * Resolution order (spec §6.1):
 *   1. raw front-matter map
 *   2. apply OPTIONAL field defaults
 *   3. resolve `$VAR_NAME` indirection (only on values that contain a literal
 *      `$NAME` token; we do NOT globally override YAML)
 *   4. coerce / validate via Zod
 */

/**
 * Fields shared by every `tracker.kind` variant — the state-machine config the
 * orchestrator drives regardless of whether issues come from Linear or the
 * in-memory tracker. Factored out so the discriminated union (decision 3b) can
 * layer the kind-specific connection fields (`apiKey` / `endpoint` /
 * `projectSlug`) on top without duplicating ~80 lines of state config twice.
 */
const trackerCommonShape = {
  activeStates: z.array(z.string()).default(["Todo", "In Progress"]),
    terminalStates: z
      .array(z.string())
      .default(["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]),
    /**
     * State-advancement map. After a turn lands `outcome=Succeeded`, the
     * orchestrator looks up `stateTransitions[issue.state]` and moves the
     * Linear issue to that next state automatically. Empty / missing key
     * means "leave the state alone" (e.g. for human-review states like RFC
     * or Code Review where symphony should NOT auto-advance).
     *
     * The keys/values are state *names* (case-insensitive match against the
     * team's workflow states). Resolved to ids inside the tracker client on
     * first transition.
     */
    stateTransitions: z.record(z.string(), z.string()).default({}),
    /**
     * Human-review gate states. The reconciler reverts unauthorized state
     * moves to/from any state in this list — i.e. moves that are NOT a
     * configured `state_transitions[prev] === next` advancement and that
     * touch a review gate. This closes the gap where an in-flight agent
     * occasionally calls `update_issue` to bypass a human-review halt
     * (e.g.  jumped Plan → Implement, skipping the RFC gate).
     *
     * Compared case-insensitively. Defaults match the WORKFLOW.md gates:
     * RFC, Code Review, Human Review.
     */
    humanReviewStates: z.array(z.string()).default(["RFC", "Code Review", "Human Review"]),
    /**
     * Whether the orchestrator should post a Linear comment at dispatch
     * start ("🤖 Symphony — <state> turn N started, model=…"). Default true.
     * Disable in dev environments where the polling cadence would spam.
     */
    announceDispatch: z.boolean().default(true),
    /**
     * Whether the orchestrator should post a Linear comment at dispatch
     * outcome ("✅ Succeeded — cost=$… tokens=…"). Default true.
     */
    announceOutcome: z.boolean().default(true),
    /**
     * States the auto-retry loop scans every `polling.errorRetryIntervalMs`
     * for tickets to release back into the dispatch loop with exponential
     * backoff (1 min → 2 → 4 → … 24h cap based on prior failed-audit-row
     * count, capped at `maxErrorRetries`). Distinct from `terminalStates`
     * (symphony stops permanently) and `activeStates` (symphony dispatches
     * each poll). Don't list a state in both `errorStates` and
     * `terminalStates`.
     */
    errorStates: z.array(z.string()).default(["Error"]),
    /**
     * Max auto-retry budget for an issue parked in `errorStates`. After
     * this many non-Succeeded audit rows, symphony posts a "needs human
     * review" comment and stops auto-retrying.
     */
    maxErrorRetries: z.number().int().nonnegative().default(5),
    /**
     * Stages whose deliverable IS a PR. Before auto-advancing OUT of any
     * state in this list, the orchestrator queries GitHub for a branch
     * matching the issue identifier and BLOCKS the advance when no
     * deliverable is found.
     *
     * Background:  +  (2026-04-29) reached `Code Review`
     * with empty branch state because their Validate-stage agents
     * converged on a no-op pattern, the SDK reported `outcome=Succeeded`,
     * and the orchestrator auto-advanced. The `pr_required_states` gate
     * stops that.
     *
     * Defaults: Validate, Implement, "Open PR", Polish — all stages whose
     * sole stated deliverable in WORKFLOW.md is a pushed branch / opened
     * PR. Discussion-only stages (Refinement → Plan → RFC) are NOT in
     * this list because they leave Linear comments, not branches.
     */
    prRequiredStates: z.array(z.string()).default(["Validate", "Implement", "Open PR", "Polish"]),
    /**
     * Agent-dispatched states: states with NO LLM specialist that should
     * STILL run an autonomous turn via the generic WORKFLOW.md template
     * (e.g. "To implement"). Without this, the tick loop's no-specialist
     * skips (cascade-only / transition-only) `continue` before dispatch(),
     * so the state would never run an agent. Listed states bypass those two
     * skips and reach dispatch() → buildSpecialistPrompt → null → WORKFLOW
     * envelope. Specialist-owned states ignore this (they dispatch anyway).
     */
    agentDispatchedStates: z.array(z.string()).default([]),
    /**
     * Maximum consecutive `outcome=Succeeded` turns where the deliverable
     * check fails before symphony moves the issue to `Error` (so a human
     * can intervene). Counter resets on a passing deliverable check or a
     * non-Succeeded outcome.
     */
    noPrRetryLimit: z.number().int().positive().default(3),
};

/**
 * Connection fields shared between the `linear` and `memory` variants so the
 * union members stay structurally compatible: `cfg.tracker.endpoint` /
 * `.apiKey` / `.projectSlug` / `.teamId` are readable on the union without a
 * `kind` narrow. The `linear` variant additionally REQUIRES `apiKey` and a
 * `projectSlug`-or-`teamId`; the `memory` variant leaves them all optional
 * (decision 3b — no Linear creds needed for the in-process E2E profile).
 */
const trackerConnectionShape = {
  endpoint: z.string().default("https://api.linear.app/graphql"),
  projectSlug: z.string().optional(),
  teamId: z.string().optional(),
};

/**
 * `tracker.kind` is a discriminated union (zero-dep E2E plan, decision 3b):
 *
 *   - `linear` — the production tracker. Requires a non-empty `apiKey` and at
 *     least one of `projectSlug` / `teamId` (the `.refine` below, preserving
 *     today's behavior byte-for-byte).
 *   - `memory` — the in-process `MemoryTracker` profile used by the
 *     zero-dependency E2E harness. Needs NO `apiKey` / `endpoint`; seed issues
 *     are supplied at composition time (`buildDeps` overrides), not via config.
 *
 * The variants share `trackerCommonShape` (state-machine config) and
 * `trackerConnectionShape` (connection fields) so the orchestrator's config
 * surface is identical regardless of kind.
 */
const linearTrackerSchema = z.object({
  kind: z.literal("linear"),
  apiKey: z.string().min(1),
  ...trackerConnectionShape,
  ...trackerCommonShape,
});

const memoryTrackerSchema = z.object({
  kind: z.literal("memory"),
  // Optional so a `kind: memory` config parses with no Linear creds at all.
  apiKey: z.string().optional(),
  ...trackerConnectionShape,
  ...trackerCommonShape,
});

// The `projectSlug`-or-`teamId` requirement applies ONLY to the linear variant.
// It lives on the union (not inside the member) because `discriminatedUnion`
// members must be bare `ZodObject`s — a `.refine()` would wrap them in a
// `ZodEffects` and break discrimination. Gating on `kind === "linear"` keeps
// the memory variant unconstrained while preserving today's linear behavior.
const trackerSchema = z
  .discriminatedUnion("kind", [linearTrackerSchema, memoryTrackerSchema])
  .refine((v) => v.kind !== "linear" || Boolean(v.projectSlug) || Boolean(v.teamId), {
    message: "tracker.project_slug or tracker.team_id is required",
    path: ["projectSlug"],
  });

const pollingSchema = z.object({
  intervalMs: z.number().int().positive().default(30_000),
  /**
   * How often `processErrorRetries()` scans `tracker.errorStates` for
   * tickets ready to be moved back into an active state. Default 5
   * minutes. Independent of `intervalMs` because the dispatch poll runs
   * frequently (~30s) on a hot path while the error scan is a slow
   * background task that hits Postgres + Linear once per tick.
   *
   * The actual decision to retry an issue is gated by per-issue
   * exponential backoff (1 min → 2 → 4 → … capped at 24h based on the
   * non-`Succeeded` `symphony.run_audit` row count); this interval just
   * controls how often the orchestrator wakes up to re-evaluate.
   */
  errorRetryIntervalMs: z.number().int().positive().default(300_000),
});

const workspaceSchema = z.object({
  root: z.string().min(1),
  /**
   * How often the orchestrator scans `workspace.root` for stale per-issue
   * directories and removes them. Default 10 minutes.
   *
   * Background: Cloud Run's `/tmp` is tmpfs (~1 GB default). Each dispatch
   * leaves behind a ~500 MB workspace (cloned monorepo + pnpm install).
   * Without periodic GC, /tmp fills after ~2 dispatches and the next
   * `before_run` clone fails with ENOSPC. Today min=max=1 instance restarts
   * mask the bug; once we run longer-lived instances or higher concurrency
   * the GC becomes load-bearing.
   */
  gcIntervalMs: z.number().int().positive().default(600_000),
  /**
   * Minimum age (mtime) a workspace must have before periodic GC will
   * remove it, even when no worker is using it. Default 1 hour.
   *
   * Workspaces under this threshold are kept around for fast reuse
   * (idempotent before_run skips the clone and only does fetch+reset).
   * Above the threshold the cost of re-cloning is paid back many times
   * over by the disk space we reclaim.
   */
  gcMaxAgeMs: z.number().int().positive().default(3_600_000),
});

const hooksSchema = z.object({
  afterCreate: z.string().nullable().default(null),
  beforeRun: z.string().nullable().default(null),
  afterRun: z.string().nullable().default(null),
  beforeRemove: z.string().nullable().default(null),
  timeoutMs: z.number().int().positive().default(60_000),
});

const agentSchema = z.object({
  maxConcurrentAgents: z.number().int().positive().default(10),
  maxTurns: z.number().int().positive().default(20),
  maxRetryBackoffMs: z.number().int().positive().default(300_000),
  maxConcurrentAgentsByState: z.record(z.string(), z.number().int().positive()).default({}),
  /**
   * Per-state write-scope discipline (see docs/adr/0017). Maps a
   * Linear state name (case-insensitive at use time) to a list of workspace
   * subpaths the agent is permitted to write within while in that state.
   *
   *   write_cwds_by_state:
   *     pull_request_assembly:
   *       - apps
   *       - packages
   *       - independent
   *     subtask_drafting:
   *       []   # Linear comments only — file writes blocked
   *
   * An empty list `[]` for a state DENIES all file writes in that state
   * (Edit / Write / MultiEdit). When the state is absent OR `writeCwds` is
   * omitted on the runTurn call, the canUseTool falls back to the existing
   * "anywhere inside the workspace" rule. Paths are joined with the
   * per-issue workspace root at check time (so `apps` → `${ws}/apps`).
   */
  writeCwdsByState: z.record(z.string(), z.array(z.string())).default({}),
});

const codexSchema = z.object({
  command: z.string().default("codex app-server"),
  approvalPolicy: z.string().default("auto"),
  threadSandbox: z.string().default("unrestricted"),
  turnSandboxPolicy: z.string().default("unrestricted"),
  turnTimeoutMs: z.number().int().positive().default(3_600_000),
  readTimeoutMs: z.number().int().positive().default(5_000),
  stallTimeoutMs: z.number().int().default(300_000),
});

const guardrailsSchema = z
  .object({
    dailyCapUsd: z.number().nonnegative().default(250),
    perIssueCapUsd: z.number().nonnegative().default(10),
    /**
     * Per-state turn cost cap (see docs/adr/0012). Lookup keyed by
     * Linear state name (case-insensitive at use time). Each ENTRY is
     * the max USD a SINGLE turn in that state may spend. Independent of
     * `perIssueCapUsd` (issue-wide cumulative) and `dailyCapUsd` (org-wide
     * cumulative).
     *
     * Example WORKFLOW.md:
     *   guardrails:
     *     daily_cap_usd: 250
     *     per_issue_cap_usd: 30
     *     per_state_cap_usd:
     *       Refinement: 3
     *       Plan: 5
     *       Implement: 25
     *
     * A turn that exceeds its state cap aborts mid-stream (the
     * streaming abort). Empty / unset disables the per-state check.
     */
    perStateCapUsd: z.record(z.string(), z.number().nonnegative()).default({}),
  })
  .default({ dailyCapUsd: 250, perIssueCapUsd: 10, perStateCapUsd: {} });

const slackSchema = z
  .object({
    enabled: z.boolean().default(true),
    channelId: z.string().min(1).nullable().optional(),
  })
  .default({ enabled: true });

// Two runtimes ship: the real `claude` adapter (default) and the scripted
// `fake` runner (zero-LLM-cost, deterministic — used by the `kind: memory`
// E2E profile; see runner-factory.ts + plan §3 "Agent axis stays
// independent"). The Codex adapter (spec §10) is still a follow-up PR;
// when it lands, add it to this enum and
// reintroduce a runtime switch in the orchestrator.
//
// `model` is now non-empty-string-validated (was `optional` only —
// allowed misconfigured `model: ""` to slip through and fall back to SDK
// default silently). `effort` is forwarded to Anthropic's adaptive
// thinking config (`thinking: { type: "adaptive", effort }`) per the
// 2026 SDK features. Omitting it preserves the SDK's own default.
const agentRuntimeSchema = z
  .object({
    runtime: z.enum(["claude", "fake"]).default("claude"),
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  })
  .default({ runtime: "claude" });

// GitHub repo coordinates for the deliverable check (`fetchBranches` /
// `branchMatchesIdentifier`) and for `gh` CLI invocations. `owner` and
// `repo` are required at runtime (checked in `preflightValidate`).
// `branchPrefix` controls the prefix used in branch names for sub-issue
// work — default `"symphony"` produces `symphony/<issue-id-lowercased>`.
const githubSchema = z
  .object({
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    branchPrefix: z.string().min(1).default("symphony"),
  })
  .default({ branchPrefix: "symphony" });

export const symphonyConfigSchema = z.object({
  tracker: trackerSchema,
  polling: pollingSchema,
  workspace: workspaceSchema,
  hooks: hooksSchema,
  agent: agentSchema,
  codex: codexSchema,
  guardrails: guardrailsSchema,
  slack: slackSchema,
  agentRuntime: agentRuntimeSchema,
  github: githubSchema,
});

export type SymphonyConfig = z.infer<typeof symphonyConfigSchema>;

export interface ResolveContext {
  workflowPath: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve a raw front-matter map + prompt template into a typed config.
 *
 * Throws via `z.ZodError` if validation fails; callers translate this into a
 * spec §6.3 dispatch-preflight error.
 */
export function resolveConfig(raw: RawWorkflow, ctx: ResolveContext): SymphonyConfig {
  const cfg = (raw.config ?? {}) as Record<string, unknown>;
  const tracker = expandPlain(cfg.tracker, ctx);
  const workspace = ensureObject(cfg.workspace);
  const polling = ensureObject(cfg.polling);
  const hooks = ensureObject(cfg.hooks);
  const agent = ensureObject(cfg.agent);
  const codex = ensureObject(cfg.codex);
  const guardrails = ensureObject(cfg.guardrails);
  const slack = ensureObject(cfg.slack);
  // YAML in WORKFLOW.md uses snake_case (`agent_runtime`); accept both that
  // and the camelCase form (`agentRuntime`) so internal callers and tests
  // can use either. Same dual-key pattern as `tracker.api_key` etc.
  const agentRuntime = ensureObject(cfg.agent_runtime ?? cfg.agentRuntime);
  const github = ensureObject(cfg.github);

  // Workspace root: $VAR + ~ + relative-to-workflow-dir resolution. Default to
  // a tmpdir directory if absent.
  let workspaceRoot = (workspace.root as string | undefined) ?? `${tmpdir()}/symphony_workspaces`;
  workspaceRoot = expandEnvAndHome(workspaceRoot, ctx.env);
  if (!isAbsolute(workspaceRoot)) {
    workspaceRoot = resolve(dirname(ctx.workflowPath), workspaceRoot);
  } else {
    workspaceRoot = resolve(workspaceRoot);
  }

  const candidate = {
    tracker: {
      kind: tracker.kind,
      endpoint: tracker.endpoint,
      apiKey: tracker.api_key ?? tracker.apiKey,
      projectSlug: tracker.project_slug ?? tracker.projectSlug,
      teamId: tracker.team_id ?? tracker.teamId,
      activeStates: tracker.active_states ?? tracker.activeStates,
      terminalStates: tracker.terminal_states ?? tracker.terminalStates,
      stateTransitions: tracker.state_transitions ?? tracker.stateTransitions,
      humanReviewStates: tracker.human_review_states ?? tracker.humanReviewStates,
      announceDispatch: pickBoolOptional(tracker.announce_dispatch ?? tracker.announceDispatch),
      announceOutcome: pickBoolOptional(tracker.announce_outcome ?? tracker.announceOutcome),
      prRequiredStates: tracker.pr_required_states ?? tracker.prRequiredStates,
      agentDispatchedStates: tracker.agent_dispatched_states ?? tracker.agentDispatchedStates,
      noPrRetryLimit: pickNumber(tracker.no_pr_retry_limit ?? tracker.noPrRetryLimit, undefined),
      errorStates: tracker.error_states ?? tracker.errorStates,
      maxErrorRetries: pickNumber(tracker.max_error_retries ?? tracker.maxErrorRetries, undefined),
    },
    polling: {
      intervalMs: pickNumber(polling.interval_ms ?? polling.intervalMs, undefined),
      errorRetryIntervalMs: pickNumber(
        polling.error_retry_interval_ms ?? polling.errorRetryIntervalMs,
        undefined,
      ),
    },
    workspace: {
      root: workspaceRoot,
      gcIntervalMs: pickNumber(workspace.gc_interval_ms ?? workspace.gcIntervalMs, undefined),
      gcMaxAgeMs: pickNumber(workspace.gc_max_age_ms ?? workspace.gcMaxAgeMs, undefined),
    },
    hooks: {
      afterCreate: pickStringOrNull(hooks.after_create ?? hooks.afterCreate),
      beforeRun: pickStringOrNull(hooks.before_run ?? hooks.beforeRun),
      afterRun: pickStringOrNull(hooks.after_run ?? hooks.afterRun),
      beforeRemove: pickStringOrNull(hooks.before_remove ?? hooks.beforeRemove),
      timeoutMs: pickNumber(hooks.timeout_ms ?? hooks.timeoutMs, undefined),
    },
    agent: {
      maxConcurrentAgents: pickNumber(
        agent.max_concurrent_agents ?? agent.maxConcurrentAgents,
        undefined,
      ),
      maxTurns: pickNumber(agent.max_turns ?? agent.maxTurns, undefined),
      maxRetryBackoffMs: pickNumber(
        agent.max_retry_backoff_ms ?? agent.maxRetryBackoffMs,
        undefined,
      ),
      maxConcurrentAgentsByState: normalizeStateMap(
        (agent.max_concurrent_agents_by_state ?? agent.maxConcurrentAgentsByState) as
          | Record<string, unknown>
          | undefined,
      ),
      // per-state write-scope discipline.
      writeCwdsByState: lowercaseStateArrayMap(
        (agent.write_cwds_by_state ?? agent.writeCwdsByState) as
          | Record<string, unknown>
          | undefined,
      ),
    },
    codex: {
      command: codex.command,
      approvalPolicy: codex.approval_policy ?? codex.approvalPolicy,
      threadSandbox: codex.thread_sandbox ?? codex.threadSandbox,
      turnSandboxPolicy: codex.turn_sandbox_policy ?? codex.turnSandboxPolicy,
      turnTimeoutMs: codex.turn_timeout_ms ?? codex.turnTimeoutMs,
      readTimeoutMs: codex.read_timeout_ms ?? codex.readTimeoutMs,
      stallTimeoutMs: codex.stall_timeout_ms ?? codex.stallTimeoutMs,
    },
    guardrails: {
      dailyCapUsd: guardrails.daily_cap_usd ?? guardrails.dailyCapUsd,
      perIssueCapUsd: guardrails.per_issue_cap_usd ?? guardrails.perIssueCapUsd,
      // normalize keys to lowercase at parse time so case-insensitive
      // lookup is a plain map.get() at use time.
      perStateCapUsd: lowercaseStateMap(
        (guardrails.per_state_cap_usd ?? guardrails.perStateCapUsd) as
          | Record<string, unknown>
          | undefined,
      ),
    },
    slack: {
      enabled: slack.enabled,
      channelId: pickStringOrNull(
        // Expand $VAR / ~ on the workflow value before falling back to the env.
        expandMaybeString(slack.channel_id ?? slack.channelId, ctx) ?? ctx.env.SLACK_CHANNEL_ID,
      ),
    },
    agentRuntime: {
      runtime: agentRuntime.runtime ?? "claude",
      model: agentRuntime.model,
      effort: agentRuntime.effort,
    },
    github: {
      owner: (github.owner as string | undefined) ?? undefined,
      repo: (github.repo as string | undefined) ?? undefined,
      branchPrefix:
        (github.branch_prefix as string | undefined) ??
        (github.branchPrefix as string | undefined) ??
        undefined,
    },
  };

  return symphonyConfigSchema.parse(candidate);
}

/* ------------------------------ helpers --------------------------------- */

function ensureObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function expandPlain(value: unknown, ctx: ResolveContext): Record<string, unknown> {
  const obj = ensureObject(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      out[k] = expandEnvAndHome(v, ctx.env);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === "string" ? expandEnvAndHome(item, ctx.env) : item));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Resolve `$VAR_NAME` (no braces, alphanumeric+underscore, max one per token)
 * and a leading `~` against env / homedir. Spec §6.1 — applied only on values
 * that the schema marks as path or env-token-bearing.
 */
export function expandEnvAndHome(value: string, env: NodeJS.ProcessEnv): string {
  let out = value;
  if (out.startsWith("~")) {
    out = out.replace(/^~/, homedir());
  }
  // Replace exact literal $VAR (whole string) — keep it conservative; this is
  // not a general shell expansion.
  const m = out.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  if (m && m[1] && env[m[1]] !== undefined) {
    return env[m[1]] as string;
  }
  // Inline $VAR replacement for embedded values (e.g. "/var/$ENV/work").
  out = out.replace(/\$([A-Z_][A-Z0-9_]*)/g, (whole, name: string) => {
    const v = env[name];
    return v === undefined ? whole : v;
  });
  return out;
}

function pickStringOrNull(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

function pickBoolOptional(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return undefined;
}

/** Expand $VAR / ~ on a string-or-undefined value; passes through other types. */
function expandMaybeString(v: unknown, ctx: ResolveContext): unknown {
  if (typeof v !== "string") return v;
  return expandEnvAndHome(v, ctx.env);
}
function pickNumber(v: unknown, fallback: number | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
function normalizeStateMap(input: Record<string, unknown> | undefined): Record<string, number> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input)) {
    const n = pickNumber(v, undefined);
    if (n !== undefined && n > 0 && Number.isInteger(n)) {
      out[k.toLowerCase()] = n;
    }
  }
  return out;
}

/**
 * same shape as normalizeStateMap but accepts non-integer values
 * (USD cost caps are decimals). Lowercases keys for case-insensitive
 * lookup at use time.
 */
function lowercaseStateMap(input: Record<string, unknown> | undefined): Record<string, number> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input)) {
    const n = pickNumber(v, undefined);
    if (n !== undefined && n >= 0) {
      out[k.toLowerCase()] = n;
    }
  }
  return out;
}

/**
 * state → list-of-subpath map (write-scope discipline). Lowercases
 * keys for case-insensitive lookup. Empty list `[]` is preserved (it
 * means "no writes allowed in this state"); a non-array value is
 * dropped silently rather than causing a crash on malformed YAML.
 */
function lowercaseStateArrayMap(
  input: Record<string, unknown> | undefined,
): Record<string, string[]> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(input)) {
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k.toLowerCase()] = v as string[];
    }
  }
  return out;
}

/** Spec §6.3 — preflight validation. Returns null if OK; error message if not. */
export function preflightValidate(cfg: SymphonyConfig): string | null {
  if (!cfg.tracker.kind) return "tracker.kind missing";
  // Linear-credential checks apply ONLY to `kind=linear` (decision 3b). The
  // `kind=memory` profile (zero-dependency E2E) needs no apiKey / endpoint /
  // projectSlug — its issues are seeded at composition time, not fetched from
  // Linear — so it skips this whole block and validates on the shared fields
  // (slack / codex / github) below. The `kind=linear` path is unchanged.
  if (cfg.tracker.kind === "linear") {
    if (!cfg.tracker.apiKey) return "tracker.api_key missing after resolution";
    if (looksUnresolved(cfg.tracker.apiKey)) {
      return `tracker.api_key has unresolved env token: ${cfg.tracker.apiKey}`;
    }
    if (!cfg.tracker.projectSlug && !cfg.tracker.teamId) {
      return "tracker.project_slug or tracker.team_id required when kind=linear";
    }
  }
  // catch the literal `$SLACK_CHANNEL_ID` pass-through bug. When the env
  // var is unset, `expandEnvAndHome()` leaves the placeholder unchanged and
  // `pickStringOrNull` accepts it — Slack would post to channel "$SLACK_CHANNEL_ID"
  // and 404. Validate here so a misconfigured deploy fails at boot rather
  // than at the first announceDispatch call.
  if (cfg.slack.enabled && cfg.slack.channelId && looksUnresolved(cfg.slack.channelId)) {
    return `slack.channel_id has unresolved env token: ${cfg.slack.channelId}`;
  }
  if (!cfg.codex.command) return "codex.command missing";
  if (!cfg.github.owner) return "github.owner is required — set it in WORKFLOW.md under the `github:` section";
  if (!cfg.github.repo) return "github.repo is required — set it in WORKFLOW.md under the `github:` section";
  return null;
}

/**
 * A literal `$NAME` token that survived expansion means the env var was
 * missing; we'd rather fail at startup than send the literal string to Linear.
 */
function looksUnresolved(value: string): boolean {
  return /^\$[A-Z_][A-Z0-9_]*$/.test(value);
}

/** Useful for callers that want to know the workspace root quickly. */
export function workspaceRootOf(cfg: SymphonyConfig): string {
  return cfg.workspace.root;
}

/** Public path helper: join a sanitized identifier under the workspace root. */
export function workspacePathFor(cfg: SymphonyConfig, sanitizedKey: string): string {
  return join(cfg.workspace.root, sanitizedKey);
}
