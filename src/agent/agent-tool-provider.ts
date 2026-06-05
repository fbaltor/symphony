/**
 * Agent GraphQL tooling capability (decision 1c — zero-dep E2E plan §5).
 *
 * Spec §10.5's in-process `linear_graphql` tool needs a way to run a raw
 * tracker GraphQL operation using Symphony's configured auth. That capability
 * is tracker-specific (Linear today) and pulls in MCP/SDK types — so it lives
 * on this separate `AgentToolProvider` interface rather than on the core
 * `IssueTracker` interface, which stays free of MCP/SDK concerns.
 *
 * `LinearTrackerClient` satisfies this interface (it already exposes
 * `runGraphqlForAgent`); `MemoryTracker` deliberately does NOT — a tracker
 * with no agent tooling causes the `linear_graphql` tool to be omitted (see
 * `agent/mcp-config.ts`).
 */

export interface AgentToolProvider {
  /**
   * Run a raw tracker GraphQL operation using Symphony's configured tracker
   * auth. Backs the in-process `linear_graphql` agent tool so the agent never
   * reads raw credentials. One operation per call (spec §10.5).
   */
  runGraphqlForAgent<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T>;
}

/**
 * Structural type guard: an `AgentToolProvider` is anything exposing a
 * CALLABLE `runGraphqlForAgent`. A present-but-non-function property does not
 * satisfy the guard — the gate in `buildMcpServers` must not register the tool
 * against a value it can't actually invoke.
 */
export function isAgentToolProvider(x: unknown): x is AgentToolProvider {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { runGraphqlForAgent?: unknown }).runGraphqlForAgent === "function"
  );
}
