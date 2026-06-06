import { nowUtcMs } from "./time.js";

/**
 * Phase D (zero-dep E2E) — the `Clock` seam.
 *
 * A one-method abstraction over "what time is it now (ms)?". Time-dependent
 * code that needs to be deterministically testable — currently the in-memory
 * instance lock's lease/heartbeat model (`src/singleton/lock.ts`) — reads
 * "now" from an injected `Clock` instead of calling `Date.now()` directly.
 *
 * The production default (`systemClock`) delegates to `nowUtcMs()` from
 * `./time.ts`, so the real lock keeps wall-clock semantics byte-for-byte.
 * Tests inject a controllable clock (the `TestClock` in `clock.test.ts`) so
 * lease expiry can be driven without real timers / sleeps.
 */
export interface Clock {
  /** Current time in milliseconds. */
  now(): number;
}

/**
 * Wall-clock default. Delegates to `nowUtcMs()` so the real instance lock
 * ages out on the same wall-clock horizon it always has.
 */
export const systemClock: Clock = {
  now(): number {
    return nowUtcMs();
  },
};
