import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/observability/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  withContext: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

describe("AsyncQueue — A-22 foundation", () => {
  it("delivers events pushed before iteration starts", async () => {
    const { AsyncQueue } = await import("../../src/agent/event-queue.js");
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();

    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  it("delivers events pushed after iteration starts", async () => {
    const { AsyncQueue } = await import("../../src/agent/event-queue.js");
    const q = new AsyncQueue<number>();

    const consumed: number[] = [];
    const consumer = (async () => {
      for await (const v of q) consumed.push(v);
    })();

    // Yield once so the consumer has a chance to start awaiting.
    await Promise.resolve();
    q.push(10);
    await Promise.resolve();
    q.push(20);
    q.close();
    await consumer;

    expect(consumed).toEqual([10, 20]);
  });

  it("close() is idempotent", async () => {
    const { AsyncQueue } = await import("../../src/agent/event-queue.js");
    const q = new AsyncQueue<number>();
    q.close();
    q.close();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([]);
    expect(q.isClosed).toBe(true);
  });

  it("push() after close() is a no-op (logged)", async () => {
    const { AsyncQueue } = await import("../../src/agent/event-queue.js");
    const q = new AsyncQueue<number>();
    q.close();
    q.push(99);
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([]);
  });

  it("drops the OLDEST event when buffer overflows (drop-oldest semantic)", async () => {
    const { AsyncQueue } = await import("../../src/agent/event-queue.js");
    const q = new AsyncQueue<number>({ maxBuffered: 3 });
    q.push(1);
    q.push(2);
    q.push(3);
    q.push(4); // overflow: drops 1
    q.push(5); // overflow: drops 2
    q.close();

    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([3, 4, 5]);
    expect(q.droppedCount).toBeGreaterThanOrEqual(2);
  });

  it("hands events directly to a waiting consumer (skips buffer)", async () => {
    const { AsyncQueue } = await import("../../src/agent/event-queue.js");
    const q = new AsyncQueue<number>({ maxBuffered: 1 });

    const iter = q[Symbol.asyncIterator]();
    const pendingNext = iter.next();
    // Buffer is empty; the consumer is awaiting. Push goes straight
    // to the waiter — buffer never gets used.
    q.push(42);
    const result = await pendingNext;
    expect(result).toEqual({ value: 42, done: false });
    expect(q.bufferLength).toBe(0);
    q.close();
  });

  it("drains buffered events before returning done after close()", async () => {
    const { AsyncQueue } = await import("../../src/agent/event-queue.js");
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();

    const iter = q[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ value: 1, done: false });
    expect(await iter.next()).toEqual({ value: 2, done: false });
    expect(await iter.next()).toEqual({ value: undefined, done: true });
  });

  it("consumer that breaks early doesn't kill the queue for others", async () => {
    const { AsyncQueue } = await import("../../src/agent/event-queue.js");
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);

    // First consumer takes one, then breaks.
    let firstSeen = 0;
    for await (const v of q) {
      firstSeen = v;
      break;
    }
    expect(firstSeen).toBe(1);

    // Queue should NOT be closed; second consumer drains the rest.
    expect(q.isClosed).toBe(false);
    q.close();
    const second: number[] = [];
    for await (const v of q) second.push(v);
    expect(second).toEqual([2, 3]);
  });
});
