import { describe, expect, it } from "vitest";

import {
  type DeliverableSource,
  MemoryDeliverableSource,
} from "../../src/lib/deliverable-source.js";
import { branchMatchesIdentifier, type GithubBranchSummary } from "../../src/lib/github.js";
import type { Issue } from "../../src/types.js";

/**
 * Phase D — `DeliverableSource` contract (behavior 1).
 *
 * The deliverable gate decides whether to let an issue auto-advance out of a
 * `pr_required` state by asking GitHub whether a branch / PR exists for the
 * issue identifier. Phase D introduces `DeliverableSource` so the gate reads
 * that data from an injectable seam instead of calling the module-level
 * `fetchBranches` / `fetchPullRequestForIssue` directly.
 *
 * These tests pin the SCRIPTED side of the seam (`MemoryDeliverableSource`):
 *   - constructed with in-memory branches / PRs, NO token, NO network;
 *   - presence is decided with the SAME pure `branchMatchesIdentifier`
 *     util the real GitHub-backed gate uses (the util stays a free function,
 *     NOT a method on the interface);
 *   - a scripted branch/PR that matches the issue identifier => deliverable
 *     present (gate Succeeded / advance allowed); none => deliverable absent
 *     (gate Failed / advance blocked).
 *
 * We assert the OUTCOME the gate would record — present vs absent — given a
 * scripted source, identically to the GitHub-backed path. The gate logic is
 * unchanged; only its data source is injected.
 */

function fakeIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "issue-441",
    identifier: "AGENT-441",
    title: "Test ticket",
    description: null,
    priority: null,
    state: "Validate",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function branch(name: string, sha = "deadbeef"): GithubBranchSummary {
  return { name, sha };
}

/**
 * The deliverable-present predicate, expressed in terms of the PUBLIC seam.
 * This mirrors the orchestrator's real gate decision:
 *
 *     branches.some((b) => branchMatchesIdentifier(b.name, issue.identifier))
 *
 * — but reads the branches from an injected `DeliverableSource` instead of
 * the module-level `fetchBranches`. A `true` result is what the gate records
 * as "deliverable present" => advance allowed => the turn's Succeeded stands.
 * A `false` result is what the gate records as a miss => advance blocked.
 *
 * `null` propagates "couldn't tell" (fail-open) straight through.
 */
async function deliverablePresent(
  source: DeliverableSource,
  issue: Issue,
): Promise<boolean | null> {
  const branches = await source.fetchBranches();
  if (branches === null) return null;
  return branches.some((b: GithubBranchSummary) =>
    branchMatchesIdentifier(b.name, issue.identifier),
  );
}

describe("MemoryDeliverableSource — branch presence (behavior 1)", () => {
  it("reports a matching scripted branch as present (gate => Succeeded / allowed)", async () => {
    const issue = fakeIssue({ identifier: "AGENT-441" });
    const source = new MemoryDeliverableSource({
      branches: [branch("main"), branch("symphony/agent-441")],
    });

    expect(await deliverablePresent(source, issue)).toBe(true);
  });

  it("reports NO matching branch as absent (gate => Failed / blocked)", async () => {
    const issue = fakeIssue({ identifier: "AGENT-441" });
    const source = new MemoryDeliverableSource({
      branches: [branch("main"), branch("symphony/agent-999"), branch("hotfix/login")],
    });

    expect(await deliverablePresent(source, issue)).toBe(false);
  });

  it("reports an empty scripted branch list as absent", async () => {
    const issue = fakeIssue();
    const source = new MemoryDeliverableSource({ branches: [] });

    expect(await deliverablePresent(source, issue)).toBe(false);
  });

  it("matches identically to the GitHub-backed path for the canonical and legacy patterns", async () => {
    // The presence decision is the pure util reused over scripted data, so
    // every pattern the real gate accepts must read present here too.
    const cases: Array<{ identifier: string; branchName: string }> = [
      { identifier: "AGENT-441", branchName: "symphony/agent-441" },
      { identifier: "AGENT-441", branchName: "symphony/agent-441-add-retry" },
      { identifier: "AGENT-441", branchName: "agent-441" },
      { identifier: "AGENT-441", branchName: "agent-441-fix" },
      { identifier: "AGENT-441", branchName: "feat/agent-441-thing/wip" },
      { identifier: "STG-17", branchName: "linear-suggested-stg-17-branch" },
    ];
    for (const { identifier, branchName } of cases) {
      const source = new MemoryDeliverableSource({ branches: [branch(branchName)] });
      const present = await deliverablePresent(source, fakeIssue({ identifier }));
      expect(present, `${branchName} should match ${identifier}`).toBe(true);
    }
  });

  it("does NOT mutate or own the identifier match logic — branchMatchesIdentifier stays a free util", () => {
    // Falsifiable guard: the matcher is a standalone export, not a method on
    // the interface. If a future refactor moves it onto DeliverableSource,
    // this import-and-call breaks.
    expect(branchMatchesIdentifier("symphony/agent-441", "AGENT-441")).toBe(true);
    expect(branchMatchesIdentifier("main", "AGENT-441")).toBe(false);
    const source = new MemoryDeliverableSource({ branches: [] });
    expect(
      (source as unknown as Record<string, unknown>).branchMatchesIdentifier,
    ).toBeUndefined();
  });
});

describe("MemoryDeliverableSource — fail-open passthrough", () => {
  it("propagates a scripted null branch result as 'couldn't tell' (fail open)", async () => {
    // The memory source can simulate the GitHub-backed null (no token /
    // transient 5xx) so the gate's fail-open branch is exercisable without
    // the network.
    const source = new MemoryDeliverableSource({ branches: null });
    expect(await source.fetchBranches()).toBeNull();
    expect(await deliverablePresent(source, fakeIssue())).toBeNull();
  });
});

describe("MemoryDeliverableSource — PR for issue (behavior 1, Release-stage path)", () => {
  it("returns the scripted PR matching the issue identifier", async () => {
    const source = new MemoryDeliverableSource({
      branches: [],
      prsByIssue: {
        "STG-42": {
          number: 42,
          mergedAt: "2026-05-07T18:00:00Z",
          state: "closed",
          headRefOid: "abc123",
          htmlUrl: "https://github.com/o/r/pull/42",
        },
      },
    });

    const pr = await source.fetchPullRequestForIssue("STG-42");
    expect(pr).not.toBeNull();
    expect(pr).not.toBeUndefined();
    expect(pr!.number).toBe(42);
    expect(pr!.mergedAt).toBe("2026-05-07T18:00:00Z");
    expect(pr!.state).toBe("closed");
  });

  it("returns null when no scripted PR matches the identifier (caller bounces)", async () => {
    const source = new MemoryDeliverableSource({
      branches: [],
      prsByIssue: {
        "STG-42": {
          number: 42,
          mergedAt: null,
          state: "open",
          headRefOid: "def456",
          htmlUrl: "https://github.com/o/r/pull/42",
        },
      },
    });

    expect(await source.fetchPullRequestForIssue("STG-99")).toBeNull();
  });

  it("returns undefined when scripted as inconclusive (transient => fail open)", async () => {
    // `undefined` is the GitHub-backed "API failure" signal the gate treats
    // as fail-open; the memory source can script it per identifier.
    const source = new MemoryDeliverableSource({
      branches: [],
      prsByIssue: { "STG-17": undefined },
    });

    expect(await source.fetchPullRequestForIssue("STG-17")).toBeUndefined();
  });
});
