import type { SymphonyConfig } from "../workflow/config.js";
import type { AgentRunner } from "./runner.js";
import { ClaudeAgentRunner, type ClaudeAdapterOptions } from "./claude-adapter.js";
import { FakeAgentRunner, type FakeAgentRunnerScript } from "./fake-runner.js";

/**
 * Phase B (zero-dep E2E) — runner selection factory.
 *
 * Which concrete `AgentRunner` a flow runs against is chosen by config
 * (`agentRuntime.runtime`) WITHOUT changing call sites:
 *
 *   runtime: "fake"   ⇒ FakeAgentRunner   (scripted, zero LLM cost; the
 *                                          default under the `kind: memory`
 *                                          profile)
 *   runtime: "claude" ⇒ ClaudeAgentRunner (the real adapter, still selectable
 *                                          — the shipped default)
 *
 * `main.ts` calls this instead of constructing the Claude adapter directly, so
 * config alone flips the default to the fake. The agent axis is independent of
 * `tracker.kind`: `kind: memory` can run with either runtime.
 */
export interface CreateAgentRunnerOverrides {
  /**
   * Per-turn options forwarded to the real Claude adapter (mcpServersResolver,
   * queryImpl, …). Ignored for the fake runtime. `model` / `effort` come from
   * config and are merged on top unless overridden here.
   */
  claude?: ClaudeAdapterOptions;
  /**
   * Script for the fake runtime. Defaults to a single scripted `completed`
   * turn so a bare `runtime: "fake"` config yields a usable runner.
   */
  fakeScript?: FakeAgentRunnerScript;
}

export function createAgentRunner(
  config: SymphonyConfig,
  overrides: CreateAgentRunnerOverrides = {},
): AgentRunner {
  const runtime = config.agentRuntime.runtime;
  if (runtime === "fake") {
    return new FakeAgentRunner(overrides.fakeScript ?? { outcome: "completed" });
  }
  // runtime === "claude" — the real adapter. Forward model / effort from
  // config; callers (main.ts) supply the per-turn mcpServersResolver via
  // `overrides.claude`.
  return new ClaudeAgentRunner({
    model: config.agentRuntime.model,
    effort: config.agentRuntime.effort,
    ...overrides.claude,
  });
}
