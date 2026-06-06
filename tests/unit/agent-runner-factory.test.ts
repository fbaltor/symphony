import { describe, expect, it } from "vitest";
import { createAgentRunner } from "../../src/agent/runner-factory.js";
import { FakeAgentRunner } from "../../src/agent/fake-runner.js";
import { ClaudeAgentRunner } from "../../src/agent/claude-adapter.js";
import type { AgentRunner } from "../../src/agent/runner.js";
import type { SymphonyConfig } from "../../src/workflow/config.js";
import { symphonyConfigSchema } from "../../src/workflow/config.js";

/**
 * Phase B — runner factory + `"fake"` runtime config option.
 *
 * Which AgentRunner concrete is used is chosen by config (`agentRuntime.runtime`)
 * WITHOUT changing call sites. A factory maps config → runner instance:
 *
 *   runtime: "fake"   ⇒ FakeAgentRunner   (zero LLM cost, deterministic; the
 *                                          default under the memory profile)
 *   runtime: "claude" ⇒ ClaudeAgentRunner (the real adapter, still selectable)
 *
 * These tests assert ONLY the selection MAPPING. They do NOT exercise the real
 * Claude adapter's internals (out of scope for this phase). Authored before the
 * factory + config widening exist, so RED is expected.
 */

/* ------------------------------ fixtures -------------------------------- */

/**
 * Build a full SymphonyConfig with a chosen agentRuntime block. We start from
 * a known-valid object and only vary `agentRuntime` so the factory's selection
 * is the single thing under test.
 */
function makeConfig(agentRuntime: Record<string, unknown>): SymphonyConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "lin_test",
      teamId: "team-1",
      activeStates: ["Active"],
      terminalStates: ["Done"],
      humanReviewStates: [],
      stateTransitions: {},
      announceDispatch: false,
      announceOutcome: false,
      prRequiredStates: [],
      noPrRetryLimit: 3,
      errorStates: ["Error"],
      maxErrorRetries: 5,
    },
    polling: { intervalMs: 30_000, errorRetryIntervalMs: 300_000 },
    workspace: { root: "/tmp/test-symphony-factory", gcIntervalMs: 600_000, gcMaxAgeMs: 3_600_000 },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 1,
      maxRetryBackoffMs: 60_000,
      maxConcurrentAgentsByState: {},
      writeCwdsByState: {},
    },
    codex: {
      command: "codex",
      approvalPolicy: "auto",
      threadSandbox: "unrestricted",
      turnSandboxPolicy: "unrestricted",
      turnTimeoutMs: 60_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 60_000,
    },
    guardrails: { dailyCapUsd: 0, perIssueCapUsd: 0, perStateCapUsd: {} },
    slack: { enabled: false, channelId: null },
    agentRuntime: agentRuntime as SymphonyConfig["agentRuntime"],
    github: { owner: "acme", repo: "widgets", branchPrefix: "symphony" },
  } as unknown as SymphonyConfig;
}

/* --------------------- behavior 4: config widening ---------------------- */

describe("behavior 4 (config): agentRuntime.runtime accepts the new \"fake\" option", () => {
  it("symphonyConfigSchema parses runtime: \"fake\" (literal widened beyond \"claude\")", () => {
    // Today the schema is `z.literal("claude")`, so this parse THROWS. The
    // phase widens it to include "fake". This is a falsifiable claim about the
    // config contract gaining the option.
    const parsed = symphonyConfigSchema.parse(
      makeConfig({ runtime: "fake" }) as unknown as Record<string, unknown>,
    );
    expect(parsed.agentRuntime.runtime).toBe("fake");
  });

  it("symphonyConfigSchema still accepts runtime: \"claude\" (existing option preserved)", () => {
    const parsed = symphonyConfigSchema.parse(
      makeConfig({ runtime: "claude" }) as unknown as Record<string, unknown>,
    );
    expect(parsed.agentRuntime.runtime).toBe("claude");
  });
});

/* --------------------- behavior 4: selection mapping -------------------- */

describe("behavior 4 (factory): createAgentRunner maps config.agentRuntime.runtime → runner", () => {
  it("returns a FakeAgentRunner when runtime is \"fake\"", () => {
    const runner = createAgentRunner(makeConfig({ runtime: "fake" }));
    expect(runner).toBeInstanceOf(FakeAgentRunner);
    expect(runner.kind).toBe("fake");
  });

  it("returns the real ClaudeAgentRunner when runtime is \"claude\" (real adapter still selectable)", () => {
    // Selection mapping only — we assert the TYPE/kind of the returned
    // instance, never invoke runTurn (which would need SDK/credentials). The
    // real adapter's behavior is out of scope for this phase.
    const runner = createAgentRunner(makeConfig({ runtime: "claude" }));
    expect(runner).toBeInstanceOf(ClaudeAgentRunner);
    expect(runner.kind).toBe("claude");
  });

  it("the returned value satisfies the AgentRunner interface for either runtime", () => {
    const fake: AgentRunner = createAgentRunner(makeConfig({ runtime: "fake" }));
    const claude: AgentRunner = createAgentRunner(makeConfig({ runtime: "claude" }));
    for (const runner of [fake, claude]) {
      expect(typeof runner.kind).toBe("string");
      expect(typeof runner.startSession).toBe("function");
      expect(typeof runner.runTurn).toBe("function");
      expect(typeof runner.endSession).toBe("function");
    }
  });

  it("under the memory profile (default runtime resolves to \"fake\") the default runner is the fake", () => {
    // The memory profile sets `agentRuntime.runtime = "fake"`. The factory,
    // given that config, must default to the zero-cost fake WITHOUT any call
    // site passing an explicit runner. This is the load-bearing claim of
    // behavior 4: config alone flips the default to the fake.
    const memoryProfileConfig = makeConfig({ runtime: "fake" });
    const runner = createAgentRunner(memoryProfileConfig);
    expect(runner).toBeInstanceOf(FakeAgentRunner);
    expect(runner.kind).toBe("fake");
  });
});
