import { describe, expect, it, vi } from "vitest";
import {
  recordRunStart,
  recordRunEnd,
  reapOrphanedRuns,
} from "../../src/audit/writer.js";

/**
 * Task 2 (2026-05-06) — audit reconciliation regression suite.
 *
 * PROJ-521 demonstrated the cost-truth gap: 6 OOM'd Implement
 * dispatches produced ZERO audit rows because the OOM kill happened
 * before the `runWorker` finally block could fire. Real Anthropic
 * spend ($5–$15) was therefore invisible to `/cost`.
 *
 * Fix: each worker writes a `running_runs` row on dispatch and
 * deletes on terminal outcome. The orphan reaper at boot finds rows
 * from a previous instance and writes synthetic `outcome=Killed`
 * audit rows so the table reflects reality (count of killed runs;
 * cost is uncosted but flagged in `extra.killed`).
 *
 * Tests cover the full lifecycle: write, end, and reap-from-different-
 * instance. Mocks the pg pool — does not require real Postgres.
 */

interface FakePool {
  query: ReturnType<typeof vi.fn>;
}

function makePool(behavior: {
  rows?: Array<{
    issue_id: string;
    issue_identifier: string;
    instance_id: string;
    attempt: number | null;
    session_id: string | null;
    started_at: Date;
  }>;
  insertThrows?: boolean;
  selectThrows?: boolean;
  deleteThrows?: boolean;
  auditInsertThrows?: boolean;
}): FakePool {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO running_runs")) {
        if (behavior.insertThrows) throw new Error("simulated insert failure");
        return { rows: [] };
      }
      if (sql.includes("SELECT") && sql.includes("running_runs")) {
        if (behavior.selectThrows) throw new Error("simulated select failure");
        return { rows: behavior.rows ?? [] };
      }
      if (sql.includes("DELETE FROM running_runs")) {
        if (behavior.deleteThrows) throw new Error("simulated delete failure");
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO run_audit")) {
        if (behavior.auditInsertThrows) throw new Error("simulated audit insert failure");
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

describe("recordRunStart / recordRunEnd", () => {
  it("recordRunStart issues an upsert into running_runs", async () => {
    const pool = makePool({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordRunStart(pool as any, {
      issueId: "issue-uuid-1",
      issueIdentifier: "PROJ-521",
      instanceId: "rev-00020-r5k-abc",
      attempt: 1,
      sessionId: "session-xyz",
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const sql = String(pool.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("INSERT INTO running_runs");
    expect(sql).toContain("ON CONFLICT");
    expect(pool.query.mock.calls[0]?.[1]).toEqual([
      "issue-uuid-1",
      "PROJ-521",
      "rev-00020-r5k-abc",
      1,
      "session-xyz",
    ]);
  });

  it("recordRunStart swallows DB errors (best-effort)", async () => {
    const pool = makePool({ insertThrows: true });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recordRunStart(pool as any, {
        issueId: "issue-1",
        issueIdentifier: "PROJ-521",
        instanceId: "rev-00020-r5k-abc",
        attempt: 1,
        sessionId: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("recordRunEnd issues a DELETE keyed on (issue_id, instance_id)", async () => {
    const pool = makePool({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordRunEnd(pool as any, {
      issueId: "issue-uuid-1",
      instanceId: "rev-00020-r5k-abc",
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const sql = String(pool.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("DELETE FROM running_runs");
    expect(pool.query.mock.calls[0]?.[1]).toEqual(["issue-uuid-1", "rev-00020-r5k-abc"]);
  });

  it("recordRunEnd swallows DB errors", async () => {
    const pool = makePool({ deleteThrows: true });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recordRunEnd(pool as any, {
        issueId: "issue-1",
        instanceId: "rev-00020-r5k-abc",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("reapOrphanedRuns", () => {
  it("returns 0 when no orphaned rows exist", async () => {
    const pool = makePool({ rows: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reaped = await reapOrphanedRuns(pool as any, "rev-00021-new");
    expect(reaped).toBe(0);
  });

  it("writes a synthetic Killed audit row + deletes for each orphan", async () => {
    const pool = makePool({
      rows: [
        {
          issue_id: "agent-521-uuid",
          issue_identifier: "PROJ-521",
          instance_id: "rev-00020-r5k-abc",
          attempt: 1,
          session_id: "session-1",
          started_at: new Date("2026-05-06T14:46:40Z"),
        },
        {
          issue_id: "agent-522-uuid",
          issue_identifier: "PROJ-522",
          instance_id: "rev-00020-r5k-abc",
          attempt: 2,
          session_id: null,
          started_at: new Date("2026-05-06T14:50:00Z"),
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reaped = await reapOrphanedRuns(pool as any, "rev-00021-new");
    expect(reaped).toBe(2);

    // Inspect the audit-row inserts.
    const auditCalls = pool.query.mock.calls.filter((c) =>
      String(c[0] ?? "").includes("INSERT INTO run_audit"),
    );
    expect(auditCalls).toHaveLength(2);
    // First audit row params: outcome at index 6,
    // cost_usd at 12, error at 13, prompt_version at 14,
    // cache_creation_input_tokens at 15, cache_read_input_tokens at 16,
    // extra at 17. The two cache columns were appended before extra so
    // the `extra` JSONB stays at the tail; older rows (orphan reaper)
    // pass through 0-defaults for the cache columns.
    const firstParams = (auditCalls[0]?.[1] as unknown[]) ?? [];
    expect(firstParams[1]).toBe("PROJ-521"); // issue_identifier
    expect(firstParams[6]).toBe("Killed"); // outcome
    expect(firstParams[12]).toBe(0); // cost_usd
    expect(String(firstParams[13])).toContain("container died");
    expect(firstParams[15]).toBe(0); // cache_creation_input_tokens (Killed has none)
    expect(firstParams[16]).toBe(0); // cache_read_input_tokens (Killed has none)
    expect(String(firstParams[17])).toContain('"killed":true');
    expect(String(firstParams[17])).toContain('"reapedFromInstance":"rev-00020-r5k-abc"');
    expect(String(firstParams[17])).toContain('"reapedByInstance":"rev-00021-new"');

    // And the corresponding deletes.
    const deleteCalls = pool.query.mock.calls.filter((c) =>
      String(c[0] ?? "").includes("DELETE FROM running_runs"),
    );
    expect(deleteCalls).toHaveLength(2);
  });

  it("excludes self — current instance's rows are NOT reaped", async () => {
    // The SQL filter is `instance_id != $1` — this test verifies the
    // parameter is wired correctly. We send rows that all belong to the
    // current instance; the SELECT mock returns []  because the WHERE
    // clause filters them server-side, but we verify the bind param.
    const pool = makePool({ rows: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reapOrphanedRuns(pool as any, "rev-00021-self");
    const selectCall = pool.query.mock.calls.find((c) =>
      String(c[0] ?? "").includes("SELECT") && String(c[0] ?? "").includes("running_runs"),
    );
    expect(selectCall?.[1]).toEqual(["rev-00021-self"]);
  });

  it("survives the SELECT failing (logs warning, returns 0)", async () => {
    const pool = makePool({ selectThrows: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reaped = await reapOrphanedRuns(pool as any, "rev-00021-new");
    expect(reaped).toBe(0);
    // No audit-row inserts attempted.
    const auditCalls = pool.query.mock.calls.filter((c) =>
      String(c[0] ?? "").includes("INSERT INTO run_audit"),
    );
    expect(auditCalls).toHaveLength(0);
  });

  it("continues reaping if one row's DELETE fails (per-row best effort)", async () => {
    // Both audit-row writes succeed; one DELETE throws. Reaper still
    // reports 2 because each row's audit row landed.
    const pool = makePool({
      rows: [
        {
          issue_id: "issue-1",
          issue_identifier: "AGENT-A",
          instance_id: "rev-old",
          attempt: 1,
          session_id: null,
          started_at: new Date(),
        },
        {
          issue_id: "issue-2",
          issue_identifier: "AGENT-B",
          instance_id: "rev-old",
          attempt: 1,
          session_id: null,
          started_at: new Date(),
        },
      ],
    });
    // Make the second DELETE throw via call-counter
    let deleteCount = 0;
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO running_runs")) return { rows: [] };
      if (sql.includes("SELECT") && sql.includes("running_runs")) {
        return {
          rows: [
            {
              issue_id: "issue-1",
              issue_identifier: "AGENT-A",
              instance_id: "rev-old",
              attempt: 1,
              session_id: null,
              started_at: new Date(),
            },
            {
              issue_id: "issue-2",
              issue_identifier: "AGENT-B",
              instance_id: "rev-old",
              attempt: 1,
              session_id: null,
              started_at: new Date(),
            },
          ],
        };
      }
      if (sql.includes("DELETE FROM running_runs")) {
        deleteCount += 1;
        if (deleteCount === 2) throw new Error("simulated delete failure");
        return { rows: [] };
      }
      return { rows: [] };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reaped = await reapOrphanedRuns(pool as any, "rev-new");
    expect(reaped).toBe(2);
  });
});
