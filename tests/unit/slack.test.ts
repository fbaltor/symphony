import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "../../src/types.js";

/**
 * Tests for SlackObserver — focused on:
 *
 *   1. Suppression: first invalid_auth logs once, subsequent calls early-return
 *      and stay quiet (no further log lines, no further postMessage calls).
 *   2. Threading: the root message's `ts` is stored and reused as `thread_ts`
 *      on subsequent posts for the same issue.
 *
 * We mock @slack/web-api's WebClient to control postMessage behavior without
 * touching the network.
 */

// ---- Mock @slack/web-api before importing the SUT ----------------------

const postMessage = vi.fn();

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    chat: { postMessage },
  })),
}));

// ---- Mock the logger so we can assert on .warn calls -------------------

const warn = vi.fn();
vi.mock("../../src/observability/logger.js", () => ({
  logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  withContext: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

// ---- Test fixtures -----------------------------------------------------

const issue: Issue = {
  id: "issue-uuid-1",
  identifier: "JUMP-101",
  title: "Test issue",
  description: null,
  priority: null,
  state: "Backlog",
  branchName: null,
  url: null,
  labels: [],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
};

function buildInvalidAuthError(): Error & { data: { ok: false; error: string } } {
  const err = new Error("An API error occurred: invalid_auth") as Error & {
    data: { ok: false; error: string };
  };
  err.data = { ok: false, error: "invalid_auth" };
  return err;
}

beforeEach(() => {
  postMessage.mockReset();
  warn.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SlackObserver — suppression on invalid_auth", () => {
  it("logs once on first invalid_auth, early-returns on subsequent calls", async () => {
    const { SlackObserver } = await import("../../src/observability/slack.js");
    postMessage.mockRejectedValue(buildInvalidAuthError());

    const slack = new SlackObserver({ token: "xoxb-bad", channelId: "C123" });

    await slack.announceDispatch(issue, null);
    await slack.announceDispatch(issue, null);
    await slack.announceOutcome(issue, "Succeeded");
    await slack.announceOutcome(issue, "Failed");

    // First announceDispatch made one postMessage call (the root post). After
    // it failed with invalid_auth, slackHealthy flipped — no further calls.
    expect(postMessage).toHaveBeenCalledTimes(1);

    // Exactly one warn line, and it must be actionable (mention the runbook
    // and the required scope).
    expect(warn).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warn.mock.calls[0]!;
    expect(ctx).toMatchObject({ err: "invalid_auth" });
    expect(ctx).toMatchObject({ runbook: expect.stringContaining("slack-setup.md") });
    expect(msg).toContain("slack disabled");
    expect(msg).toContain("invalid_auth");
    expect(msg).toContain("chat:write");

    // enabled() flips false after the auth failure.
    expect(slack.enabled()).toBe(false);
  });

  it("ignores stringified `An API error occurred: invalid_auth` when no .data field is present", async () => {
    const { SlackObserver } = await import("../../src/observability/slack.js");
    // Some error shapes lose the structured `.data` field (e.g. wrapped/rethrown).
    postMessage.mockRejectedValue(new Error("An API error occurred: invalid_auth"));

    const slack = new SlackObserver({ token: "xoxb-bad", channelId: "C123" });
    await slack.announceDispatch(issue, null);
    await slack.announceDispatch(issue, null);

    // Still suppressed via the message-string fallback.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(slack.enabled()).toBe(false);
  });

  it("does NOT suppress on non-auth errors (e.g. channel_not_found)", async () => {
    const { SlackObserver } = await import("../../src/observability/slack.js");
    const err = new Error("An API error occurred: channel_not_found") as Error & {
      data: { ok: false; error: string };
    };
    err.data = { ok: false, error: "channel_not_found" };
    postMessage.mockRejectedValue(err);

    const slack = new SlackObserver({ token: "xoxb-ok", channelId: "C-bad" });
    await slack.announceDispatch(issue, null);
    // B-14: per-issue 5s gap blocks back-to-back posts. Reset for the test.
    slack._resetRateLimitsForTests();
    await slack.announceDispatch(issue, null);

    // Both calls attempted (transient/operator errors stay visible).
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(slack.enabled()).toBe(true);
  });

  it("noops silently when token or channelId is missing", async () => {
    const { SlackObserver } = await import("../../src/observability/slack.js");
    const slack = new SlackObserver({ token: undefined, channelId: undefined });
    await slack.announceDispatch(issue, null);
    await slack.announceOutcome(issue, "Succeeded");
    expect(postMessage).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(slack.enabled()).toBe(false);
  });
});

describe("SlackObserver — threading", () => {
  it("posts root once per issue and reuses thread_ts on subsequent posts", async () => {
    const { SlackObserver } = await import("../../src/observability/slack.js");
    postMessage
      .mockResolvedValueOnce({ ok: true, ts: "1700000000.000100" })
      .mockResolvedValueOnce({ ok: true, ts: "1700000000.000200" })
      .mockResolvedValueOnce({ ok: true, ts: "1700000000.000300" });

    const slack = new SlackObserver({ token: "xoxb-ok", channelId: "C123" });
    await slack.announceDispatch(issue, null);
    // B-14: per-issue 5s gap blocks back-to-back posts. Reset for the test.
    slack._resetRateLimitsForTests();
    await slack.announceOutcome(issue, "Succeeded", { tokens: 1234, costUsd: 0.0567 });

    // Calls: (1) root post (no thread_ts), (2) dispatch reply with thread_ts,
    // (3) outcome reply with thread_ts.
    expect(postMessage).toHaveBeenCalledTimes(3);

    const [first, second, third] = postMessage.mock.calls;
    expect(first?.[0]).toMatchObject({ channel: "C123" });
    expect(first?.[0]).not.toHaveProperty("thread_ts");

    expect(second?.[0]).toMatchObject({ thread_ts: "1700000000.000100" });
    expect(third?.[0]).toMatchObject({ thread_ts: "1700000000.000100" });
    expect(third?.[0].text).toContain("tokens=1234");
    expect(third?.[0].text).toContain("cost=$0.0567");
  });

  it("falls back to un-threaded post if root response lacks ts", async () => {
    const { SlackObserver } = await import("../../src/observability/slack.js");
    postMessage
      .mockResolvedValueOnce({ ok: true }) // no ts on root
      .mockResolvedValueOnce({ ok: true });

    const slack = new SlackObserver({ token: "xoxb-ok", channelId: "C123" });
    await slack.announceDispatch(issue, null);

    expect(postMessage).toHaveBeenCalledTimes(2);
    const [, second] = postMessage.mock.calls;
    // No thread_ts — defensive fallback rather than thread_ts=undefined.
    expect(second?.[0]).not.toHaveProperty("thread_ts");
  });

  it("threads outcome replies under existing root for a re-dispatched issue", async () => {
    const { SlackObserver } = await import("../../src/observability/slack.js");
    postMessage
      .mockResolvedValueOnce({ ok: true, ts: "1700000000.000100" }) // root
      .mockResolvedValueOnce({ ok: true, ts: "1700000000.000200" }) // first dispatch reply
      .mockResolvedValueOnce({ ok: true, ts: "1700000000.000300" }) // re-dispatch reply
      .mockResolvedValueOnce({ ok: true, ts: "1700000000.000400" }); // outcome reply

    const slack = new SlackObserver({ token: "xoxb-ok", channelId: "C123" });
    await slack.announceDispatch(issue, null);
    // B-14: per-issue 5s gap blocks back-to-back posts. Reset between calls.
    slack._resetRateLimitsForTests();
    await slack.announceDispatch(issue, 1);
    slack._resetRateLimitsForTests();
    await slack.announceOutcome(issue, "Succeeded");

    expect(postMessage).toHaveBeenCalledTimes(4);
    const calls = postMessage.mock.calls;
    // All replies share the same root thread_ts.
    expect(calls[1]?.[0]).toMatchObject({ thread_ts: "1700000000.000100" });
    expect(calls[2]?.[0]).toMatchObject({ thread_ts: "1700000000.000100" });
    expect(calls[3]?.[0]).toMatchObject({ thread_ts: "1700000000.000100" });
    // Re-dispatch text includes the attempt counter.
    expect(calls[2]?.[0].text).toContain("attempt 1");
  });
});

describe("SlackObserver — rejection alerts (B-8)", () => {
  it("posts the first rejection alert, then dampens identical (kind, reason) pairs within 5 min", async () => {
    const { SlackObserver } = await import("../../src/observability/slack.js");
    postMessage.mockResolvedValue({ ok: true, ts: "1700000000.000999" });

    const slack = new SlackObserver({ token: "xoxb-ok", channelId: "C123" });
    // Same (kind, reason) hammered 5x in one tick — should fire ONCE.
    for (let i = 0; i < 5; i++) {
      await slack.announceRejection({
        kind: "cost_cap",
        reason: "daily cap exceeded ($250)",
        issueIdentifier: `JUMP-${100 + i}`,
      });
    }
    expect(postMessage).toHaveBeenCalledTimes(1);
    // 4 dampened drops + 0 unrelated warns.
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("does not dampen across distinct reasons", async () => {
    const { SlackObserver } = await import("../../src/observability/slack.js");
    postMessage.mockResolvedValue({ ok: true, ts: "1700000000.001000" });

    const slack = new SlackObserver({ token: "xoxb-ok", channelId: "C123" });
    await slack.announceRejection({ kind: "cost_cap", reason: "daily cap exceeded" });
    await slack.announceRejection({ kind: "cost_cap", reason: "per-issue cap exceeded" });
    // Different reasons ⇒ both fire.
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("ignores per-issue 5s gap (rejection alerts are channel-level)", async () => {
    const { SlackObserver } = await import("../../src/observability/slack.js");
    postMessage.mockResolvedValue({ ok: true, ts: "1700000000.001000" });

    const slack = new SlackObserver({ token: "xoxb-ok", channelId: "C123" });
    await slack.announceDispatch(issue, null);
    // Different reason than dispatch ⇒ should fire even though same channel.
    await slack.announceRejection({
      kind: "kill_switch",
      reason: "engaged for incident X",
    });
    // 1 dispatch + 1 rejection (per-issue 5s gate doesn't apply to rejections).
    expect(postMessage).toHaveBeenCalledTimes(3); // root + dispatch reply + rejection
  });
});
