import { describe, expect, it } from "vitest";
import { MemoryTracker } from "../../src/tracker/memory.js";
import { isAgentToolProvider } from "../../src/agent/agent-tool-provider.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";
import type { Issue } from "../../src/types.js";

/**
 * Phase A — tracker seam. Contract for the in-memory `IssueTracker`
 * implementation (`MemoryTracker`) that lets a full poll→dispatch→
 * transition→reconcile cycle run with no Linear.
 *
 * These tests pin the BEHAVIOR the orchestrator + cascade modules rely on:
 *   - reads reflect prior writes (state transitions, posted comments)
 *   - sub-issue decomposition is observable (child under parent, inherited
 *     labels, resolved team)
 *   - MemoryTracker is NOT an AgentToolProvider (no agent GraphQL tooling)
 *
 * Authored before any implementation exists — expected RED.
 */

function seedIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "MEM-1",
    title: overrides.title ?? "Seed issue",
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? "Active",
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? "2026-06-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? null,
  };
}

describe("MemoryTracker — IssueTracker conformance", () => {
  it("is assignable to the IssueTracker interface (structural contract)", () => {
    // If MemoryTracker doesn't implement every IssueTracker method this
    // assignment is a compile error — that's the falsifiable part.
    const tracker: IssueTracker = new MemoryTracker([seedIssue()]);
    expect(typeof tracker.fetchCandidateIssues).toBe("function");
    expect(typeof tracker.fetchIssuesByStates).toBe("function");
    expect(typeof tracker.fetchIssueStatesByIds).toBe("function");
    expect(typeof tracker.fetchIssueDescriptionById).toBe("function");
    expect(typeof tracker.fetchIssueComments).toBe("function");
    expect(typeof tracker.fetchSubstantiveComments).toBe("function");
    expect(typeof tracker.createComment).toBe("function");
    expect(typeof tracker.transitionIssueToState).toBe("function");
    expect(typeof tracker.fetchChildIssues).toBe("function");
    expect(typeof tracker.fetchViewerId).toBe("function");
    expect(typeof tracker.getViewerId).toBe("function");
    expect(typeof tracker.invalidateTeamStatesCache).toBe("function");
  });

  it("constructs with seed issues and returns them by active state", async () => {
    const tracker = new MemoryTracker([
      seedIssue({ id: "a", identifier: "MEM-1", state: "Active" }),
      seedIssue({ id: "b", identifier: "MEM-2", state: "Done" }),
    ]);
    const active = await tracker.fetchCandidateIssues(["Active"]);
    expect(active.map((i: Issue) => i.identifier)).toEqual(["MEM-1"]);
  });

  it("fetchIssuesByStates returns only issues in the requested states", async () => {
    const tracker = new MemoryTracker([
      seedIssue({ id: "a", identifier: "MEM-1", state: "Active" }),
      seedIssue({ id: "b", identifier: "MEM-2", state: "Done" }),
      seedIssue({ id: "c", identifier: "MEM-3", state: "Error" }),
    ]);
    const out = await tracker.fetchIssuesByStates(["Done", "Error"]);
    expect(out.map((i: Issue) => i.identifier).sort()).toEqual(["MEM-2", "MEM-3"]);
  });
});

describe("MemoryTracker — bullet 4: writes are observable via subsequent reads", () => {
  it("reflects a state transition in a subsequent fetchIssueStatesByIds read", async () => {
    const tracker = new MemoryTracker([seedIssue({ id: "a", identifier: "MEM-1", state: "Active" })]);

    const before = await tracker.fetchIssueStatesByIds(["a"]);
    expect(before[0]?.state).toBe("Active");

    const res = await tracker.transitionIssueToState("a", "Done");
    expect(res).toEqual({ identifier: "MEM-1", state: "Done" });

    const after = await tracker.fetchIssueStatesByIds(["a"]);
    expect(after[0]?.state).toBe("Done");
  });

  it("a posted comment is visible in a subsequent fetchIssueComments read", async () => {
    const tracker = new MemoryTracker([seedIssue({ id: "a", identifier: "MEM-1" })]);

    expect(await tracker.fetchIssueComments("a")).toEqual([]);

    const posted = await tracker.createComment("a", "first deliverable");
    expect(posted).not.toBeNull();

    const comments = await tracker.fetchIssueComments("a");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toBe("first deliverable");
  });

  it("transitionIssueToState mutates the same record fetchCandidateIssues returns", async () => {
    // Falsifiable: if the transition wrote to a copy, the candidate poll
    // would still surface the issue under the old active state.
    const tracker = new MemoryTracker([seedIssue({ id: "a", identifier: "MEM-1", state: "Active" })]);
    await tracker.transitionIssueToState("a", "Done");
    const stillActive = await tracker.fetchCandidateIssues(["Active"]);
    expect(stillActive).toEqual([]);
  });
});

describe("MemoryTracker — bullet 5: sub-issue decomposition is observable", () => {
  it("a created child appears under its parent with inherited labels and resolved team", async () => {
    const tracker = new MemoryTracker([
      seedIssue({
        id: "parent",
        identifier: "MEM-1",
        labels: ["area:billing", "kind:bug"],
      }),
    ]);
    const teamId = tracker.getTeamId();
    expect(teamId).not.toBeNull();

    // Mirror the orchestrator's sub-ticketing path: resolve the parent's
    // normalized labels into ids, then create the child with those ids.
    const labelIds = await tracker.resolveLabelIds(["area:billing", "kind:bug"]);
    const created = await tracker.createIssue({
      teamId: teamId as string,
      title: "Child A",
      description: "scope",
      parentId: "parent",
      priority: null,
      labelIds,
    });
    expect(created.identifier).toBeTruthy();

    const children = await tracker.fetchChildIssues("parent");
    expect(children).toHaveLength(1);
    const childStub = children[0]!;
    expect(childStub.identifier).toBe(created.identifier);
    expect(childStub.title).toBe("Child A");

    // The child carries the parent's labels (inheritance). Read these back
    // through the full-issue view keyed by the child's id. The resolved team
    // is observable as the same team the tracker reports via getTeamId()
    // (createIssue was given that id and accepted it without error).
    const full = await tracker.fetchIssuesByStates([childStub.state]);
    const child = full.find((i: Issue) => i.id === created.id);
    expect(child).toBeDefined();
    expect(child?.labels.slice().sort()).toEqual(["area:billing", "kind:bug"]);
  });

  it("a parent with no children returns an empty child list", async () => {
    const tracker = new MemoryTracker([seedIssue({ id: "lonely", identifier: "MEM-9" })]);
    expect(await tracker.fetchChildIssues("lonely")).toEqual([]);
  });
});

describe("MemoryTracker — provides NO agent tooling", () => {
  it("is NOT an AgentToolProvider", () => {
    const tracker = new MemoryTracker([seedIssue()]);
    expect(isAgentToolProvider(tracker)).toBe(false);
  });
});
