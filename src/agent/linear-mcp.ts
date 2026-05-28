/**
 * In-process `linear_graphql` MCP server (A-12 / S-D10 — spec §10.5).
 *
 * Exposes a single tool `linear_graphql({query, variables?})` that runs a
 * Linear GraphQL operation using Symphony's configured tracker auth. The
 * agent never reads raw `LINEAR_API_KEY`; this server runs in-process so
 * spec §10.5's "Symphony's configured tracker auth" mandate is satisfied
 * without spawning a subprocess or shipping the key into the agent's
 * environment.
 *
 * Wired into the agent's MCP servers map by `agent/mcp-config.ts`. We
 * delegate to the Claude Agent SDK's `createSdkMcpServer` helper so the
 * returned `{ type: "sdk", name, instance }` value is a REAL `McpServer`
 * instance with the `.connect()` method the SDK calls during query setup
 * — building a custom shape ourselves crashes with
 * `server.connect is not a function` (observed on AGENT-485 first deploy
 * 2026-05-04).
 */

import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { LinearTrackerClient } from "../tracker/linear.js";
import { logger } from "../observability/logger.js";

/**
 * Tool input — exactly one operation per call per spec §10.5.
 *
 * Exposed as a Zod RAW SHAPE (object of field schemas), NOT a wrapped
 * `z.object({...})`, because the underlying MCP `server.tool()` signature
 * expects the shape so it can derive a JSON schema for the model's
 * tool-spec.
 */
const linearGraphqlInputShape = {
  query: z
    .string()
    .min(1)
    .describe(
      "GraphQL query or mutation document. Must contain exactly one operation. Use Linear's GraphQL schema; see https://linear.app/developers/graphql for reference.",
    ),
  variables: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional variables map for the GraphQL operation."),
} as const;

/** Re-validated Zod schema for runtime input parsing inside the handler. */
const linearGraphqlSchema = z.object(linearGraphqlInputShape);

/**
 * Build the in-process MCP server. Returns the Claude Agent SDK's
 * `{ type: "sdk", name, instance }` envelope directly — callers (e.g.
 * `agent/mcp-config.ts`) drop it into the SDK's `mcpServers` option as-is.
 */
export function buildLinearMcpServer(
  tracker: LinearTrackerClient,
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: "linear",
    version: "1.0.0",
    tools: [
      tool(
        "linear_graphql",
        "Run a raw Linear GraphQL query or mutation using Symphony's configured tracker authentication. Returns the parsed `data` field on success. One GraphQL operation per call. Top-level GraphQL errors surface as a structured failure with the original error array.",
        linearGraphqlInputShape,
        async (input: unknown) => {
          const parsed = linearGraphqlSchema.safeParse(input);
          if (!parsed.success) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error: {
                      code: "invalid_input",
                      message: parsed.error.errors.map((e) => e.message).join("; "),
                    },
                  }),
                },
              ],
            };
          }
          const { query, variables } = parsed.data;
          try {
            const data = await tracker.runGraphqlForAgent(query, variables ?? {});
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ success: true, data }),
                },
              ],
            };
          } catch (err) {
            const e = err as { code?: string; message?: string };
            logger.warn({ err: e.message, code: e.code }, "linear_graphql tool call failed");
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error: {
                      code: e.code ?? "linear_unknown_payload",
                      message: e.message ?? String(err),
                    },
                  }),
                },
              ],
            };
          }
        },
      ),
    ],
  });
}
