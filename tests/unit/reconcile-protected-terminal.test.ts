import { describe, expect, it, vi } from "vitest";
import { reconcileTrackerStates } from "../../src/orchestrator/reconcile.js";
import { createState } from "../../src/orchestrator/state.js";
import { nowMonotonicMs } from "../../src/lib/time.js";
import type { Issue, RunningEntry } from "../../src/types.js";

/**
 * 2026-05-07 — Release-cancellation conflict regression.
 *
 * Before this fix the reconciler would observe `state === "Done"` (set by
 * Linear's native GitHub `merge → Done` automation right after the Release
 * specialist's `gh pr merge --squash` call) and immediately cancel the still-
 * running worker via `onTerminal({ cleanup: true })`. That clobbered the
 * worker's `## Release report` write, audit-row cost capture, and graceful
 * stage-transition handoff — every Release run was double-rowed in
 * `symphony.run_audit` (one Succeeded + one CanceledByReconciliation).
 *
 * The fix lets the orchestrator pass an `isProtectedTerminalIssue` predicate;
 * the reconciler skips the cancellation for one tick when that returns true.
 *
 * These tests cover four cases:
 *   1. Predicate returns true → cancellation IS skipped + state refresh occurs.
 *   2. Predicate returns false → cancellation fires (status quo).
 *   3. Predicate is undefined → cancellation fires (status quo, backward compat).
 *   4. Predicate throws → fall through to cancellation (fail-safe).
 */

function fakeIssue(state: string): Issue {
  return {
    id: "issue-id-1",
    identifier: "STG-1",
    title: "Some sub-issue",
    description: null,
    priority: null,
    state,
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function fakeRunningEntry(issue: Issue): RunningEntry {
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

describe("reconcileTrackerStates — Release-cancellation conflict guard", () => {
  it("skips terminal cancellation when isProtectedTerminalIssue returns true", async () => {
    const state = createState(30_000, 1);
    const inMemory = fakeIssue("Release");
    const fresh = fakeIssue("Done"); // Linear flipped state mid-flight
    state.running.set(inMemory.id, fakeRunningEntry(inMemory));

    const onTerminal = vi.fn<(args: { issueId: string; cleanup: boolean }) => Promise<void>>(
      async () => undefined,
    );
    const isProtectedTerminalIssue = vi.fn<(issueId: string) => boolean | Promise<boolean>>(
      () => true,
    );

    await reconcileTrackerStates({
      state,
      tracker: { fetchIssueStatesByIds: async () => [fresh] },
      activeStates: ["Release"],
      terminalStates: ["Done", "Canceled", "Duplicate"],
      onTerminal,
      isProtectedTerminalIssue,
    });

    expect(isProtectedTerminalIssue).toHaveBeenCalledTimes(1);
    expect(isProtectedTerminalIssue).toHaveBeenCalledWith(inMemory.id);
    expect(onTerminal).not.toHaveBeenCalled();
    // The protected-skip path also refreshes the in-memory issue state so
    // the next tick sees the truth.
    expect(state.running.get(inMemory.id)?.issue.state).toBe("Done");
  });

  it("cancels normally when isProtectedTerminalIssue returns false", async () => {
    const state = createState(30_000, 1);
    const inMemory = fakeIssue("Plan");
    const fresh = fakeIssue("Done");
    state.running.set(inMemory.id, fakeRunningEntry(inMemory));

    const onTerminal = vi.fn<(args: { issueId: string; cleanup: boolean }) => Promise<void>>(
      async () => undefined,
    );
    const isProtectedTerminalIssue = vi.fn<(issueId: string) => boolean | Promise<boolean>>(
      () => false,
    );

    await reconcileTrackerStates({
      state,
      tracker: { fetchIssueStatesByIds: async () => [fresh] },
      activeStates: ["Plan"],
      terminalStates: ["Done", "Canceled", "Duplicate"],
      onTerminal,
      isProtectedTerminalIssue,
    });

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith({ issueId: inMemory.id, cleanup: true });
  });

  it("cancels normally when isProtectedTerminalIssue is undefined (backward compat)", async () => {
    const state = createState(30_000, 1);
    const inMemory = fakeIssue("Plan");
    const fresh = fakeIssue("Done");
    state.running.set(inMemory.id, fakeRunningEntry(inMemory));

    const onTerminal = vi.fn<(args: { issueId: string; cleanup: boolean }) => Promise<void>>(
      async () => undefined,
    );

    await reconcileTrackerStates({
      state,
      tracker: { fetchIssueStatesByIds: async () => [fresh] },
      activeStates: ["Plan"],
      terminalStates: ["Done", "Canceled", "Duplicate"],
      onTerminal,
    });

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith({ issueId: inMemory.id, cleanup: true });
  });

  it("falls through to cancellation when isProtectedTerminalIssue throws (fail-safe)", async () => {
    const state = createState(30_000, 1);
    const inMemory = fakeIssue("Release");
    const fresh = fakeIssue("Done");
    state.running.set(inMemory.id, fakeRunningEntry(inMemory));

    const onTerminal = vi.fn<(args: { issueId: string; cleanup: boolean }) => Promise<void>>(
      async () => undefined,
    );
    const isProtectedTerminalIssue = vi.fn<(issueId: string) => boolean | Promise<boolean>>(
      () => {
        throw new Error("metadata lookup failed");
      },
    );

    await reconcileTrackerStates({
      state,
      tracker: { fetchIssueStatesByIds: async () => [fresh] },
      activeStates: ["Release"],
      terminalStates: ["Done", "Canceled", "Duplicate"],
      onTerminal,
      isProtectedTerminalIssue,
    });

    expect(isProtectedTerminalIssue).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith({ issueId: inMemory.id, cleanup: true });
  });

  it("supports an async isProtectedTerminalIssue predicate", async () => {
    const state = createState(30_000, 1);
    const inMemory = fakeIssue("Release");
    const fresh = fakeIssue("Done");
    state.running.set(inMemory.id, fakeRunningEntry(inMemory));

    const onTerminal = vi.fn<(args: { issueId: string; cleanup: boolean }) => Promise<void>>(
      async () => undefined,
    );
    const isProtectedTerminalIssue = vi.fn<(issueId: string) => Promise<boolean>>(
      async () => true,
    );

    await reconcileTrackerStates({
      state,
      tracker: { fetchIssueStatesByIds: async () => [fresh] },
      activeStates: ["Release"],
      terminalStates: ["Done", "Canceled", "Duplicate"],
      onTerminal,
      isProtectedTerminalIssue,
    });

    expect(isProtectedTerminalIssue).toHaveBeenCalledTimes(1);
    expect(onTerminal).not.toHaveBeenCalled();
  });
});
