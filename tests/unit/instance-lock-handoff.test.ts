import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { acquireInstanceLock } from "../../src/singleton/instance-lock.js";

/**
 * PROJ-520 — cooperative singleton-lock handoff regression suite.
 *
 * Closes the deploy-deadlock pattern where Cloud Run won't SIGTERM the
 * old revision until the new one is healthy, but the new one can't be
 * healthy without the lock.
 *
 * Flow under test:
 *
 *   1. New instance can't claim lock immediately (heartbeat is fresh).
 *   2. New instance writes a row to `symphony.instance_lock_handoff`.
 *   3. Old instance's heartbeat tick polls that table; finds a request
 *      from a DIFFERENT instance_id, fires `onHandoffRequested`.
 *   4. Caller of `acquireInstanceLock` (typically main.ts) routes the
 *      callback to its existing SIGTERM-shaped shutdown path.
 *
 * Tests cover both sides: the new instance writes the request when
 * blocked, and the old instance fires the callback when it sees one.
 */

interface FakePoolClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function makeFakeClient(opts: { advisoryLockSucceeds?: boolean } = {}): FakePoolClient {
  const advisoryLockSucceeds = opts.advisoryLockSucceeds ?? true;
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT pg_try_advisory_lock")) {
        return { rows: [{ pg_try_advisory_lock: advisoryLockSucceeds }] };
      }
      if (sql.startsWith("SELECT pg_advisory_unlock")) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      // INSERT/UPDATE on instance_lock — happy path.
      return { rows: [] };
    }),
    release: vi.fn(),
    on: vi.fn(),
  };
}

describe("instance-lock cooperative handoff (PROJ-520)", () => {
  beforeEach(() => {
    // Fake timers so the heartbeat interval doesn't keep the test event
    // loop hot after the assertions land.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes a handoff request row when the existing heartbeat is fresh", async () => {
    // Pool's first heartbeat read returns a fresh row → wait loop kicks in.
    // Subsequent reads return the same fresh row until we let it lapse.
    let heartbeatReads = 0;
    const handoffRowsByQuery: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: vi.fn(async (sql: string, values?: any[]) => {
        if (sql.includes("FROM instance_lock WHERE id = 1")) {
          heartbeatReads += 1;
          if (heartbeatReads <= 2) {
            // Heartbeat is fresh — block the wait loop.
            return {
              rows: [{ instance_id: "old-instance-abc123", heartbeat_at: new Date() }],
            };
          }
          // After 2 reads, return null → wait loop breaks, advisory-lock
          // path runs and we want it to succeed so the test cleanly
          // resolves.
          return { rows: [] };
        }
        if (sql.includes("instance_lock_handoff")) {
          handoffRowsByQuery.push({ sql, values: values ?? [] });
          return { rows: [] };
        }
        return { rows: [] };
      }),
      connect: async () => makeFakeClient(),
    };

    // Drive the wait loop: each `sleep(2_000)` inside acquireInstanceLock is
    // an awaitable on the fake timer. Run the bootstrap + advance timers in
    // parallel so the loop can progress.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acquirePromise = acquireInstanceLock(pool as any);
    // First sleep is 2s; advance enough to let the wait loop fire 2 reads.
    await vi.advanceTimersByTimeAsync(5_000);
    const handle = await acquirePromise;

    // The handoff INSERT should have been issued exactly once (idempotent
    // upsert; the wait loop guards on `wroteHandoffRequest`).
    const handoffWrites = handoffRowsByQuery.filter((q) =>
      q.sql.includes("INSERT INTO symphony.instance_lock_handoff"),
    );
    expect(handoffWrites).toHaveLength(1);
    expect(handoffWrites[0]?.values[0]).toBe(handle.instanceId);

    await handle.release();
  });

  it("fires onHandoffRequested when heartbeat tick sees a request from another instance", async () => {
    const client = makeFakeClient();
    // Pool's heartbeat read returns nothing → wait loop breaks immediately,
    // we get the lock cleanly.
    // The handoff poll (run from the heartbeat timer) returns ONE row from
    // a DIFFERENT instance_id, triggering the callback.
    const onHandoffRequested = vi.fn();
    let handoffPollCount = 0;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM instance_lock WHERE id = 1")) {
          return { rows: [] }; // no existing instance — fast path
        }
        if (sql.includes("instance_lock_handoff")) {
          handoffPollCount += 1;
          // Return a row claiming a different instance is requesting handoff.
          return {
            rows: [
              {
                requesting_instance_id: "new-instance-xyz789",
                requested_at: new Date(),
              },
            ],
          };
        }
        return { rows: [] };
      }),
      connect: async () => client,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = await acquireInstanceLock(pool as any, { onHandoffRequested });

    // Advance the heartbeat timer — first tick should both heartbeat AND
    // poll the handoff table, fire the callback.
    await vi.advanceTimersByTimeAsync(6_000);
    // Drain microtasks (the handoff poll uses .then chains).
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(onHandoffRequested).toHaveBeenCalledTimes(1);
    expect(handoffPollCount).toBeGreaterThanOrEqual(1);

    // A second tick must NOT re-fire the callback (handoffSignaled guard).
    await vi.advanceTimersByTimeAsync(6_000);
    await Promise.resolve();
    expect(onHandoffRequested).toHaveBeenCalledTimes(1);

    await handle.release();
  });

  it("does NOT fire onHandoffRequested when the request row is from SELF", async () => {
    const client = makeFakeClient();
    let capturedSelfId = "";
    const onHandoffRequested = vi.fn();
    const pool = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: vi.fn(async (sql: string, values?: any[]) => {
        if (sql.includes("FROM instance_lock WHERE id = 1")) {
          return { rows: [] };
        }
        if (sql.includes("instance_lock_handoff")) {
          // Capture self_id from the parameterized query for verification
          // (the query filters `requesting_instance_id != $1`, so a row from
          // self is filtered server-side; we simulate the empty result).
          capturedSelfId = (values?.[0] as string | undefined) ?? "";
          return { rows: [] };
        }
        return { rows: [] };
      }),
      connect: async () => client,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = await acquireInstanceLock(pool as any, { onHandoffRequested });
    await vi.advanceTimersByTimeAsync(6_000);
    await Promise.resolve();

    expect(capturedSelfId).toBe(handle.instanceId);
    expect(onHandoffRequested).not.toHaveBeenCalled();
    await handle.release();
  });

  it("deletes the handoff request row after acquiring the lock", async () => {
    const client = makeFakeClient();
    const handoffOps: string[] = [];
    const pool = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: vi.fn(async (sql: string, _values?: any[]) => {
        if (sql.includes("FROM instance_lock WHERE id = 1")) {
          return { rows: [] };
        }
        if (sql.includes("instance_lock_handoff")) {
          if (sql.includes("DELETE")) handoffOps.push("delete");
          else if (sql.includes("INSERT")) handoffOps.push("insert");
          else if (sql.includes("SELECT")) handoffOps.push("select");
          return { rows: [] };
        }
        return { rows: [] };
      }),
      connect: async () => client,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = await acquireInstanceLock(pool as any);
    // The DELETE fires from a fire-and-forget .then() chain after
    // LOG_EVENT_LOCK_ACQUIRED logs. Drain microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(handoffOps).toContain("delete");
    await handle.release();
  });

  it("survives handoff-poll DB error (logs warning, continues heartbeating)", async () => {
    const client = makeFakeClient();
    const onHandoffRequested = vi.fn();
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM instance_lock WHERE id = 1")) {
          return { rows: [] };
        }
        if (sql.includes("instance_lock_handoff") && sql.includes("SELECT")) {
          throw new Error("simulated handoff poll DB error");
        }
        return { rows: [] };
      }),
      connect: async () => client,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = await acquireInstanceLock(pool as any, { onHandoffRequested });
    await vi.advanceTimersByTimeAsync(6_000);
    await Promise.resolve();
    await Promise.resolve();

    // No callback fired (poll errored), but lock is still healthy.
    expect(onHandoffRequested).not.toHaveBeenCalled();
    // The heartbeat UPDATE itself ran (separate query, didn't throw).
    const heartbeatUpdates = client.query.mock.calls.filter((c) =>
      String(c[0] ?? "").includes("UPDATE instance_lock SET heartbeat_at"),
    );
    expect(heartbeatUpdates.length).toBeGreaterThanOrEqual(1);
    await handle.release();
  });

  it("survives handoff-write DB error during the wait loop (passive fallback)", async () => {
    let heartbeatReads = 0;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM instance_lock WHERE id = 1")) {
          heartbeatReads += 1;
          if (heartbeatReads <= 1) {
            return {
              rows: [{ instance_id: "old-instance", heartbeat_at: new Date() }],
            };
          }
          return { rows: [] };
        }
        if (sql.includes("instance_lock_handoff") && sql.includes("INSERT")) {
          throw new Error("simulated handoff write error");
        }
        return { rows: [] };
      }),
      connect: async () => makeFakeClient(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acquirePromise = acquireInstanceLock(pool as any);
    await vi.advanceTimersByTimeAsync(5_000);
    const handle = await acquirePromise;

    // We still got the lock despite the handoff write failing — the wait
    // loop fell back to passive waiting and the heartbeat went stale.
    expect(handle.instanceId).toBeTruthy();
    await handle.release();
  });
});
