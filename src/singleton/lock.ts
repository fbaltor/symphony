import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Clock } from "../lib/clock.js";
import {
  acquireInstanceLock,
  type AcquireInstanceLockOpts,
  type InstanceLockHandle,
} from "./instance-lock.js";

/**
 * Phase D (zero-dep E2E) — the `InstanceLock` seam.
 *
 * The single-orchestrator advisory lock (`acquireInstanceLock`) coordinates
 * the Cloud Run rolling-deploy handoff via Postgres. This interface lets the
 * orchestrator's composition root pick between the real Postgres-backed lock
 * and an in-memory, single-process analogue used by the zero-dependency E2E
 * profile and the lock unit tests.
 *
 * Two impls:
 *   - `PostgresInstanceLock` — thin wrapper that delegates to the unchanged
 *     `acquireInstanceLock(pool, opts)`. The `kind=linear` profile behaves
 *     byte-for-byte as before.
 *   - `MemoryInstanceLock` — decision 2b: a *simulated* lock. Lease/heartbeat
 *     are modelled against an injected `Clock`, so two logical instances can
 *     contend in one process and a holder's lease can age out deterministically
 *     with no real timers. NB the simulated race is intra-process — it does
 *     NOT reproduce the real cross-process advisory-lock race (that still needs
 *     a Postgres integration test).
 */
export type { InstanceLockHandle };

export interface InstanceLock {
  /**
   * Attempt to acquire the lock. Returns a handle to the new holder, or `null`
   * when a live holder already owns it. The Postgres impl is *blocking* (it
   * waits up to ACQUIRE_WAIT_MS for an existing holder to age out) and always
   * returns a handle; the memory impl is *non-blocking* and returns `null`
   * immediately when a live holder exists, so contention is observable in one
   * process.
   */
  acquire(opts?: AcquireInstanceLockOpts): Promise<InstanceLockHandle | null>;
}

/**
 * Real, Postgres-backed lock. Delegates to the unchanged `acquireInstanceLock`.
 * Always resolves to a handle (never `null`) — it blocks until the advisory
 * lock is held, preserving today's boot semantics.
 */
export class PostgresInstanceLock implements InstanceLock {
  constructor(private readonly pool: pg.Pool) {}

  async acquire(opts: AcquireInstanceLockOpts = {}): Promise<InstanceLockHandle> {
    return acquireInstanceLock(this.pool, opts);
  }
}

const DEFAULT_LEASE_MS = 15_000;

interface MemoryHolder {
  instanceId: string;
  /** `clock.now()` of the most recent acquire / heartbeat. */
  lastHeartbeat: number;
}

export interface MemoryInstanceLockOptions {
  clock: Clock;
  /**
   * Lease length in ms. A holder is LIVE while
   * `clock.now() - lastHeartbeat <= leaseMs`, and STALE (reclaimable) once the
   * delta exceeds it. Defaults to 15_000 to mirror the Postgres LEASE_MS.
   */
  leaseMs?: number;
}

/**
 * Simulated single-process lock (decision 2b). Exactly one logical instance
 * may hold the lock; a competitor is denied (`null`) while the holder's lease
 * is fresh, and may reclaim once it ages out. `registerRun` / `activeRunsFor`
 * model the in-flight runs a holder owns so a stale holder's runs are reaped on
 * reclaim (mirrors the orphan reaper's role for the real lock).
 */
export class MemoryInstanceLock implements InstanceLock {
  private readonly clock: Clock;
  private readonly leaseMs: number;
  private holder: MemoryHolder | null = null;
  /** instanceId -> the run ids that instance owns. */
  private readonly runs = new Map<string, string[]>();

  constructor(opts: MemoryInstanceLockOptions) {
    this.clock = opts.clock;
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  }

  /** A holder is stale once its lease has elapsed (strictly past the horizon). */
  private isStale(holder: MemoryHolder): boolean {
    return this.clock.now() - holder.lastHeartbeat > this.leaseMs;
  }

  async acquire(): Promise<InstanceLockHandle | null> {
    // A live holder blocks acquisition.
    if (this.holder && !this.isStale(this.holder)) {
      return null;
    }
    // Reap a stale holder's bookkeeping before the new instance takes over —
    // the analogue of the real lock's orphan-run reaper.
    if (this.holder) {
      this.runs.delete(this.holder.instanceId);
    }
    const instanceId = `memory-${randomUUID().slice(0, 8)}`;
    const holder: MemoryHolder = { instanceId, lastHeartbeat: this.clock.now() };
    this.holder = holder;
    this.runs.set(instanceId, []);

    let released = false;
    // The base handle matches the real `InstanceLockHandle`; `heartbeat` is an
    // optional memory-only extension callers reach for via a widening cast (see
    // the lock tests). Attached after construction so the base object literal
    // stays exactly `InstanceLockHandle`.
    const handle: InstanceLockHandle & { heartbeat: () => void } = {
      instanceId,
      release: async () => {
        if (released) return;
        released = true;
        // Only drop the lock if THIS holder still owns it (a later holder may
        // have reclaimed it after this one aged out — releasing then would be
        // a stale no-op).
        if (this.holder === holder) {
          this.holder = null;
        }
        this.runs.delete(instanceId);
      },
      heartbeat: () => {
        // Refresh the lease — but only while this holder is still the owner.
        if (this.holder === holder && !released) {
          holder.lastHeartbeat = this.clock.now();
        }
      },
    };
    return handle;
  }

  /** Register an in-flight run owned by `instanceId`. */
  registerRun(instanceId: string, runId: string): void {
    const existing = this.runs.get(instanceId);
    if (existing) {
      existing.push(runId);
    } else {
      this.runs.set(instanceId, [runId]);
    }
  }

  /** The run ids currently owned by `instanceId` (empty once reaped/released). */
  activeRunsFor(instanceId: string): string[] {
    return [...(this.runs.get(instanceId) ?? [])];
  }
}
