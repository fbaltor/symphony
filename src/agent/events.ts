/**
 * Spec §10.4 — runtime events emitted by an `AgentRunner` adapter, normalized
 * across coding-agent runtimes (Codex / Claude / others).
 *
 * **Currently emitted by `agent/claude-adapter.ts`:**
 *   - `turn_completed`
 *   - `turn_failed`
 *   - `turn_cancelled`
 *
 * **Reserved (declared for spec parity; emitted once IMPROVEMENTS.md A-22
 * — live event stream wiring — lands):**
 *   - `session_started` — fires when the adapter opens a Claude / Codex
 *     session (today the SDK has no long-lived subprocess between turns,
 *     but the spec mandates one event per session lifecycle).
 *   - `startup_failed` — adapter failed to start a session (auth /
 *     subprocess spawn / SDK import error). Should turn into a `Failed`
 *     `RunAttemptStatus`.
 *   - `turn_ended_with_error` — turn produced a final result message with
 *     `is_error: true` rather than throwing. Today rolled into
 *     `turn_failed`; A-22 splits it out so observers can distinguish
 *     "model returned an error" from "turn was killed".
 *   - `turn_input_required` — model paused awaiting tool/user input.
 *     Symphony runs autonomously so this is currently treated as a
 *     spurious stall; A-22 will surface it for status-page visibility.
 *   - `approval_auto_approved` — `permissionMode: 'bypassPermissions'`
 *     auto-approved a tool call. A-22 records these for audit; today
 *     they're invisible.
 *   - `unsupported_tool_call` — model called a tool the adapter doesn't
 *     advertise. Useful for surfacing misconfigured MCP wiring.
 *   - `notification` — generic adapter-side notice (low-signal events
 *     observers may want to subscribe to).
 *   - `other_message` — assistant message that doesn't map to one of the
 *     above (informational; usually streamed text).
 *   - `malformed` — message arrived but failed schema validation.
 */
export type AgentEventKind =
  | "session_started"
  | "startup_failed"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_ended_with_error"
  | "turn_input_required"
  | "approval_auto_approved"
  | "unsupported_tool_call"
  | "notification"
  | "other_message"
  | "malformed";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface AgentEvent {
  event: AgentEventKind;
  timestamp: number;
  pid: string | null;
  usage?: AgentUsage;
  message?: string;
  payload?: Record<string, unknown>;
}
