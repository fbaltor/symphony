import { describe, expect, it } from "vitest";
import {
  ClaudeAgentRunner,
  attachWorkspace,
  type ClaudeQueryFn,
} from "../../src/agent/claude-adapter.js";
import type { Issue } from "../../src/types.js";

/**
 * Spec §17.5 — Coding-agent app-server client.
 *
 * Symphony ships only the Claude adapter in this PR (Codex adapter follows).
 * We exercise the contract surface and the abort/usage accounting.
 */

function fakeIssue(): Issue {
  return {
    id: "i1",
    identifier: "ABC-1",
    title: "t",
    description: null,
    priority: null,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

describe("§17.5 claude adapter", () => {
  it("turn_completed yields completed outcome and aggregates usage", async () => {
    const queryImpl: ClaudeQueryFn = () =>
      (async function* () {
        yield {
          type: "assistant" as const,
          usage: { input_tokens: 100, output_tokens: 50 },
        };
        yield {
          type: "result" as const,
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.005,
          result: "ok",
        };
      })();

    const runner = new ClaudeAgentRunner({ queryImpl });
    const session = await runner.startSession({ workspacePath: "/tmp", issue: fakeIssue() });
    attachWorkspace(session, "/tmp");
    const res = await runner.runTurn(session, {
      prompt: "hi",
      attempt: null,
      turnTimeoutMs: 5_000,
      stallTimeoutMs: 0,
    });
    expect(res.outcome).toBe("completed");
    expect(res.usageDelta.inputTokens).toBe(100);
    expect(res.usageDelta.outputTokens).toBe(50);
    expect(res.usageDelta.costUsd).toBeCloseTo(0.005);
  });

  it("external abort signal cancels the turn and returns 'cancelled'", async () => {
    const queryImpl: ClaudeQueryFn = () =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 200));
      })();

    const runner = new ClaudeAgentRunner({ queryImpl });
    const session = await runner.startSession({ workspacePath: "/tmp", issue: fakeIssue() });
    attachWorkspace(session, "/tmp");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const res = await runner.runTurn(session, {
      prompt: "hi",
      attempt: null,
      turnTimeoutMs: 5_000,
      stallTimeoutMs: 0,
      signal: ac.signal,
    });
    expect(res.outcome).toBe("cancelled");
  });

  it("turn timeout aborts and returns non-completed outcome", async () => {
    const queryImpl: ClaudeQueryFn = () =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 50));
        // Never yields a result.
      })();

    const runner = new ClaudeAgentRunner({ queryImpl });
    const session = await runner.startSession({ workspacePath: "/tmp", issue: fakeIssue() });
    attachWorkspace(session, "/tmp");
    const res = await runner.runTurn(session, {
      prompt: "hi",
      attempt: null,
      turnTimeoutMs: 10,
      stallTimeoutMs: 0,
    });
    expect(res.outcome).not.toBe("completed");
  });

  // B-3 / D-21 / AGENT-529 — prompt caching invariants
  describe("prompt caching", () => {
    it("passes excludeDynamicSections:true on the systemPrompt to enable cross-dispatch caching", async () => {
      const seen: { systemPrompt?: unknown } = {};
      const queryImpl: ClaudeQueryFn = (args) => {
        seen.systemPrompt = args.options.systemPrompt;
        return (async function* () {
          yield {
            type: "result" as const,
            subtype: "success",
            is_error: false,
            total_cost_usd: 0,
            result: "ok",
          };
        })();
      };

      const runner = new ClaudeAgentRunner({ queryImpl });
      const session = await runner.startSession({ workspacePath: "/tmp", issue: fakeIssue() });
      attachWorkspace(session, "/tmp");
      await runner.runTurn(session, {
        prompt: "hi",
        attempt: null,
        turnTimeoutMs: 5_000,
        stallTimeoutMs: 0,
      });

      const sp = seen.systemPrompt as
        | { type: string; preset: string; append?: string; excludeDynamicSections?: boolean }
        | undefined;
      expect(sp).toBeDefined();
      expect(sp?.type).toBe("preset");
      expect(sp?.preset).toBe("claude_code");
      // The load-bearing assertion: without this flag the SDK injects
      // working-dir / git-status into the system prompt, which makes the
      // prefix vary per dispatch and silently disables Anthropic prompt
      // caching. This guards against accidental removal.
      expect(sp?.excludeDynamicSections).toBe(true);
    });

    it("aggregates cache_creation + cache_read tokens through usageDelta", async () => {
      const queryImpl: ClaudeQueryFn = () =>
        (async function* () {
          yield {
            type: "assistant" as const,
            usage: {
              input_tokens: 200,
              output_tokens: 50,
              cache_creation_input_tokens: 4096,
              cache_read_input_tokens: 0,
            },
          };
          yield {
            type: "assistant" as const,
            usage: {
              input_tokens: 100,
              output_tokens: 30,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 4096,
            },
          };
          yield {
            type: "result" as const,
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.01,
            result: "ok",
          };
        })();

      const runner = new ClaudeAgentRunner({ queryImpl });
      const session = await runner.startSession({ workspacePath: "/tmp", issue: fakeIssue() });
      attachWorkspace(session, "/tmp");
      const res = await runner.runTurn(session, {
        prompt: "hi",
        attempt: null,
        turnTimeoutMs: 5_000,
        stallTimeoutMs: 0,
      });

      expect(res.usageDelta.inputTokens).toBe(300);
      expect(res.usageDelta.outputTokens).toBe(80);
      expect(res.usageDelta.cacheCreationInputTokens).toBe(4096);
      expect(res.usageDelta.cacheReadInputTokens).toBe(4096);
    });

    it("handles SDK responses without cache fields (zero defaults)", async () => {
      // Older SDK versions / fallback responses don't include the
      // cache_*_input_tokens fields. Should default to 0, not NaN.
      const queryImpl: ClaudeQueryFn = () =>
        (async function* () {
          yield {
            type: "assistant" as const,
            usage: { input_tokens: 100, output_tokens: 50 },
          };
          yield {
            type: "result" as const,
            subtype: "success",
            is_error: false,
            total_cost_usd: 0.005,
            result: "ok",
          };
        })();

      const runner = new ClaudeAgentRunner({ queryImpl });
      const session = await runner.startSession({ workspacePath: "/tmp", issue: fakeIssue() });
      attachWorkspace(session, "/tmp");
      const res = await runner.runTurn(session, {
        prompt: "hi",
        attempt: null,
        turnTimeoutMs: 5_000,
        stallTimeoutMs: 0,
      });

      expect(res.usageDelta.cacheCreationInputTokens).toBe(0);
      expect(res.usageDelta.cacheReadInputTokens).toBe(0);
    });
  });
});
