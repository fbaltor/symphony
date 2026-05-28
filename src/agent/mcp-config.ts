import { logger } from "../observability/logger.js";
import { getInstallationToken } from "../lib/github-auth.js";
import { buildLinearMcpServer } from "./linear-mcp.js";
import type { LinearTrackerClient } from "../tracker/linear.js";

/**
 * MCP server configuration builder.
 *
 * Topology — Linear / GitHub / Notion are first-party hosted MCPs reached
 * via streamable HTTP; Slack / Sentry are stdio servers shipped via npm.
 *
 * Each MCP is registered only when its required env vars are populated;
 * empty / unset / placeholder secrets cause the MCP to be silently skipped.
 */

export type ClaudeMcpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      // A-12 / S-D10: in-process MCP server. The Claude Agent SDK accepts a
      // server instance and dispatches tool calls without spawning a
      // subprocess — used by `linear_graphql` so the agent reuses Symphony's
      // tracker auth. Mirrors the same variant on `ClaudeMcpServerOption`
      // in claude-adapter.ts (the runtime shape this config is forwarded to).
      type: "sdk";
      name: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance: any;
    };

export type ClaudeMcpServers = Record<string, ClaudeMcpServerConfig>;

export interface BuildMcpServersOptions {
  /** Baseline env (process.env in production; injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /** When true, skip GH installation-token mint (tests). */
  skipGithub?: boolean;
  /**
   * A-12: when set, attaches the in-process `linear_graphql` MCP tool
   * (spec §10.5). Reuses Symphony's configured tracker auth so the
   * agent never reads `LINEAR_API_KEY` directly.
   */
  tracker?: LinearTrackerClient;
}

/**
 * Returns truthy values that aren't the placeholder sentinel we use when
 * pre-creating secret slots.
 */
function realValue(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (v === "PLACEHOLDER_REPLACE_ME") return null;
  return v;
}

export async function buildMcpServers(
  opts: BuildMcpServersOptions = {},
): Promise<ClaudeMcpServers> {
  const env = opts.env ?? process.env;
  const out: ClaudeMcpServers = {};

  // ─── Linear: in-process linear_graphql tool (A-12) ──────────────────
  // Built via tracker.runGraphqlForAgent — reuses Symphony's configured
  // auth. The first-party HTTP MCP (mcp.linear.app) below is still wired
  // for high-level Linear operations (issue creation, label CRUD, etc.);
  // this in-process tool gives the agent a raw GraphQL escape hatch when
  // the high-level MCP doesn't expose the field it needs.
  if (opts.tracker) {
    // `buildLinearMcpServer` returns the SDK's `{type: "sdk", name, instance}`
    // envelope already (instance is a real McpServer). DO NOT wrap it again
    // — wrapping was the bug that crashed every dispatch with
    // `server.connect is not a function` on the first prod deploy.
    out.linear_graphql = buildLinearMcpServer(opts.tracker);
  }

  // ─── Linear (HTTP) ───────────────────────────────────────────────────
  // First-party MCP at https://mcp.linear.app/mcp. Accepts the same
  // `lin_api_*` personal API key symphony already uses for its own
  // GraphQL polling.
  const linearKey = realValue(env.LINEAR_API_KEY);
  if (linearKey) {
    out.linear = {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: `Bearer ${linearKey}` },
    };
  } else {
    logger.warn({}, "mcp.linear.skipped — LINEAR_API_KEY missing");
  }

  // ─── GitHub (HTTP) ───────────────────────────────────────────────────
  // First-party hosted MCP at https://api.githubcopilot.com/mcp/. Accepts
  // a GitHub installation token in the `Authorization: Bearer …` header.
  if (!opts.skipGithub) {
    const ghToken = await getInstallationToken(env);
    if (ghToken) {
      out.github = {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: `Bearer ${ghToken}` },
      };
    } else {
      logger.warn({}, "mcp.github.skipped — GH App credentials missing or token mint failed");
    }
  }

  // ─── Notion (HTTP) ───────────────────────────────────────────────────
  // First-party MCP at https://mcp.notion.com/mcp. Accepts a Notion
  // integration token (`ntn_*`) as bearer.
  const notionToken = realValue(env.NOTION_TOKEN);
  if (notionToken) {
    out.notion = {
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: `Bearer ${notionToken}` },
    };
  }

  // ─── Slack (stdio) ───────────────────────────────────────────────────
  // `@modelcontextprotocol/server-slack` reads SLACK_BOT_TOKEN from env.
  // Using `npx --yes` with each spawn pays a cold-start. For Symphony's
  // single-tenant dispatch cadence (~1 MCP spawn per turn, not per tool
  // call) the npx delay is acceptable; pre-install in your Docker image
  // if you want to avoid it.
  const slackToken = realValue(env.SLACK_BOT_TOKEN);
  if (slackToken) {
    out.slack = {
      type: "stdio",
      command: "npx",
      args: ["--yes", "@modelcontextprotocol/server-slack"],
      env: {
        SLACK_BOT_TOKEN: slackToken,
        SLACK_TEAM_ID: realValue(env.SLACK_TEAM_ID) ?? "",
      },
    };
  }

  // ─── Sentry (stdio, READ ONLY by prompt convention) ─────────────────
  // `@sentry/mcp-server` reads SENTRY_AUTH_TOKEN + SENTRY_ORG from env.
  // Both must be set; SENTRY_ORG is your Sentry organization slug.
  const sentryToken = realValue(env.SENTRY_AUTH_TOKEN);
  const sentryOrg = realValue(env.SENTRY_ORG);
  if (sentryToken && sentryOrg) {
    out.sentry = {
      type: "stdio",
      command: "npx",
      args: ["--yes", "@sentry/mcp-server"],
      env: {
        SENTRY_AUTH_TOKEN: sentryToken,
        SENTRY_ORG: sentryOrg,
      },
    };
  }

  // AWS / GCP / Vercel intentionally not wired by default:
  //   - AWS: no off-the-shelf MCP package matches the awslabs naming.
  //   - GCP: if using Cloud Run, the service account has IAM already; wire
  //     via service-account JSON if you need a GCP MCP.
  //   - Vercel: their hosted MCP is OAuth-only (no headless bearer); the
  //     stdio path through `@vercel/sdk` works but is not pre-installed.

  logger.info(
    {
      mcps: Object.keys(out),
      count: Object.keys(out).length,
    },
    "mcp.servers.built",
  );
  return out;
}
