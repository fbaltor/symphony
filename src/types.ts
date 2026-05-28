/**
 * Shared domain types for Symphony.
 *
 * These mirror the spec's §4.1 entity definitions. Keep these aligned with
 * `tracker/normalize.ts`, `orchestrator/state.ts`, and `agent/events.ts`.
 */

/** Spec §4.1.1 — normalized issue record. */
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: Blocker[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Blocker {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/** Spec §4.1.4 — workspace handle. */
export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

/** Spec §4.1.5 — run attempt status enum. */
export type RunAttemptStatus =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingAgentProcess"
  | "InitializingSession"
  | "StreamingTurn"
  | "Finishing"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation";

/** Spec §4.1.5 — run attempt record. */
export interface RunAttempt {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  startedAt: number;
  status: RunAttemptStatus;
  error: string | null;
}

/** Spec §4.1.6 — session metadata. */
export interface LiveSession {
  sessionId: string;
  threadId: string;
  turnId: string;
  agentPid: string | null;
  lastEvent: string | null;
  lastEventTimestamp: number | null;
  lastMessage: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
}

/** Spec §4.1.7 — retry queue entry. */
export interface RetryEntry {
  issueId: string;
  identifier: string;
  /**
   * Tracking number for the retry queue (always 1-based).
   * For `kind: "retry"` this is also the attempt number that will be passed
   * to the next dispatch. For `kind: "continuation"` the next dispatch uses
   * `attempt: null` regardless — see spec §7.1.
   */
  attempt: number;
  /**
   * Distinguishes a failure-driven retry from a post-success continuation
   * re-check. Continuations dispatch with `attempt: null` so the audit row,
   * Slack message, and prompt template don't mislabel a fresh first turn as
   * a retry.
   */
  kind: "retry" | "continuation";
  dueAtMs: number;
  timerHandle: NodeJS.Timeout;
  error: string | null;
}

/** Spec §4.1.5 + run-time bookkeeping for an active worker. */
export interface RunningEntry {
  issue: Issue;
  attempt: RunAttempt;
  session: LiveSession | null;
  startedAtMonotonicMs: number;
  lastEventMonotonicMs: number;
  abort: () => Promise<void>;
}

/** Spec §4.1.8 — top-level orchestrator runtime state. */
export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    secondsRunning: number;
    /**
     * Cumulative cost since process start (USD). Mirrors `run_audit.cost_usd`
     * sums but lives in-memory so `/status` can surface spend without a DB
     * round-trip. Reset on every process boot — operators wanting durable
     * spend should hit `/cost` (queries `run_audit` directly).
     */
    costUsd: number;
  };
  rateLimits: Record<string, unknown> | null;
}
