import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetGithubAuthCache } from "../../src/lib/github-auth.js";

afterEach(() => {
  vi.unstubAllGlobals();
  _resetGithubAuthCache();
});

describe("buildMcpServers", () => {
  it("returns empty when no env is configured", async () => {
    const { buildMcpServers } = await import("../../src/agent/mcp-config.js");
    const out = await buildMcpServers({ env: {}, skipGithub: true });
    expect(out).toEqual({});
  });

  it("registers Linear HTTP MCP when LINEAR_API_KEY is present", async () => {
    const { buildMcpServers } = await import("../../src/agent/mcp-config.js");
    const out = await buildMcpServers({
      env: { LINEAR_API_KEY: "lin_api_test" },
      skipGithub: true,
    });
    expect(out.linear).toBeDefined();
    expect(out.linear).toMatchObject({
      type: "http",
      url: "https://mcp.linear.app/mcp",
    });
    expect((out.linear as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer lin_api_test",
    );
  });

  it("treats PLACEHOLDER_REPLACE_ME as 'not set'", async () => {
    const { buildMcpServers } = await import("../../src/agent/mcp-config.js");
    const out = await buildMcpServers({
      env: { LINEAR_API_KEY: "PLACEHOLDER_REPLACE_ME" },
      skipGithub: true,
    });
    expect(out.linear).toBeUndefined();
  });

  it("registers Slack stdio MCP when SLACK_BOT_TOKEN is present", async () => {
    const { buildMcpServers } = await import("../../src/agent/mcp-config.js");
    const out = await buildMcpServers({
      env: { SLACK_BOT_TOKEN: "xoxb-1" },
      skipGithub: true,
    });
    expect(out.slack).toBeDefined();
    expect(out.slack).toMatchObject({
      type: "stdio",
      command: "npx",
    });
    expect((out.slack as { env: Record<string, string> }).env.SLACK_BOT_TOKEN).toBe("xoxb-1");
  });

  it("registers Notion HTTP MCP with bearer token", async () => {
    const { buildMcpServers } = await import("../../src/agent/mcp-config.js");
    const out = await buildMcpServers({
      env: { NOTION_TOKEN: "ntn_test" },
      skipGithub: true,
    });
    expect(out.notion).toMatchObject({
      type: "http",
      url: "https://mcp.notion.com/mcp",
    });
    expect((out.notion as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer ntn_test",
    );
  });

  it("skips Sentry MCP when SENTRY_ORG is absent (both token and org are required)", async () => {
    const { buildMcpServers } = await import("../../src/agent/mcp-config.js");
    const out = await buildMcpServers({
      env: { SENTRY_AUTH_TOKEN: "sntrys_test" },
      skipGithub: true,
    });
    expect(out.sentry).toBeUndefined();
  });

  it("registers Sentry stdio MCP when both SENTRY_AUTH_TOKEN and SENTRY_ORG are present", async () => {
    const { buildMcpServers } = await import("../../src/agent/mcp-config.js");
    const out = await buildMcpServers({
      env: { SENTRY_AUTH_TOKEN: "sntrys_test", SENTRY_ORG: "my-org" },
      skipGithub: true,
    });
    expect(out.sentry).toMatchObject({
      type: "stdio",
      command: "npx",
    });
    const sentryEnv = (out.sentry as { env: Record<string, string> }).env;
    expect(sentryEnv.SENTRY_AUTH_TOKEN).toBe("sntrys_test");
    expect(sentryEnv.SENTRY_ORG).toBe("my-org");
  });

  it("skips GitHub MCP when skipGithub=true (token mint is bypassed)", async () => {
    const { buildMcpServers } = await import("../../src/agent/mcp-config.js");
    const out = await buildMcpServers({
      env: {
        GITHUB_APP_ID: "1",
        GITHUB_APP_INSTALLATION_ID: "2",
        GITHUB_APP_PRIVATE_KEY: "x",
      },
      skipGithub: true,
    });
    expect(out.github).toBeUndefined();
  });
});
