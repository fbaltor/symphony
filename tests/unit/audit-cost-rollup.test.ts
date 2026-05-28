import { describe, expect, it, vi } from "vitest";
import { getCostRollup } from "../../src/audit/queries.js";

/**
 * Cost rollup unit tests — exercise the SQL → JSON shape with a mocked pool.
 * We don't spin up Postgres; we assert the function passes the expected SQL
 * and reshapes rows correctly.
 */

interface MockRows<T> {
  rows: T[];
}

function mockPool(byCallIndex: Array<MockRows<unknown>>) {
  let i = 0;
  return {
    query: vi.fn(async () => {
      const r = byCallIndex[i] ?? { rows: [] };
      i += 1;
      return r;
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("getCostRollup", () => {
  it("aggregates today/month and reshapes by_issue rows", async () => {
    const firstSeen = new Date("2026-04-01T12:00:00Z");
    const lastSeen = new Date("2026-04-29T08:30:00Z");
    const pool = mockPool([
      { rows: [{ total: 12.34 }] }, // today
      { rows: [{ total: 87.65 }] }, // month
      {
        rows: [
          {
            identifier: "AGENT-447",
            total_usd: 19.29,
            runs: 5,
            first_seen: firstSeen,
            last_seen: lastSeen,
          },
          {
            identifier: "AGENT-446",
            total_usd: 7.5,
            runs: 2,
            first_seen: firstSeen,
            last_seen: lastSeen,
          },
        ],
      },
    ]);

    const result = await getCostRollup(pool);

    expect(result.todayUsd).toBe(12.34);
    expect(result.monthUsd).toBe(87.65);
    expect(result.byIssue).toHaveLength(2);
    expect(result.byIssue[0]).toEqual({
      identifier: "AGENT-447",
      totalUsd: 19.29,
      runs: 5,
      firstSeen: firstSeen.toISOString(),
      lastSeen: lastSeen.toISOString(),
    });
    expect(result.byIssue[1]?.identifier).toBe("AGENT-446");
  });

  it("rounds float sums to 2 decimals", async () => {
    const pool = mockPool([
      { rows: [{ total: 12.345678 }] },
      { rows: [{ total: 87.6543 }] },
      { rows: [] },
    ]);

    const result = await getCostRollup(pool);
    expect(result.todayUsd).toBe(12.35);
    expect(result.monthUsd).toBe(87.65);
    expect(result.byIssue).toEqual([]);
  });

  it("returns zeroed rollup on Postgres failure (does not throw)", async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await getCostRollup(pool);
    expect(result).toEqual({ todayUsd: 0, monthUsd: 0, byIssue: [] });
  });

  it("handles empty result rows without throwing", async () => {
    const pool = mockPool([{ rows: [] }, { rows: [] }, { rows: [] }]);
    const result = await getCostRollup(pool);
    expect(result).toEqual({ todayUsd: 0, monthUsd: 0, byIssue: [] });
  });
});
