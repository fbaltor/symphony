import { describe, expect, it } from "vitest";

import { MemoryInstanceLock } from "../../src/singleton/lock.js";
import type { InstanceLockHandle } from "../../src/singleton/instance-lock.js";
import type { Clock } from "../../src/lib/clock.js";
import { TestClock } from "./clock.test.js";

/**
 * Phase D — in-memory `InstanceLock` contract (behaviors 2 & 3).
 *
 * `MemoryInstanceLock` is the single-process, network-free analogue of the
 * Postgres advisory lock (`acquireInstanceLock`). It exists so lock
 * contention and lease expiry are testable deterministically — two logical
 * instances racing in one process, and a holder's lease aging out via an
 * INJECTED `Clock`, with NO real timers / sleeps.
 *
 * Lease/heartbeat model under test:
 *   - A holder acquires the lock at `clock.now()` and is considered LIVE
 *     while `clock.now() - heartbeatAt <= leaseMs`.
 *   - While a live holder exists, a competing acquire MUST fail (return a
 *     non-handle / null) — exactly one logical instance holds the lock.
 *   - When the clock advances past the lease, the holder is STALE; its
 *     bookkeeping (the "runs" it owned) is reaped, and a fresh acquire by a
 *     new instance succeeds and becomes the live holder.
 *
 * `release()` mirrors the real handle: releasing frees the lock immediately
 * (without waiting for lease expiry), and a second release is a safe no-op.
 */

const LEASE_MS = 15_000;

function makeLock(clock: Clock): MemoryInstanceLock {
  // Lease length mirrors the production LEASE_MS so the memory model and the
  // Postgres model age out on the same horizon.
  return new MemoryInstanceLock({ clock, leaseMs: LEASE_MS });
}

/** A handle is "granted" iff acquire returned a real InstanceLockHandle. */
function granted(h: InstanceLockHandle | null): h is InstanceLockHandle {
  return h !== null && typeof h === "object" && typeof h.instanceId === "string";
}

describe("MemoryInstanceLock — contention (behavior 2)", () => {
  it("grants the lock to exactly one of two contending instances", async () => {
    const clock = new TestClock(1_000);
    const lock = makeLock(clock);

    const first = await lock.acquire();
    const second = await lock.acquire(); // same instant — no time advance

    expect(granted(first)).toBe(true);
    // The loser does NOT acquire while the winner is live.
    expect(granted(second)).toBe(false);
  });

  it("the loser stays locked out for as long as the winner keeps the lease fresh", async () => {
    const clock = new TestClock(1_000);
    const lock = makeLock(clock);

    const winner = await lock.acquire();
    expect(granted(winner)).toBe(true);

    // Advance time but keep the winner alive via a heartbeat just under the
    // lease horizon — the loser must still be denied.
    clock.advance(LEASE_MS - 1);
    (winner as InstanceLockHandle & { heartbeat?: () => void }).heartbeat?.();

    const loser = await lock.acquire();
    expect(granted(loser)).toBe(false);
  });

  it("releasing the winner immediately frees the lock for a new instance (no lease wait)", async () => {
    const clock = new TestClock(1_000);
    const lock = makeLock(clock);

    const winner = await lock.acquire();
    expect(granted(winner)).toBe(true);

    await (winner as InstanceLockHandle).release();

    // No time advanced — the lock is free because release() dropped it,
    // not because the lease aged out.
    const next = await lock.acquire();
    expect(granted(next)).toBe(true);
    expect((next as InstanceLockHandle).instanceId).not.toBe(
      (winner as InstanceLockHandle).instanceId,
    );
  });

  it("second release() on the same handle is a safe no-op", async () => {
    const clock = new TestClock(1_000);
    const lock = makeLock(clock);

    const handle = await lock.acquire();
    expect(granted(handle)).toBe(true);

    await (handle as InstanceLockHandle).release();
    await expect((handle as InstanceLockHandle).release()).resolves.toBeUndefined();
  });

  it("assigns distinct instance ids to successive holders", async () => {
    const clock = new TestClock(1_000);
    const lock = makeLock(clock);

    const a = await lock.acquire();
    await (a as InstanceLockHandle).release();
    const b = await lock.acquire();

    expect((a as InstanceLockHandle).instanceId).not.toBe(
      (b as InstanceLockHandle).instanceId,
    );
  });
});

describe("MemoryInstanceLock — lease expiry & reaping (behavior 3)", () => {
  it("a new instance can acquire once the holder's lease expires", async () => {
    const clock = new TestClock(1_000);
    const lock = makeLock(clock);

    const dead = await lock.acquire();
    expect(granted(dead)).toBe(true);

    // Holder goes silent (no heartbeat). Advance just past the lease.
    clock.advance(LEASE_MS + 1);

    const reclaimer = await lock.acquire();
    expect(granted(reclaimer)).toBe(true);
    expect((reclaimer as InstanceLockHandle).instanceId).not.toBe(
      (dead as InstanceLockHandle).instanceId,
    );
  });

  it("does NOT reap a holder that is exactly at the lease boundary (not yet stale)", async () => {
    const clock = new TestClock(1_000);
    const lock = makeLock(clock);

    const holder = await lock.acquire();
    expect(granted(holder)).toBe(true);

    // Exactly at the lease horizon — still live, must not be reclaimable.
    clock.advance(LEASE_MS);
    const tooEarly = await lock.acquire();
    expect(granted(tooEarly)).toBe(false);
  });

  it("reaps the stale holder's owned runs when the lock is reclaimed", async () => {
    const clock = new TestClock(1_000);
    const lock = makeLock(clock);

    const dead = await lock.acquire();
    const deadId = (dead as InstanceLockHandle).instanceId;

    // The dead holder owns some in-flight runs (modelled in the registry).
    lock.registerRun(deadId, "run-1");
    lock.registerRun(deadId, "run-2");
    expect(lock.activeRunsFor(deadId)).toEqual(["run-1", "run-2"]);

    // Lease expires; a new instance reclaims and the dead holder's runs are
    // reaped as part of acquisition.
    clock.advance(LEASE_MS + 1);
    const reclaimer = await lock.acquire();
    expect(granted(reclaimer)).toBe(true);

    expect(lock.activeRunsFor(deadId)).toEqual([]);
    // The reclaimer starts with no inherited runs.
    expect(lock.activeRunsFor((reclaimer as InstanceLockHandle).instanceId)).toEqual([]);
  });

  it("a fresh heartbeat before the lease pushes the expiry horizon forward", async () => {
    const clock = new TestClock(1_000);
    const lock = makeLock(clock);

    const holder = await lock.acquire();
    expect(granted(holder)).toBe(true);

    // Heartbeat at +10s resets the lease; a competitor at +20s (only +10s
    // since the last heartbeat) must still be denied.
    clock.advance(10_000);
    (holder as InstanceLockHandle & { heartbeat?: () => void }).heartbeat?.();
    clock.advance(10_000);

    expect(granted(await lock.acquire())).toBe(false);

    // ...but once we cross the lease past the LAST heartbeat, reclaim works.
    clock.advance(LEASE_MS + 1);
    expect(granted(await lock.acquire())).toBe(true);
  });
});
