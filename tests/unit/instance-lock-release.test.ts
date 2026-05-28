import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { acquireInstanceLock } from "../../src/singleton/instance-lock.js";

/**
 * Idempotency guard for the singleton-lock `release()` returned from
 * `acquireInstanceLock`.
 *
 * The shutdown path in `main.ts` calls `release()` TWICE on purpose:
 *
 *   1. EARLY — right after `gracefulStop` halts dispatches synchronously,
 *      so the next Cloud Run revision can boot and start dispatching while
 *      this instance drains in-flight turns. Without an early release,
 *      Cloud Run kills the cloud-sql-proxy sidecar before our unlock query
 *      lands, the PG session-scoped advisory lock survives until Postgres
 *      reaps the orphan TCP session, and the next revision spends ~60s in
 *      `advisory lock not yet free; retrying in 1s` before crashing its
 *      startup probe. (Observed on every Symphony deploy until 2026-05-06.)
 *
 *   2. POST-DRAIN — defensive fallback, runs after `gracefulStop` resolves.
 *      Must be a safe no-op when the early release already fired, otherwise
 *      `pg.PoolClient.release()` throws "Release called on client which has
 *      already been released".
 *
 * These tests assert the second `release()` is a no-op: the pg client is
 * unlocked + released exactly once across both calls.
 */

interface FakePoolClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

interface FakePool {
  query: ReturnType<typeof vi.fn>;
  connect: () => Promise<FakePoolClient>;
}

function makeFakeClient(): FakePoolClient {
  return {
    query: vi.fn(async (sql: string) => {
      // pg_try_advisory_lock — succeeds first try
      if (sql.startsWith("SELECT pg_try_advisory_lock")) {
        return { rows: [{ pg_try_advisory_lock: true }] };
      }
      // pg_advisory_unlock — also succeeds
      if (sql.startsWith("SELECT pg_advisory_unlock")) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      // INSERT into instance_lock — happy path, no return value needed.
      return { rows: [] };
    }),
    release: vi.fn(),
    on: vi.fn(),
  };
}

function makeFakePool(client: FakePoolClient): FakePool {
  return {
    query: vi.fn(async () => ({ rows: [] })), // readHeartbeat — empty = no prior holder
    connect: async () => client,
  };
}

describe("instance-lock release() idempotency", () => {
  beforeEach(() => {
    // Use fake timers so the heartbeat interval doesn't actually fire on the
    // node event loop and prevent the test process from exiting cleanly.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("first release() runs unlock + client.release exactly once", async () => {
    const client = makeFakeClient();
    const pool = makeFakePool(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = await acquireInstanceLock(pool as any);

    expect(handle.instanceId).toMatch(/local-/); // K_REVISION not set in test env
    await handle.release();

    const unlockCalls = client.query.mock.calls.filter((args) =>
      String(args[0]).startsWith("SELECT pg_advisory_unlock"),
    );
    expect(unlockCalls).toHaveLength(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("second release() is a safe no-op (does not double-call pg client.release)", async () => {
    const client = makeFakeClient();
    const pool = makeFakePool(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = await acquireInstanceLock(pool as any);

    await handle.release();
    await handle.release(); // Defensive fallback in main.ts shutdown.

    const unlockCalls = client.query.mock.calls.filter((args) =>
      String(args[0]).startsWith("SELECT pg_advisory_unlock"),
    );
    expect(unlockCalls).toHaveLength(1); // unlocked exactly once
    expect(client.release).toHaveBeenCalledTimes(1); // released to pool exactly once
  });

  it("third release() is also a no-op (covers paranoid call sites)", async () => {
    const client = makeFakeClient();
    const pool = makeFakePool(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = await acquireInstanceLock(pool as any);

    await handle.release();
    await handle.release();
    await handle.release();

    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("release() swallows pg_advisory_unlock errors but still returns the client to the pool", async () => {
    const client = makeFakeClient();
    // Make unlock blow up — simulates a dead socket from an early proxy SIGTERM.
    client.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT pg_try_advisory_lock")) {
        return { rows: [{ pg_try_advisory_lock: true }] };
      }
      if (sql.startsWith("SELECT pg_advisory_unlock")) {
        throw new Error("connection terminated");
      }
      return { rows: [] };
    });
    const pool = makeFakePool(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = await acquireInstanceLock(pool as any);

    // Must NOT throw — `finally` block must always release the client.
    await expect(handle.release()).resolves.toBeUndefined();
    expect(client.release).toHaveBeenCalledTimes(1);

    // Idempotency still holds when the first call hit an error.
    await handle.release();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
