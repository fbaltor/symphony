import { describe, expect, it, vi } from "vitest";
import { getUsageRollup } from "../../src/audit/queries.js";

/**
 * Usage rollup — exercises the SQL → JSON shape with a mocked pool (no
 * Postgres). getUsageRollup fires three grouped queries (5h, 24h, 7d) in order
 * via Promise.all; the mock returns rows per call index. bigint columns come
 * back as strings from `pg`, so we assert they're coerced to numbers.
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

describe("getUsageRollup", () => {
  it("sums per-model rows into window totals and coerces bigint strings", async () => {
    const pool = mockPool([
      // 5h window
      {
        rows: [
          { model: "claude-opus-4-8", turns: 1, in_tok: "3595", out_tok: "27123", tot_tok: "30718", usd: 15.12 },
          { model: "claude-sonnet-4-6", turns: 2, in_tok: "184", out_tok: "2775", tot_tok: "2959", usd: 0.64 },
        ],
      },
      // 24h window
      { rows: [{ model: "claude-opus-4-8", turns: 1, in_tok: "3595", out_tok: "27123", tot_tok: "30718", usd: 15.12 }] },
      // 7d window (empty)
      { rows: [] },
    ]);

    const r = await getUsageRollup(pool);

    // 5h totals = sum across the two models
    expect(r.window_5h.turns).toBe(3);
    expect(r.window_5h.outputTokens).toBe(27123 + 2775);
    expect(r.window_5h.inputTokens).toBe(3595 + 184);
    expect(r.window_5h.costUsd).toBe(15.76);
    expect(r.window_5h.byModel).toHaveLength(2);
    // bigint coercion: strings → numbers
    expect(r.window_5h.byModel[0].outputTokens).toBe(27123);
    expect(typeof r.window_5h.byModel[0].outputTokens).toBe("number");

    expect(r.window_24h.turns).toBe(1);
    expect(r.window_24h.outputTokens).toBe(27123);

    // empty window → zeroed totals, empty byModel
    expect(r.window_7d.turns).toBe(0);
    expect(r.window_7d.byModel).toEqual([]);
    expect(r.window_7d.costUsd).toBe(0);
  });

  it("returns a zeroed rollup (never throws) when the pool query fails", async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const r = await getUsageRollup(pool);
    expect(r.window_5h.turns).toBe(0);
    expect(r.window_24h.byModel).toEqual([]);
    expect(r.window_7d.costUsd).toBe(0);
  });
});
