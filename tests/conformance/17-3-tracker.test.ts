import { describe, expect, it } from "vitest";
import { LinearTrackerClient } from "../../src/tracker/linear.js";
import { TrackerError } from "../../src/tracker/errors.js";
import { normalizeIssue } from "../../src/tracker/normalize.js";

/**
 * Spec §17.3 — Issue Tracker Client.
 */

describe("§17.3 tracker client", () => {
  it("rejects construction without api_key", () => {
    expect(() => new LinearTrackerClient({ endpoint: "x", apiKey: "", projectSlug: "p" })).toThrow(
      TrackerError,
    );
  });
  it("rejects construction when neither project_slug nor team_id is set", () => {
    expect(() => new LinearTrackerClient({ endpoint: "x", apiKey: "k" })).toThrow(TrackerError);
    expect(
      () => new LinearTrackerClient({ endpoint: "x", apiKey: "k", projectSlug: "", teamId: "" }),
    ).toThrow(TrackerError);
  });

  it("accepts team_id alone (team mode)", () => {
    expect(
      () =>
        new LinearTrackerClient({
          endpoint: "x",
          apiKey: "k",
          teamId: "ddf4cae6-f203-4a16-bc42-646c2b8610c1",
        }),
    ).not.toThrow();
  });

  it("returns empty list immediately for fetchIssuesByStates([])", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response("{}");
    };
    const c = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "k",
      projectSlug: "p",
      fetchImpl,
    });
    expect(await c.fetchIssuesByStates([])).toEqual([]);
    expect(calls).toBe(0);
  });

  it("normalizes labels to lowercase and blockers from inverseRelations", () => {
    const out = normalizeIssue({
      id: "1",
      identifier: "ABC-1",
      title: "t",
      priority: 2.0,
      state: { name: "Todo" },
      labels: { nodes: [{ name: "Bug" }, { name: "FRONTEND" }] },
      inverseRelations: {
        nodes: [
          { type: "blocks", issue: { id: "2", identifier: "ABC-2", state: { name: "Done" } } },
          {
            type: "duplicate_of",
            issue: { id: "3", identifier: "ABC-3", state: { name: "Todo" } },
          },
        ],
      },
    });
    expect(out.labels).toEqual(["bug", "frontend"]);
    expect(out.blockedBy).toHaveLength(1);
    expect(out.blockedBy[0]?.identifier).toBe("ABC-2");
  });

  it("throws linear_api_status on non-200", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 });
    const c = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "k",
      projectSlug: "p",
      fetchImpl,
    });
    await expect(c.fetchIssueStatesByIds(["x"])).rejects.toBeInstanceOf(TrackerError);
  });

  it("throws linear_graphql_errors when payload contains errors[]", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ errors: [{ message: "boom" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const c = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "k",
      projectSlug: "p",
      fetchImpl,
    });
    await expect(c.fetchIssueStatesByIds(["x"])).rejects.toMatchObject({
      code: "linear_graphql_errors",
    });
  });

  it("paginates through endCursor", async () => {
    const pages = [
      {
        data: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [
              {
                id: "1",
                identifier: "ABC-1",
                title: "t",
                state: { name: "Todo" },
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            ],
          },
        },
      },
      {
        data: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "2",
                identifier: "ABC-2",
                title: "t",
                state: { name: "Todo" },
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            ],
          },
        },
      },
    ];
    let i = 0;
    const fetchImpl = async () => {
      const body = pages[i++];
      if (!body) throw new Error(`unexpected fetch beyond mocked pages (${i})`);
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    };
    const c = new LinearTrackerClient({
      endpoint: "https://api.linear.app/graphql",
      apiKey: "k",
      projectSlug: "p",
      fetchImpl,
    });
    const out = await c.fetchCandidateIssues(["Todo"]);
    expect(out.map((x) => x.identifier)).toEqual(["ABC-1", "ABC-2"]);
  });
});
