/**
 * Unit tests for `fetchPullRequestForIssue` — the GitHub helper the
 * orchestrator's Release-stage merge-verify guard relies on.
 *
 * Background (2026-05-07 production cutover defect): the Release specialist
 * runs `gh pr merge --squash --delete-branch` to land a sub-issue's PR. On
 * rare-but-real paths (red CI; transient GitHub 5xx; agent timed out before
 * merge) the merge command DOESN'T succeed but the LLM turn still reports
 * `outcome=Succeeded`. The orchestrator then default-advances Release → Done
 * per `state_transitions["Release"]`, marking the sub Done with the PR still
 * open. Real symptom on STG-17.
 *
 * The fix: orchestrator calls this helper before the auto-advance and
 * confirms `merged_at` is non-null. If merged, advance normally. If still
 * open / closed-without-merge, route the issue back to Pull request.
 *
 * The helper queries GitHub's search API (which lets us match
 * "Closes <ID> in:body") and follows up with pulls.get for `merged_at` +
 * head SHA. These tests stub `globalThis.fetch` to exercise the response
 * branches without hitting the real GitHub API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchPullRequestForIssue } from "../../src/lib/github.js";

/**
 * Build a fake `Response` for a given JSON body / status.
 */
function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchPullRequestForIssue", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns merged status when the PR exists and is merged", async () => {
    // First call: search API returns one PR. Second call: pulls.get returns
    // merged_at non-null.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              number: 42,
              state: "closed",
              html_url: "https://github.com/o/r/pull/42",
              pull_request: { merged_at: "2026-05-07T18:00:00Z" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          merged_at: "2026-05-07T18:00:00Z",
          state: "closed",
          head: { sha: "abc123" },
          html_url: "https://github.com/o/r/pull/42",
        }),
      );

    const result = await fetchPullRequestForIssue("ghs_test", "STG-42", {
      owner: "o",
      repo: "r",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect(result!.number).toBe(42);
    expect(result!.mergedAt).toBe("2026-05-07T18:00:00Z");
    expect(result!.state).toBe("closed");
    expect(result!.headRefOid).toBe("abc123");
    expect(result!.htmlUrl).toBe("https://github.com/o/r/pull/42");
  });

  it("returns mergedAt=null when the PR is still open (caller bounces)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              number: 99,
              state: "open",
              html_url: "https://github.com/o/r/pull/99",
              pull_request: { merged_at: null },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          merged_at: null,
          state: "open",
          head: { sha: "def456" },
          html_url: "https://github.com/o/r/pull/99",
        }),
      );

    const result = await fetchPullRequestForIssue("ghs_test", "STG-99", {
      owner: "o",
      repo: "r",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).not.toBeNull();
    expect(result).not.toBeUndefined();
    expect(result!.mergedAt).toBeNull();
    expect(result!.state).toBe("open");
  });

  it("returns null when search returns no items (no PR found → bounce)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    const result = await fetchPullRequestForIssue("ghs_test", "STG-17", {
      owner: "o",
      repo: "r",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBeNull();
    // Only one call — pulls.get is never reached when search is empty.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined on search 5xx (transient → fail open)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 503, headers: { "content-type": "application/json" } }),
    );

    const result = await fetchPullRequestForIssue("ghs_test", "STG-17", {
      owner: "o",
      repo: "r",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when search throws (network failure → fail open)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));

    const result = await fetchPullRequestForIssue("ghs_test", "STG-17", {
      owner: "o",
      repo: "r",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when pulls.get fails (transient → fail open)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              number: 42,
              state: "closed",
              html_url: "https://github.com/o/r/pull/42",
              pull_request: { merged_at: "2026-05-07T18:00:00Z" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      );

    const result = await fetchPullRequestForIssue("ghs_test", "STG-42", {
      owner: "o",
      repo: "r",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toBeUndefined();
  });

  it("uses the search API with the issue identifier in the body filter", async () => {
    // Verifies the encoded query — guard against the regression of building
    // the wrong URL (e.g., dropping `in:body` and matching by branch name
    // instead, which would also pick up unrelated PRs).
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await fetchPullRequestForIssue("ghs_test", "STG-99", {
      owner: "owner-x",
      repo: "repo-y",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/search/issues?q=");
    // Search query is URL-encoded — `repo:` becomes `repo%3A`, spaces are `+`
    // or `%20`. Don't bind the test to URLSearchParams' exact encoding; just
    // confirm the load-bearing tokens survive the round trip.
    expect(decodeURIComponent(String(url))).toContain("repo:owner-x/repo-y");
    expect(decodeURIComponent(String(url))).toContain("type:pr");
    expect(decodeURIComponent(String(url))).toContain("STG-99");
    expect(decodeURIComponent(String(url))).toContain("in:body");
  });

  it("authenticates with bearer token and passes Accept + API version headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await fetchPullRequestForIssue("ghs_test_token", "STG-1", {
      owner: "o",
      repo: "r",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghs_test_token");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    // User-Agent is always set (see lib/build-info.ts buildIdentifier).
    const userAgent = headers["User-Agent"];
    expect(typeof userAgent).toBe("string");
    expect(userAgent && userAgent.length).toBeGreaterThan(0);
  });
});
