/**
 * bounded async queue for the AgentEvent stream.
 *
 * Producer (claude-adapter `runTurn`) calls `push(event)` synchronously
 * for every SDK message that maps to one of our spec-defined event
 * kinds (see `events.ts`). Consumers (`SlackObserver`, `/status` HTTP
 * route, audit recorder) iterate via `for await (const e of queue)` —
 * they get events as soon as they're pushed.
 *
 * Bounded so a runaway producer (a Claude turn streaming 50K tokens of
 * tool output) can't OOM the orchestrator. When the buffer hits
 * `maxBuffered`, the OLDEST event is dropped and a single `dropped` log
 * line surfaces — the orchestrator still gets the LATEST progress
 * signals (which are usually what an operator cares about).
 *
 * Why drop-oldest instead of drop-newest:
 *   - The latest event is most useful for "is this turn alive?" — the
 *     operator is staring at the Slack thread waiting for the NEXT
 *     event, not re-reading event #1.
 *   - The audit row records the FINAL outcome via `runTurn`'s return
 *     value, not via the queue. Mid-stream events are observability
 *     only; losing the oldest few in a flood is acceptable.
 *
 * `close()` signals end-of-stream — `for await` receives `done: true`
 * after all buffered events are drained. Idempotent: calling close()
 * twice is a no-op. Calling push() after close() is a no-op (logged as
 * a warn so a buggy producer is visible).
 */

import { logger } from "../observability/logger.js";

/** Resolver pair for a single async waiter. */
interface PendingResolver<T> {
  resolve: (result: IteratorResult<T>) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: PendingResolver<T>[] = [];
  private readonly maxBuffered: number;
  private closed = false;
  private droppedSinceLastLog = 0;
  private readonly name: string;

  constructor(opts: { maxBuffered?: number; name?: string } = {}) {
    this.maxBuffered = opts.maxBuffered ?? 256;
    this.name = opts.name ?? "anonymous";
  }

  /** Producer: push one event. Drops the oldest buffered event if the
   *  buffer is full, logging once per overflow window so the spam
   *  doesn't itself become a problem. No-op when the queue is closed. */
  push(event: T): void {
    if (this.closed) {
      logger.warn(
        { queue: this.name },
        "AsyncQueue.push after close — event dropped (producer bug)",
      );
      return;
    }
    // If a consumer is already awaiting next(), hand the event off
    // directly. Skips the buffer entirely in the common case.
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    if (this.buffer.length >= this.maxBuffered) {
      this.buffer.shift();
      this.droppedSinceLastLog += 1;
      // Log once per ~32 drops to keep the log stream readable on a
      // truly out-of-control producer. The first drop fires immediately
      // so the operator sees something is wrong without waiting.
      if (this.droppedSinceLastLog === 1 || this.droppedSinceLastLog % 32 === 0) {
        logger.warn(
          {
            queue: this.name,
            droppedSinceLastLog: this.droppedSinceLastLog,
            maxBuffered: this.maxBuffered,
          },
          "AsyncQueue overflow; dropping oldest event",
        );
      }
    }
    this.buffer.push(event);
  }

  /** Producer: signal end-of-stream. Idempotent. After close, any
   *  buffered events still drain to consumers; subsequent next() calls
   *  return `done: true`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Resolve all pending waiters with done: true if there's nothing
    // left in the buffer. (Buffered events are still drained before
    // done fires — see next().)
    if (this.buffer.length === 0) {
      for (const w of this.waiters) {
        w.resolve({ value: undefined as never, done: true });
      }
      this.waiters.length = 0;
    }
  }

  /** Consumer: standard async iterator. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) {
          // After draining the last buffered event on a closed queue,
          // resolve any pending waiters with done.
          if (this.closed && this.buffer.length === 0) {
            for (const w of this.waiters) {
              w.resolve({ value: undefined as never, done: true });
            }
            this.waiters.length = 0;
          }
          return Promise.resolve({ value: buffered, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push({ resolve });
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        // Consumer broke out of the for-await loop. Don't close the
        // queue — the producer might still be running and other consumers
        // (in a fan-out scenario) might still be listening. Just resolve
        // this iterator's promise as done.
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }

  /** Test introspection. Production code should not need these. */
  get bufferLength(): number {
    return this.buffer.length;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  get droppedCount(): number {
    return this.droppedSinceLastLog;
  }
}
