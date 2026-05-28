/**
 * Time helpers.
 *
 * Symphony distinguishes:
 *  - Wall-clock UTC for log timestamps and tracker payloads.
 *  - Monotonic ms for retry due times and stall detection (spec §8.4 / §8.5).
 */

export function nowUtcMs(): number {
  return Date.now();
}

/** Returns a monotonic time in milliseconds. Backed by `process.hrtime.bigint`. */
export function nowMonotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Returns a Promise that resolves after `ms` wall-clock milliseconds, providing a Promise-based
 * pause for async flows. Use this to introduce deliberate delays — exponential backoff between
 * retries, polling intervals, throttling between API calls, or timing-sensitive tests. Backed by
 * `setTimeout`, so it inherits Node's wall-clock semantics: it is not monotonic and may drift
 * under system clock changes or event-loop pressure. If you need a stable elapsed-time
 * measurement (e.g. for stall detection or due-time arithmetic), pair this with
 * {@link nowMonotonicMs} rather than relying on the resolved time.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Schedule a one-shot timer. Returns the underlying `NodeJS.Timeout` so callers
 * can cancel it via `clearTimeout`.
 */
export function scheduleTimer(delayMs: number, fn: () => void): NodeJS.Timeout {
  return setTimeout(fn, Math.max(0, delayMs));
}

export function cancelTimer(handle: NodeJS.Timeout | null | undefined): void {
  if (handle) clearTimeout(handle);
}
