import { describe, expect, it } from "vitest";
import { withContext } from "../../src/observability/logger.js";
import { SlackObserver } from "../../src/observability/slack.js";

/**
 * Spec §17.6 — Observability.
 */

describe("§17.6 observability", () => {
  it("withContext returns a child logger that does not throw on log", () => {
    const child = withContext({ issue_id: "i1", issue_identifier: "ABC-1", session_id: "s" });
    expect(() => child.info({ foo: 1 }, "hello")).not.toThrow();
  });

  it("slack observer is disabled when token or channel is missing", () => {
    const a = new SlackObserver({ token: undefined, channelId: "C123" });
    const b = new SlackObserver({ token: "t", channelId: undefined });
    expect(a.enabled()).toBe(false);
    expect(b.enabled()).toBe(false);
  });

  it("slack observer no-ops cleanly when disabled", async () => {
    const obs = new SlackObserver({ token: undefined, channelId: undefined });
    await expect(
      obs.announceDispatch(
        {
          id: "i",
          identifier: "ABC-1",
          title: "t",
          description: null,
          priority: null,
          state: "Todo",
          branchName: null,
          url: null,
          labels: [],
          blockedBy: [],
          createdAt: null,
          updatedAt: null,
        },
        null,
      ),
    ).resolves.toBeUndefined();
  });

  // Cache hit-rate in announceOutcome
  describe("announceOutcome cache hit-rate", () => {
    /**
     * Drive announceOutcome with a stub WebClient so we can capture the
     * `text` argument and assert the cache_hit segment lands as expected.
     * The constructor takes a `clientFactory` for exactly this purpose.
     */
    function makeObserverCapturing(): {
      observer: SlackObserver;
      lastText: () => string | undefined;
    } {
      const captured: { text?: string } = {};
      // Minimal Slack WebClient stub — only postMessage is called.
      const fakeClient = {
        chat: {
          postMessage: async (args: { text?: string }) => {
            captured.text = args.text;
            return { ok: true, ts: "1700000000.123" };
          },
        },
        // resolveThreadTs uses none of these in the disabled-DB path.
        // SlackObserver short-circuits when there's no pool.
      };
      const observer = new SlackObserver({
        token: "x",
        channelId: "C123",
        clientFactory: () => fakeClient as never,
      });
      // Bypass enable check — when the factory returns a usable client the
      // observer marks itself enabled internally; the slackHealthy flag
      // also needs no patching since postMessage is the only call.
      return { observer, lastText: () => captured.text };
    }

    const issue = {
      id: "i1",
      identifier: "ABC-42",
      title: "t",
      description: null,
      priority: null,
      state: "Done",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    };

    it("emits `cache_hit=NN.N%` when there's a real cache read (cacheReadInputTokens > 0)", async () => {
      const { observer, lastText } = makeObserverCapturing();
      await observer.announceOutcome(issue, "Succeeded", {
        tokens: 1000,
        costUsd: 0.05,
        inputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 900,
      });
      // 900 / (100 + 0 + 900) = 90.0%
      expect(lastText()).toMatch(/cache_hit=90\.0%/);
    });

    it("omits the cache_hit segment on first-dispatch cache write (cacheRead=0, cacheCreate>0)", async () => {
      // The first dispatch within a 5-min TTL window populates the cache
      // (cache_creation_input_tokens > 0) but reads zero. Emitting
      // `cache_hit=0.0%` here would falsely imply caching is disabled.
      // Operators see the segment appear from the second dispatch onward.
      // Surfaced by Copilot review.
      const { observer, lastText } = makeObserverCapturing();
      await observer.announceOutcome(issue, "Succeeded", {
        tokens: 1000,
        costUsd: 0.05,
        inputTokens: 100,
        cacheCreationInputTokens: 4000,
        cacheReadInputTokens: 0,
      });
      expect(lastText()).not.toMatch(/cache_hit=/);
    });

    it("omits the cache_hit segment when there's no cache activity at all", async () => {
      const { observer, lastText } = makeObserverCapturing();
      await observer.announceOutcome(issue, "Succeeded", {
        tokens: 1000,
        costUsd: 0.05,
        inputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      });
      expect(lastText()).not.toMatch(/cache_hit=/);
    });

    it("omits the cache_hit segment when fields are missing (back-compat)", async () => {
      const { observer, lastText } = makeObserverCapturing();
      await observer.announceOutcome(issue, "Succeeded", {
        tokens: 1000,
        costUsd: 0.05,
      });
      expect(lastText()).not.toMatch(/cache_hit=/);
    });

    it("omits the cache_hit segment when cacheRead is set but other fields aren't (partial inputs)", async () => {
      // If only cacheReadInputTokens is supplied and inputTokens /
      // cacheCreationInputTokens are missing, computing the hit-rate
      // with `?? 0` defaults would produce `cache_hit=100.0%` — wildly
      // misleading. The denominator must reflect the full input-side
      // token universe. Surfaced by Copilot review.
      const { observer, lastText } = makeObserverCapturing();
      await observer.announceOutcome(issue, "Succeeded", {
        tokens: 1000,
        costUsd: 0.05,
        cacheReadInputTokens: 900,
      });
      expect(lastText()).not.toMatch(/cache_hit=/);
    });
  });
});
