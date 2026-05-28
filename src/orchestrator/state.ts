import type { OrchestratorState } from "../types.js";

/** Spec §4.1.8 — bootstrap an empty in-memory orchestrator state. */
export function createState(
  pollIntervalMs: number,
  maxConcurrentAgents: number,
): OrchestratorState {
  return {
    pollIntervalMs,
    maxConcurrentAgents,
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      secondsRunning: 0,
      costUsd: 0,
    },
    rateLimits: null,
  };
}

/** Spec §8.3 — global available slot count. */
export function availableSlots(state: OrchestratorState): number {
  return Math.max(0, state.maxConcurrentAgents - state.running.size);
}

/**
 * Spec §8.3 — per-state limit lookup.
 *
 * `perStateMap` keys MUST already be lowercased (the workflow config layer
 * normalizes them in `normalizeStateMap` before reaching here). The lookup
 * lowercases `stateName` to match.
 */
export function perStateLimit(
  state: OrchestratorState,
  perStateMap: Record<string, number>,
  stateName: string,
): number {
  return perStateMap[stateName.toLowerCase()] ?? state.maxConcurrentAgents;
}

/** Count running issues currently in `stateName`. */
export function runningInState(state: OrchestratorState, stateName: string): number {
  let n = 0;
  const lower = stateName.toLowerCase();
  for (const entry of state.running.values()) {
    if (entry.issue.state.toLowerCase() === lower) n++;
  }
  return n;
}
