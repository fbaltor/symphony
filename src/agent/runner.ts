import type { Issue } from "../types.js";
import type { AgentEvent } from "./events.js";

/**
 * Spec §10 — `AgentRunner` interface.
 *
 * Symphony's orchestrator interacts with coding agents through this interface.
 * Concrete adapters (Claude, Codex) translate between the spec's abstract
 * session/turn model and the underlying runtime's protocol.
 *
 * Lifecycle per worker:
 *
 *   const session = await runner.startSession({ workspacePath, issue });
 *   const result1 = await runner.runTurn(session, { prompt, attempt });
 *   if (result1.outcome === "completed" && stillActive(issue)) {
 *     const result2 = await runner.runTurn(session, { continuation: ... });
 *   }
 *   await runner.endSession(session);
 */

export interface StartSessionArgs {
  workspacePath: string;
  issue: Issue;
  /** Optional cancel signal. When aborted, runner MUST tear down the session. */
  signal?: AbortSignal;
  /** Forwarded structured-log context (issue id / identifier). */
  logContext?: Record<string, unknown>;
}

export interface AgentSessionHandle {
  sessionId: string;
  threadId: string;
  pid: string | null;
  /**
   * Per-issue workspace path the adapter was opened against. Adapter
   * implementations MUST populate this in `startSession` so callers can
   * read it back without a side-channel (replaces the Symbol-keyed
   * mutation that previously lived in claude-adapter.ts).
   *
   * The orchestrator's `runWorker` invariant (spec §9.5) requires the
   * agent process's cwd matches this path. Adapters that spawn a
   * subprocess use it as the cwd; in-process adapters surface it for
   * observers (status snapshot, Slack thread cards).
   */
  workspacePath: string;
  /**
   * Iterator-style stream for in-flight events. Adapters may opt-in to push
   * events through here for live observers (Slack, status surface, audit).
   */
  events: AsyncIterable<AgentEvent>;
}

export interface RunTurnArgs {
  prompt: string;
  attempt: number | null;
  /** Wall-clock turn timeout in ms (spec §10.3). */
  turnTimeoutMs: number;
  /**
   * Soft stall timeout in ms — adapter SHOULD treat absence of any progress
   * event for this duration as a stall and surface a `turn_failed` /
   * `stalled` outcome. ≤0 disables stall detection.
   */
  stallTimeoutMs: number;
  /**
   * Optional cancel signal. When aborted, the adapter MUST tear down the
   * in-flight request and surface a `cancelled` outcome. Allows the
   * orchestrator's reconciliation loop to actually stop a running turn.
   */
  signal?: AbortSignal;
  /**
   * per-issue cumulative cost cap (USD). When set together
   * with `alreadyRecordedCostUsd`, the adapter checks each cost-bearing
   * SDK message against `recorded + currentTurnCost` and aborts the turn
   * mid-stream if the cumulative would exceed the cap. Surfaces as
   * `outcome: "failed"` with `errorMessage` describing the cap breach.
   * Omit (or set to 0) to disable.
   */
  perIssueCapUsd?: number;
  /**
   * cumulative USD already recorded against this issue (sum of
   * prior turns' final costs from `symphony.budget_state`). Used together
   * with `perIssueCapUsd` to drive mid-turn abort.
   */
  alreadyRecordedCostUsd?: number;
  /**
   * per-state turn cost cap (USD). When set, the adapter aborts
   * mid-stream if THIS TURN's running cost exceeds the cap (independent
   * of `perIssueCapUsd`). 0 / undefined disables the per-state check.
   * Looked up by orchestrator from `guardrails.perStateCapUsd[state]`.
   */
  perStateCapUsd?: number;
  /**
   * per-state write-scope discipline. When set, restrict Edit /
   * Write / MultiEdit calls to only paths inside one of these workspace
   * subdirectories. An explicit empty array `[]` means "no file writes
   * at all" (e.g. plan-only stages). `undefined` ⇒ no scope restriction
   * beyond the default workspace containment. Looked up by orchestrator
   * from `agent.writeCwdsByState[state]`.
   */
  writeCwds?: readonly string[];
}

export type RunTurnOutcome = "completed" | "failed" | "cancelled" | "timeout" | "stalled";

export interface RunTurnResult {
  outcome: RunTurnOutcome;
  finalEvent: AgentEvent;
  /**
   * Per-turn usage accumulators.
   *
   * `inputTokens` and `outputTokens` are the standard non-cached
   * accumulations. `cacheCreationInputTokens` + `cacheReadInputTokens`
   * are subsets of what would have been input tokens had Anthropic prompt
   * caching been disabled. `cacheReadInputTokens`
   * starts at zero on the first dispatch within a 5-min cache TTL window
   * and grows as subsequent dispatches reuse the same system-prompt
   * prefix; `cacheCreationInputTokens` accounts for the extra-fee
   * write-time tokens on the first dispatch.
   *
   * The orchestrator forwards these into the audit row (so per-issue
   * cache hit-rate is post-hoc analyzable) and into the Slack
   * announceOutcome call (so the operator sees the rate live).
   */
  usageDelta: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}

export interface AgentRunner {
  readonly kind: string;
  startSession(args: StartSessionArgs): Promise<AgentSessionHandle>;
  runTurn(session: AgentSessionHandle, args: RunTurnArgs): Promise<RunTurnResult>;
  endSession(session: AgentSessionHandle): Promise<void>;
}
