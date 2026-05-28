import { describe, expect, it, vi } from "vitest";
import { reconcileStalledRuns } from "../../src/orchestrator/reconcile.js";
import { createState } from "../../src/orchestrator/state.js";
import { nowMonotonicMs } from "../../src/lib/time.js";
import type { Issue, RunningEntry } from "../../src/types.js";

/**
 * Regression: reconcileStalledRuns previously compared `Date.now()` to
 * `lastEventMonotonicMs` (process uptime), which is many orders of magnitude
 * smaller — every running worker was treated as stalled. This test ensures
 * a fresh worker (lastEvent set via the same monotonic clock) is NOT flagged.
 */

function fakeIssue(): Issue {
  return {
    id: "i1",
    identifier: "ABC-1",
    title: "t",
    description: null,
    priority: null,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

describe("reconcileStalledRuns clock consistency", () => {
  it("does NOT flag a fresh worker as stalled", async () => {
    const state = createState(30_000, 1);
    const now = nowMonotonicMs();
    const issue = fakeIssue();
    const entry: RunningEntry = {
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
    state.running.set(issue.id, entry);

    const onStall = vi.fn();
    await reconcileStalledRuns({
      state,
      stallTimeoutMs: 60_000,
      onStall,
    });
    expect(onStall).not.toHaveBeenCalled();
  });

  it("flags a worker whose last event is older than stall_timeout_ms", async () => {
    const state = createState(30_000, 1);
    const issue = fakeIssue();
    const now = nowMonotonicMs();
    const entry: RunningEntry = {
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
      startedAtMonotonicMs: now - 999_999,
      lastEventMonotonicMs: now - 999_999,
      abort: async () => undefined,
    };
    state.running.set(issue.id, entry);

    const onStall = vi.fn<(args: { issueId: string; reason: string }) => Promise<void>>(
      async () => undefined,
    );
    await reconcileStalledRuns({
      state,
      stallTimeoutMs: 60_000,
      onStall,
    });
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0]?.[0].issueId).toBe("i1");
  });
});
