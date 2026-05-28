import { describe, expect, it } from "vitest";
import { isEligible, sortForDispatch, computeBackoffMs } from "../../src/orchestrator/dispatch.js";
import { createState } from "../../src/orchestrator/state.js";
import type { Issue } from "../../src/types.js";

/**
 * Spec §17.4 — Orchestrator dispatch, reconciliation, retry.
 *
 * The full reconciliation loop is exercised end-to-end in
 * `tests/integration/`; this file covers the deterministic units.
 */

function issue(over: Partial<Issue>): Issue {
  return {
    id: over.id ?? "i1",
    identifier: over.identifier ?? "ABC-1",
    title: over.title ?? "t",
    description: over.description ?? null,
    priority: over.priority ?? null,
    state: over.state ?? "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: over.blockedBy ?? [],
    createdAt: over.createdAt ?? "2026-04-01T00:00:00Z",
    updatedAt: null,
  };
}

describe("§17.4 dispatch sort", () => {
  it("sorts by priority asc, then created_at oldest first, then identifier", () => {
    const out = sortForDispatch([
      issue({ id: "a", identifier: "Z-1", priority: 3, createdAt: "2026-04-01T00:00:00Z" }),
      issue({ id: "b", identifier: "B-1", priority: 1, createdAt: "2026-04-02T00:00:00Z" }),
      issue({ id: "c", identifier: "C-1", priority: 1, createdAt: "2026-04-01T00:00:00Z" }),
      issue({ id: "d", identifier: "D-1", priority: null, createdAt: "2026-03-01T00:00:00Z" }),
    ]);
    expect(out.map((x) => x.identifier)).toEqual(["C-1", "B-1", "Z-1", "D-1"]);
  });
});

describe("§17.4 dispatch eligibility", () => {
  it("rejects issues with non-terminal blockers in Todo", () => {
    const s = createState(30_000, 5);
    const i = issue({
      state: "Todo",
      blockedBy: [{ id: "b", identifier: "B-1", state: "In Progress" }],
    });
    const r = isEligible(i, {
      state: s,
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      perStateLimits: {},
    });
    expect(r.ok).toBe(false);
  });

  it("allows Todo with terminal blockers", () => {
    const s = createState(30_000, 5);
    const i = issue({ state: "Todo", blockedBy: [{ id: "b", identifier: "B-1", state: "Done" }] });
    const r = isEligible(i, {
      state: s,
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      perStateLimits: {},
    });
    expect(r.ok).toBe(true);
  });

  it("rejects when no global slots available", () => {
    const s = createState(30_000, 0);
    const r = isEligible(issue({ state: "Todo" }), {
      state: s,
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      perStateLimits: {},
    });
    expect(r.ok).toBe(false);
  });
});

describe("§17.4 retry backoff", () => {
  it("continuation retries are 1s fixed", () => {
    expect(computeBackoffMs({ attempt: 1, isContinuation: true, maxBackoffMs: 300_000 })).toBe(
      1_000,
    );
    expect(computeBackoffMs({ attempt: 7, isContinuation: true, maxBackoffMs: 300_000 })).toBe(
      1_000,
    );
  });

  it("failure retries are exponential 10s base capped at maxBackoffMs", () => {
    expect(computeBackoffMs({ attempt: 1, isContinuation: false, maxBackoffMs: 300_000 })).toBe(
      10_000,
    );
    expect(computeBackoffMs({ attempt: 2, isContinuation: false, maxBackoffMs: 300_000 })).toBe(
      20_000,
    );
    expect(computeBackoffMs({ attempt: 5, isContinuation: false, maxBackoffMs: 300_000 })).toBe(
      160_000,
    );
    expect(computeBackoffMs({ attempt: 99, isContinuation: false, maxBackoffMs: 300_000 })).toBe(
      300_000,
    );
  });
});
