import { describe, expect, it } from "vitest";
import { isEligible } from "../../src/orchestrator/dispatch.js";
import { createState, perStateLimit, runningInState } from "../../src/orchestrator/state.js";
import { nowMonotonicMs } from "../../src/lib/time.js";
import type { Issue, RunningEntry } from "../../src/types.js";

/**
 * Regression: `agent.max_concurrent_agents_by_state` was parsed and
 * validated by `config.ts` but never consulted by the dispatch loop. The
 * global `max_concurrent_agents` cap was the only gate, so 3 concurrent
 * Implement-stage Opus turns could burn ~$15/min while cheap stages
 * (Refinement, Plan) ate the budget that should have been theirs.
 *
 * `isEligible` now enforces both gates: the global `availableSlots()`
 * AND the per-state `runningInState(...) >= perStateLimit(...)` check.
 */

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    identifier: "PROJ-1",
    title: "t",
    description: null,
    priority: 2,
    state: "Implement",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: null,
    ...overrides,
  };
}

function makeRunning(issue: Issue): RunningEntry {
  const now = nowMonotonicMs();
  return {
    issue,
    attempt: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: null,
      workspacePath: "/tmp",
      startedAt: Date.now(),
      status: "StreamingTurn",
      error: null,
    },
    session: null,
    startedAtMonotonicMs: now,
    lastEventMonotonicMs: now,
    abort: async () => undefined,
  };
}

const ACTIVE_STATES = ["Refinement", "Plan", "Validate", "Implement", "Open PR", "Polish"];
const TERMINAL_STATES = ["Done", "Canceled"];

// Config keys are lowercased by `normalizeStateMap` in `workflow/config.ts`
// before reaching the dispatch layer, so tests use lowercased keys to mirror
// the runtime contract.
const PER_STATE_MAP: Record<string, number> = {
  refinement: 5,
  plan: 5,
  validate: 1,
  implement: 1,
  "open pr": 2,
  polish: 2,
};

describe("dispatch per-state concurrency", () => {
  it("skips a candidate when the per-state limit is reached", () => {
    const state = createState(30_000, 10);
    // 1 Implement already running; per-state limit is 1.
    const running = makeIssue({ id: "running-1", identifier: "PROJ-100" });
    state.running.set(running.id, makeRunning(running));

    const candidate = makeIssue({ id: "i2", identifier: "PROJ-101" });
    const result = isEligible(candidate, {
      state,
      activeStates: ACTIVE_STATES,
      terminalStates: TERMINAL_STATES,
      perStateLimits: PER_STATE_MAP,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/per-state slot limit reached/i);
  });

  it("respects per-state limit even when global slots are available", () => {
    // Global cap: 10 → plenty of headroom. Per-state cap on Implement: 1.
    // The per-state gate must still kick in.
    const state = createState(30_000, 10);
    const running = makeIssue({ id: "running-1", identifier: "PROJ-100" });
    state.running.set(running.id, makeRunning(running));

    const candidate = makeIssue({ id: "i2", identifier: "PROJ-101" });
    const result = isEligible(candidate, {
      state,
      activeStates: ACTIVE_STATES,
      terminalStates: TERMINAL_STATES,
      perStateLimits: PER_STATE_MAP,
    });
    expect(result.ok).toBe(false);
    // Sanity: per-state, not global.
    expect(runningInState(state, "Implement")).toBe(1);
    expect(perStateLimit(state, PER_STATE_MAP, "Implement")).toBe(1);
  });

  it("allows a candidate in a different (cheap) state to proceed concurrently", () => {
    const state = createState(30_000, 10);
    // Saturate Implement (1/1)…
    const impl = makeIssue({ id: "running-impl", identifier: "PROJ-100" });
    state.running.set(impl.id, makeRunning(impl));

    // …but a Refinement candidate has 5 slots; should be eligible.
    const refinement = makeIssue({
      id: "i2",
      identifier: "PROJ-200",
      state: "Refinement",
    });
    const result = isEligible(refinement, {
      state,
      activeStates: ACTIVE_STATES,
      terminalStates: TERMINAL_STATES,
      perStateLimits: PER_STATE_MAP,
    });
    expect(result.ok).toBe(true);
  });

  it("falls back to the global cap when the state is missing from the map", () => {
    const state = createState(30_000, 3);
    // Nothing running yet for "Investigate"; map has no entry → fallback to
    // global cap (3). Verify both the helper and the eligibility gate agree.
    expect(perStateLimit(state, PER_STATE_MAP, "Investigate")).toBe(3);

    const candidate = makeIssue({
      id: "i2",
      identifier: "PROJ-300",
      state: "Investigate",
    });
    const result = isEligible(candidate, {
      state,
      activeStates: [...ACTIVE_STATES, "Investigate"],
      terminalStates: TERMINAL_STATES,
      perStateLimits: PER_STATE_MAP,
    });
    expect(result.ok).toBe(true);
  });

  it("uses the global cap as fallback even when running count is high in that state", () => {
    // No per-state entry for "Test"; global cap is 2. Two are running → next
    // candidate must be rejected by the per-state gate (which folds in the
    // fallback) rather than slipping through.
    const state = createState(30_000, 2);
    const r1 = makeIssue({ id: "r1", identifier: "PROJ-400", state: "Test" });
    const r2 = makeIssue({ id: "r2", identifier: "PROJ-401", state: "Test" });
    state.running.set(r1.id, makeRunning(r1));
    state.running.set(r2.id, makeRunning(r2));

    const candidate = makeIssue({
      id: "i3",
      identifier: "PROJ-402",
      state: "Test",
    });
    const result = isEligible(candidate, {
      state,
      activeStates: [...ACTIVE_STATES, "Test"],
      terminalStates: TERMINAL_STATES,
      perStateLimits: PER_STATE_MAP, // no "test" key
    });
    expect(result.ok).toBe(false);
    // The global gate fires first (no slots), but the per-state fallback
    // would also fire — both invariants hold.
    expect(result.reason).toMatch(/no global slots|per-state slot limit/i);
  });

  it("honors per-state limit across continuation turns (running set tracks state)", () => {
    // A continuation turn re-enters dispatch via `onRetryFire`. The running
    // set is the source of truth for state, so even if the same issue
    // continues, a *different* issue in the same state must still be
    // blocked while the running one occupies the per-state slot.
    const state = createState(30_000, 10);
    const continuing = makeIssue({ id: "cont-1", identifier: "PROJ-500" });
    state.running.set(continuing.id, makeRunning(continuing));

    expect(runningInState(state, "Implement")).toBe(1);
    expect(perStateLimit(state, PER_STATE_MAP, "Implement")).toBe(1);

    const sibling = makeIssue({ id: "i2", identifier: "PROJ-501" });
    const result = isEligible(sibling, {
      state,
      activeStates: ACTIVE_STATES,
      terminalStates: TERMINAL_STATES,
      perStateLimits: PER_STATE_MAP,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/per-state slot limit reached/i);
  });

  it("matches state name case-insensitively", () => {
    // Linear states are mixed-case ("Open PR"). The lookup must lowercase
    // both sides — `isEligible` already does, but pin it down.
    const state = createState(30_000, 10);
    const running = makeIssue({
      id: "r1",
      identifier: "PROJ-600",
      state: "Open PR",
    });
    state.running.set(running.id, makeRunning(running));
    const r2 = makeIssue({
      id: "r2",
      identifier: "PROJ-601",
      state: "Open PR",
    });
    state.running.set(r2.id, makeRunning(r2));

    const candidate = makeIssue({
      id: "i3",
      identifier: "PROJ-602",
      state: "Open PR",
    });
    const result = isEligible(candidate, {
      state,
      activeStates: ACTIVE_STATES,
      terminalStates: TERMINAL_STATES,
      perStateLimits: PER_STATE_MAP, // "open pr": 2
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/per-state slot limit reached/i);
  });
});
