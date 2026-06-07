import { describe, expect, it } from "vitest";
import { classifyTickAction, isFreshTransition } from "../../src/orchestrator/dispatch.js";

/**
 * Pure routing predicates extracted from the orchestrator tick loop so the
 * M3 "agent-dispatched state" carve-out and the cascade-trigger fix are
 * unit-testable without booting the orchestrator.
 */

describe("classifyTickAction (agent-dispatched carve-out)", () => {
  it("specialist-owned state → dispatch", () => {
    expect(
      classifyTickAction({ hasSpecialist: true, hasTransition: false, isAgentDispatched: false }),
    ).toBe("dispatch");
  });

  it("no specialist + no transition + NOT agent-dispatched → cascade_only (e.g. Development)", () => {
    expect(
      classifyTickAction({ hasSpecialist: false, hasTransition: false, isAgentDispatched: false }),
    ).toBe("cascade_only");
  });

  it("no specialist + transition + NOT agent-dispatched → transition_only", () => {
    expect(
      classifyTickAction({ hasSpecialist: false, hasTransition: true, isAgentDispatched: false }),
    ).toBe("transition_only");
  });

  it("agent-dispatched + no specialist + no transition → dispatch (THE carve-out: To implement)", () => {
    expect(
      classifyTickAction({ hasSpecialist: false, hasTransition: false, isAgentDispatched: true }),
    ).toBe("dispatch");
  });

  it("agent-dispatched wins even when a transition exists (still dispatch, not auto-advance)", () => {
    expect(
      classifyTickAction({ hasSpecialist: false, hasTransition: true, isAgentDispatched: true }),
    ).toBe("dispatch");
  });
});

describe("isFreshTransition (cascade-trigger gate)", () => {
  it("undefined prev (parent came from a non-active human gate) → fresh (FIX)", () => {
    // The bug: a `Plan review (manual) → Development` move is invisible to the
    // poll loop, so prev is undefined. This MUST count as a transition.
    expect(isFreshTransition(undefined, "Development")).toBe(true);
  });

  it("different prior state → fresh", () => {
    expect(isFreshTransition("Plan review (manual)", "Development")).toBe(true);
  });

  it("same observed state → NOT fresh (no re-fire)", () => {
    expect(isFreshTransition("Development", "Development")).toBe(false);
  });

  it("same state, different case → NOT fresh (case-insensitive)", () => {
    expect(isFreshTransition("development", "Development")).toBe(false);
  });
});
