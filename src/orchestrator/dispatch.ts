import type { Issue, OrchestratorState } from "../types.js";
import { availableSlots, perStateLimit, runningInState } from "./state.js";

/**
 * Spec §8.2 — candidate selection rules and stable sort.
 */

export interface DispatchInputs {
  state: OrchestratorState;
  activeStates: string[];
  terminalStates: string[];
  perStateLimits: Record<string, number>;
}

export function isEligible(issue: Issue, inputs: DispatchInputs): { ok: boolean; reason?: string } {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
    return { ok: false, reason: "missing required field" };
  }
  const lower = issue.state.toLowerCase();
  const inActive = inputs.activeStates.some((s) => s.toLowerCase() === lower);
  const inTerminal = inputs.terminalStates.some((s) => s.toLowerCase() === lower);
  if (!inActive || inTerminal) return { ok: false, reason: `state ${issue.state} not eligible` };

  if (inputs.state.running.has(issue.id)) return { ok: false, reason: "already running" };
  if (inputs.state.claimed.has(issue.id)) return { ok: false, reason: "already claimed" };

  if (availableSlots(inputs.state) <= 0) return { ok: false, reason: "no global slots" };

  const limit = perStateLimit(inputs.state, inputs.perStateLimits, issue.state);
  if (runningInState(inputs.state, issue.state) >= limit) {
    return { ok: false, reason: `per-state slot limit reached for ${issue.state}` };
  }

  // Spec §8.2 — Todo issue with non-terminal blockers is NOT eligible.
  if (issue.state.toLowerCase() === "todo" && issue.blockedBy.length > 0) {
    const terminalLower = inputs.terminalStates.map((s) => s.toLowerCase());
    const hasNonTerminal = issue.blockedBy.some((b) => {
      const st = (b.state ?? "").toLowerCase();
      return st && !terminalLower.includes(st);
    });
    if (hasNonTerminal) return { ok: false, reason: "blocked by non-terminal issue" };
  }

  return { ok: true };
}

/**
 * Tick-loop routing for an eligible issue. Pure classifier extracted from the
 * orchestrator so the carve-out is unit-testable.
 *
 *   - `dispatch`        — run a turn (a specialist owns the state, OR it's an
 *                         agent-dispatched state that runs the generic WORKFLOW
 *                         envelope, e.g. "To implement").
 *   - `transition_only` — no specialist, no agent-dispatch, but a
 *                         state_transitions edge exists → auto-advance without
 *                         dispatching (e.g. "Ready to deploy" → "PR validation").
 *   - `cascade_only`    — no specialist, no transition, not agent-dispatched →
 *                         visited only so detectAndFireCascades can fire
 *                         (e.g. "Development"); no turn runs on the parent.
 *
 * `isAgentDispatched` wins over both no-specialist skips: that is the whole
 * point of `agent_dispatched_states` — let a no-specialist state reach a turn.
 */
export type TickAction = "dispatch" | "transition_only" | "cascade_only";

export function classifyTickAction(opts: {
  hasSpecialist: boolean;
  hasTransition: boolean;
  isAgentDispatched: boolean;
}): TickAction {
  if (opts.isAgentDispatched) return "dispatch";
  if (opts.hasSpecialist) return "dispatch";
  return opts.hasTransition ? "transition_only" : "cascade_only";
}

/**
 * Cascade-trigger gate: has the issue been *freshly* observed in `next`?
 *
 * `prev` is the last state the poll loop recorded for this issue. A parent that
 * moves from a non-active human gate (e.g. "Plan review (manual)") into a
 * cascade-trigger state was NEVER observed before — `prev` is undefined — so we
 * MUST treat undefined as a fresh transition, or the cascade never fires from a
 * human gate. Only an already-observed same-state (`prev === next`) is stale.
 * The cascade is idempotent, so a redundant fire is a no-op (no duplicate
 * comment when there are no drafted subs).
 */
export function isFreshTransition(prev: string | undefined, next: string): boolean {
  return prev === undefined || prev.toLowerCase() !== next.toLowerCase();
}

/**
 * Spec §8.2 — sort order: priority asc (null last) → created_at oldest first
 * → identifier lexicographic.
 */
export function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort(comparator);
}

function comparator(a: Issue, b: Issue): number {
  const pa = a.priority;
  const pb = b.priority;
  const pNull = pa === null ? 1 : 0;
  const qNull = pb === null ? 1 : 0;
  if (pNull !== qNull) return pNull - qNull;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;

  // Date.parse returns NaN for unparseable strings; guard so the comparator
  // never returns NaN (which produces non-deterministic sort order).
  const caRaw = a.createdAt ? Date.parse(a.createdAt) : Number.POSITIVE_INFINITY;
  const cbRaw = b.createdAt ? Date.parse(b.createdAt) : Number.POSITIVE_INFINITY;
  const ca = Number.isFinite(caRaw) ? caRaw : Number.POSITIVE_INFINITY;
  const cb = Number.isFinite(cbRaw) ? cbRaw : Number.POSITIVE_INFINITY;
  if (ca !== cb) return ca - cb;

  return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
}

/** Spec §8.4 — exponential backoff. Continuation retries are 1s fixed. */
export function computeBackoffMs(args: {
  attempt: number;
  isContinuation: boolean;
  maxBackoffMs: number;
}): number {
  if (args.isContinuation) return 1_000;
  const base = 10_000 * Math.pow(2, Math.max(0, args.attempt - 1));
  return Math.min(base, args.maxBackoffMs);
}
