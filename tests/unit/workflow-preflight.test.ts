import { describe, expect, it } from "vitest";
import { preflightValidate, type SymphonyConfig } from "../../src/workflow/config.js";

/**
 * Spec §6.3 + IMPROVEMENTS.md A-7 — preflight catches unresolved env tokens
 * (`$VAR` literals that survived `expandEnvAndHome` because the env was unset)
 * and returns a structured error instead of letting the orchestrator post
 * to a literal `$VAR` Slack channel / Linear endpoint.
 */

const baseConfig: SymphonyConfig = {
  tracker: {
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey: "lin_api_real_key",
    teamId: "team-id",
    projectSlug: undefined as unknown as string,
    activeStates: ["Todo"],
    terminalStates: ["Done"],
    stateTransitions: {},
    humanReviewStates: [],
    announceDispatch: true,
    announceOutcome: true,
    errorStates: ["Error"],
    maxErrorRetries: 5,
    prRequiredStates: [],
    noPrRetryLimit: 3,
  },
  polling: { intervalMs: 30_000, errorRetryIntervalMs: 300_000 },
  workspace: { root: "/tmp/symphony", gcIntervalMs: 600_000, gcMaxAgeMs: 3_600_000 },
  hooks: {
    afterCreate: null,
    beforeRun: null,
    afterRun: null,
    beforeRemove: null,
    timeoutMs: 60_000,
  },
  agent: {
    maxConcurrentAgents: 5,
    maxTurns: 20,
    maxRetryBackoffMs: 300_000,
    maxConcurrentAgentsByState: {},
    writeCwdsByState: {},
  },
  codex: {
    command: "codex app-server",
    approvalPolicy: "auto",
    threadSandbox: "unrestricted",
    turnSandboxPolicy: "unrestricted",
    turnTimeoutMs: 3_600_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000,
  },
  guardrails: { dailyCapUsd: 250, perIssueCapUsd: 30, perStateCapUsd: {} },
  slack: { enabled: true, channelId: "C0123456789" },
  agentRuntime: { runtime: "claude", model: "claude-opus-4-7" },
  github: { owner: "example-org", repo: "example-repo", branchPrefix: "symphony" },
};

describe("preflightValidate", () => {
  it("returns null when all required fields are populated and resolved", () => {
    expect(preflightValidate(baseConfig)).toBeNull();
  });

  it("flags unresolved tracker.api_key", () => {
    const cfg = { ...baseConfig, tracker: { ...baseConfig.tracker, apiKey: "$LINEAR_API_KEY" } };
    expect(preflightValidate(cfg)).toMatch(/tracker.api_key has unresolved env token/);
  });

  it("flags unresolved slack.channel_id when enabled", () => {
    const cfg = { ...baseConfig, slack: { enabled: true, channelId: "$SLACK_CHANNEL_ID" } };
    expect(preflightValidate(cfg)).toMatch(/slack.channel_id has unresolved env token/);
  });

  it("does NOT flag unresolved slack.channel_id when slack is disabled", () => {
    const cfg = { ...baseConfig, slack: { enabled: false, channelId: "$SLACK_CHANNEL_ID" } };
    expect(preflightValidate(cfg)).toBeNull();
  });

  it("does NOT flag a real channel id (no $-prefix)", () => {
    const cfg = { ...baseConfig, slack: { enabled: true, channelId: "C0123456789" } };
    expect(preflightValidate(cfg)).toBeNull();
  });

  it("does NOT flag null slack.channel_id", () => {
    const cfg = { ...baseConfig, slack: { enabled: true, channelId: null } };
    expect(preflightValidate(cfg)).toBeNull();
  });

  it("flags missing tracker.api_key", () => {
    const cfg = { ...baseConfig, tracker: { ...baseConfig.tracker, apiKey: "" } };
    expect(preflightValidate(cfg)).toBe("tracker.api_key missing after resolution");
  });

  it("flags missing project_slug and team_id together for linear", () => {
    const cfg = {
      ...baseConfig,
      tracker: {
        ...baseConfig.tracker,
        teamId: undefined as unknown as string,
        projectSlug: undefined as unknown as string,
      },
    };
    expect(preflightValidate(cfg)).toBe(
      "tracker.project_slug or tracker.team_id required when kind=linear",
    );
  });
});
