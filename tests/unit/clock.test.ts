import { describe, expect, it } from "vitest";

import { type Clock, systemClock } from "../../src/lib/clock.js";
import { nowUtcMs } from "../../src/lib/time.js";

/**
 * Phase D — `Clock` seam contract.
 *
 * `Clock` is a one-method seam (`now(): number`) that lets time-dependent
 * code (the in-memory instance lock's lease/heartbeat model) read "now"
 * from an injectable source instead of calling `Date.now()` directly.
 *
 * The production default (`systemClock`) MUST delegate to `nowUtcMs()` from
 * `src/lib/time.ts` so the real lock keeps wall-clock semantics. Tests pass
 * a controllable clock (see `TestClock` below) so lease expiry can be driven
 * deterministically — no real timers, no `sleep`.
 *
 * This file also pins the `TestClock` scaffolding used by the lock tests so
 * its behavior is itself covered (a buggy test clock would silently mask
 * lock bugs).
 */

/**
 * Controllable clock for deterministic time travel in tests. Starts at a
 * fixed epoch and only moves when the test tells it to. This is the seam
 * that replaces real `setTimeout`/`sleep` in the lock lease tests.
 */
class TestClock implements Clock {
  private current: number;
  constructor(startMs = 1_000_000) {
    this.current = startMs;
  }
  now(): number {
    return this.current;
  }
  /** Jump to an absolute time (ms). */
  set(ms: number): void {
    this.current = ms;
  }
  /** Advance by a relative delta (ms). */
  advance(deltaMs: number): void {
    this.current += deltaMs;
  }
}

describe("Clock seam", () => {
  it("systemClock.now() returns a number close to wall-clock UTC", () => {
    const before = nowUtcMs();
    const seen = systemClock.now();
    const after = nowUtcMs();
    // systemClock must read wall-clock time via nowUtcMs(); allow the tiny
    // window between the surrounding reads.
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(after);
  });

  it("systemClock implements the Clock interface (now returns a finite number)", () => {
    const clock: Clock = systemClock;
    const t = clock.now();
    expect(typeof t).toBe("number");
    expect(Number.isFinite(t)).toBe(true);
  });
});

describe("TestClock scaffolding", () => {
  it("does not advance on its own — now() is stable between reads", () => {
    const clock = new TestClock(5_000);
    expect(clock.now()).toBe(5_000);
    expect(clock.now()).toBe(5_000);
  });

  it("set() jumps to an absolute time", () => {
    const clock = new TestClock(0);
    clock.set(42_000);
    expect(clock.now()).toBe(42_000);
  });

  it("advance() moves time forward by a delta", () => {
    const clock = new TestClock(1_000);
    clock.advance(2_500);
    expect(clock.now()).toBe(3_500);
    clock.advance(500);
    expect(clock.now()).toBe(4_000);
  });
});

// Re-export so the lock test file can import the SAME controllable clock
// rather than re-declaring it (single source of truth for the scaffolding).
export { TestClock };
