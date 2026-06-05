import { describe, expect, it } from "vitest";
import { isAgentToolProvider } from "../../src/agent/agent-tool-provider.js";
import { MemoryTracker } from "../../src/tracker/memory.js";
import { buildMcpServers } from "../../src/agent/mcp-config.js";
import type { Issue } from "../../src/types.js";

/**
 * Phase A — tracker seam, bullet 6.
 *
 * Agent GraphQL tooling moves behind the `AgentToolProvider` interface. The
 * `linear_graphql` in-process MCP server is registered ONLY when the tracker
 * passed to the MCP builder satisfies `isAgentToolProvider`. A tracker that
 * provides no agent tooling (MemoryTracker) causes the tool to be omitted —
 * with no error raised.
 *
 * Authored before any implementation exists — expected RED.
 */

function seedIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "MEM-1",
    title: "Seed",
    description: null,
    priority: null,
    state: overrides.state ?? "Active",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: null,
  };
}

/**
 * A minimal object that DOES provide agent tooling — exposes the
 * `runGraphqlForAgent` capability the in-process linear_graphql tool needs.
 * Used to prove the positive branch of the guard + the builder.
 */
function fakeAgentToolProvider(): unknown {
  return {
    runGraphqlForAgent: async () => ({ data: {} }),
  };
}

describe("isAgentToolProvider type guard", () => {
  it("returns true for an object exposing runGraphqlForAgent", () => {
    expect(isAgentToolProvider(fakeAgentToolProvider())).toBe(true);
  });

  it("returns false for a MemoryTracker (no agent tooling)", () => {
    expect(isAgentToolProvider(new MemoryTracker([seedIssue()]))).toBe(false);
  });

  it("returns false for plain objects, null, and undefined", () => {
    expect(isAgentToolProvider({})).toBe(false);
    expect(isAgentToolProvider(null)).toBe(false);
    expect(isAgentToolProvider(undefined)).toBe(false);
    // Present-but-not-callable must not satisfy the guard.
    expect(isAgentToolProvider({ runGraphqlForAgent: "not a function" })).toBe(false);
  });
});

describe("buildMcpServers — linear_graphql gating on AgentToolProvider", () => {
  it("OMITS linear_graphql when the tracker provides no agent tooling (MemoryTracker)", async () => {
    const tracker = new MemoryTracker([seedIssue()]);
    // Must not throw, and must not register the in-process Linear tool.
    const out = await buildMcpServers({
      env: {},
      skipGithub: true,
      tracker,
    });
    expect(out.linear_graphql).toBeUndefined();
  });

  it("registers linear_graphql when the tracker satisfies isAgentToolProvider", async () => {
    const tracker = fakeAgentToolProvider();
    const out = await buildMcpServers({
      env: {},
      skipGithub: true,
      // Cast through unknown: the builder accepts any IssueTracker; only
      // those satisfying isAgentToolProvider get the in-process tool wired.
      tracker: tracker as never,
    });
    expect(out.linear_graphql).toBeDefined();
  });

  it("does not throw when no tracker is passed at all", async () => {
    const out = await buildMcpServers({ env: {}, skipGithub: true });
    expect(out.linear_graphql).toBeUndefined();
  });
});
