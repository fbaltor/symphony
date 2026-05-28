/**
 * Specialist agent contract — §8 / E-10..E-15 of IMPROVEMENTS.md.
 *
 * Each specialist agent in Symphony's 16-state pipeline owns:
 *   1. A `SYSTEM_PROMPT` string (per §10's "prompts in code" pattern; B-2's
 *      `prompt_version` provenance).
 *   2. A `buildUserMessage(ctx)` function that assembles the per-turn user
 *      message from issue + comments + Postgres metadata.
 *   3. A `run(ctx)` function that the orchestrator dispatches when an issue
 *      enters the specialist's owned state.
 *
 * The orchestrator does NOT pass the rendered WORKFLOW.md template to
 * specialists; specialists own their full prompt. WORKFLOW.staging.md's
 * Liquid envelope is fallback only — used for unknown states or human-review
 * states where the dispatch path isn't a specialist.
 *
 * Cost accounting: every specialist's `run()` calls `recordSpecialistRun()`
 * with its own `iterationKey` so the §8 / E-6 counters stay accurate.
 */

import type pg from "pg";
import type { LinearTrackerClient } from "../tracker/linear.js";
import type { Issue } from "../types.js";

/**
 * Context passed to a specialist's run() and buildUserMessage(). Bundles
 * everything a specialist needs to produce its deliverable without making
 * additional network calls (besides the LLM turn itself).
 */
export interface SpecialistContext {
  /** The Linear issue being processed. */
  issue: Issue;
  /**
   * Substantive comments fetched in the same call that fetched the issue,
   * already filtered (lifecycle telemetry stripped, head-truncated). The
   * `Comment` shape here matches what `tracker/normalize.ts` produces.
   */
  comments: Array<{
    author: string;
    createdAt: string;
    body: string;
  }>;
  /** Postgres pool for issue_metadata reads/writes. */
  pool: pg.Pool;
  /**
   * Tracker client. Typed as `LinearTrackerClient` because specialist agents
   * use Linear-specific extensions (`createIssue`, `archiveIssue`, etc.) for
   * sub-ticket filing and re-planning. Once those operations are lifted into
   * `IssueTracker`, this can be narrowed to the base interface.
   */
  tracker: LinearTrackerClient;
  /**
   * Workspace path on disk where the cloned monorepo lives. Specialists
   * don't write files (per WORKFLOW.staging.md `write_cwds_by_state: []`),
   * but they do `Read` / `Grep` to gather context.
   */
  workspacePath: string;
  /** Logger pre-bound with issue identifier. */
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
    debug: (obj: object, msg: string) => void;
  };
  /** AbortController for early cancellation (reconciler-driven). */
  abortController: AbortController;
}

/**
 * Result returned by a specialist's run(). Mirrors the shape Symphony's
 * existing audit writer expects so the orchestrator can write a single
 * row to symphony.run_audit at turn end.
 */
export interface SpecialistResult {
  /** Outcome enum — matches RunAttemptStatus where applicable. */
  outcome:
    | "Succeeded"
    | "Failed"
    | "TimedOut"
    | "Stalled"
    | "CanceledByReconciliation"
    | "Escalated";
  /** Cost of this specialist's LLM turn (USD). */
  costUsd: number;
  /** Total tokens consumed. */
  tokens: { input: number; output: number; total: number };
  /** Anthropic model used (e.g., "claude-opus-4-7"). */
  model: string | null;
  /** Optional error message when outcome != Succeeded. */
  error: string | null;
  /**
   * Optional next-state override. RESERVED for a future direct-`run()`
   * invocation path — currently NOT consulted by the orchestrator.
   *
   * The actual routing override mechanism is `parseDecisionOverride` in
   * `src/lib/section-manager.ts`, which scans the issue's fresh description
   * after the LLM turn for a `## PR validation report` / `## Release
   * report` / `## Error` Decision line (e.g., `Bouncing to Pull request.`,
   * `Escalating to Error (manual).`, `Advancing to Done.`). The LLM has
   * no way to set this TS field directly; specialist agents direct routing
   * by writing the Decision line into the description.
   *
   * Stub returns from specialist `.run()` (e.g., the iteration-cap escalation
   * in `pr-validation/index.ts`) still set this field for type-shape parity.
   * If a future change wires `specialist.run()` into the orchestrator, this
   * field will be honored as a primary signal alongside the Decision-line
   * fallback.
   *
   * Surfaced 2026-05-07 by Copilot review on PR #684.
   */
  nextStateOverride?: string | null;
  /** Optional Linear comment text the orchestrator posts on the issue. */
  comment?: string | null;
  /** Free-form extra fields written into run_audit.extra. */
  extra?: Record<string, unknown>;
}

/**
 * The contract every specialist module exports as its default.
 *
 * Modules: `src/agents/prioritized/index.ts`, `src/agents/technical-plan/index.ts`,
 * `src/agents/pr-validation/index.ts`, `src/agents/release/index.ts`.
 * The orchestrator's specialist registry imports these in `src/agents/index.ts`
 * and looks them up by state name.
 */
export interface Specialist {
  /** Slug (kebab-case) used in audit + logs. */
  name: string;
  /** Linear state this specialist owns (e.g., "Prioritized"). */
  state: string;
  /** Full SYSTEM_PROMPT string passed to the SDK. */
  systemPrompt: string;
  /**
   * Stable identifier for the prompt's content hash, recorded into
   * symphony.run_audit.prompt_version (B-2). Set at module import using
   * the git SHA of the build (so a regression to a specific prompt
   * version is post-hoc analyzable).
   */
  promptVersion: string;
  /** Build the per-turn user-message string from context. */
  buildUserMessage(ctx: SpecialistContext): string;
  /**
   * Execute the specialist's turn end-to-end:
   *   1. Build the user message
   *   2. Drive the LLM via claudeAdapter
   *   3. Parse the response
   *   4. Write deliverables (description sections / sub-issues / comments)
   *   5. Record cost + iteration counter via recordSpecialistRun()
   *
   * The orchestrator awaits the result and writes a run_audit row.
   */
  run(ctx: SpecialistContext): Promise<SpecialistResult>;
}

/**
 * Helper: get the build's git SHA for prompt_version provenance. Falls
 * back to "dev" if not running from a built image.
 */
export function getPromptVersion(): string {
  return (
    process.env.GIT_SHA ??
    process.env.SYMPHONY_BUILD_SHA ??
    process.env.K_REVISION ?? // Cloud Run injects this
    "dev"
  );
}
