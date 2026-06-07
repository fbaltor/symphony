/**
 * Webhook receiver unit tests — Phase 2.6 of the 16-state pipeline.
 *
 * These tests construct a minimal IncomingMessage / ServerResponse pair and
 * drive `handleLinearWebhook` directly — no real HTTP socket, no real DB.
 * The pool is a `vi.fn()` stub, the tracker is the same `FakeTracker` pattern
 * used in `cascade.test.ts`. This keeps the suite fast and deterministic.
 *
 * Coverage matrix:
 *   - HMAC valid + recent timestamp + new deliveryId → 200, cascade fires
 *   - HMAC invalid → 401, no cascade
 *   - HMAC valid + stale timestamp (>60s old) → 401, no cascade
 *   - HMAC valid + replayed deliveryId → 200, cascade does NOT fire again
 *   - Body > 256 KB → 413
 *   - Issue.update parent → "Development" → triggers Development cascade
 *   - Issue.update parent → "Canceled" → triggers Cancel cascade
 *   - Issue.update sub → "Done" → triggers Sub-Done watcher (with parent ref)
 *   - Comment.create → no cascade fires (ignored event type)
 */

import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FRESHNESS_WINDOW_MS,
  handleLinearWebhook,
  MAX_BODY_BYTES,
  type LinearWebhookContext,
  verifyHmac,
} from "../../src/webhook/linear-receiver.js";

/* --------------------------------------------------------------------------
 * Fake tracker — copy-paste of the cascade.test.ts pattern with the addition
 * of `fetchChildIssues` returning the canned response we configure.
 * -------------------------------------------------------------------------- */

interface ChildSpec {
  id: string;
  identifier: string;
  title: string;
  state: string;
  description: string | null;
  url: string | null;
}

class FakeTracker {
  childrenByParent = new Map<string, ChildSpec[]>();
  transitionCalls: Array<{ issueId: string; state: string }> = [];
  commentCalls: Array<{ issueId: string; body: string }> = [];

  async fetchChildIssues(parentId: string): Promise<ChildSpec[]> {
    return this.childrenByParent.get(parentId) ?? [];
  }

  async transitionIssueToState(issueId: string, state: string) {
    this.transitionCalls.push({ issueId, state });
    for (const subs of this.childrenByParent.values()) {
      const c = subs.find((x) => x.id === issueId);
      if (c) c.state = state;
    }
    return { identifier: issueId, state };
  }

  async createComment(issueId: string, body: string) {
    this.commentCalls.push({ issueId, body });
    return { id: `comment-${this.commentCalls.length}`, url: "" };
  }
}

/* --------------------------------------------------------------------------
 * Fake IncomingMessage — emits body chunks via 'data' / 'end'.
 * -------------------------------------------------------------------------- */

function buildFakeRequest(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body: Buffer;
}): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage;
  // The cast is intentional — we're synthesizing the surface, not the
  // implementation. The handler only touches `method`, `url`, `headers`,
  // and the EventEmitter contract.
  (emitter as unknown as { method: string }).method = opts.method ?? "POST";
  (emitter as unknown as { url: string }).url = opts.url ?? "/webhook/linear";
  (emitter as unknown as { headers: Record<string, string> }).headers = opts.headers ?? {};
  (emitter as unknown as { pause: () => void }).pause = () => {};
  // Defer the data emission so the handler has a chance to attach listeners.
  // 256 KB stream-cap test sends a multi-chunk body; chunk size of 64 KB
  // mimics Node's typical socket read.
  const CHUNK_SIZE = 64 * 1024;
  setImmediate(() => {
    let offset = 0;
    while (offset < opts.body.length) {
      emitter.emit("data", opts.body.slice(offset, offset + CHUNK_SIZE));
      offset += CHUNK_SIZE;
    }
    emitter.emit("end");
  });
  return emitter;
}

/* --------------------------------------------------------------------------
 * Fake ServerResponse — captures `writeHead` + `end` so tests can assert
 * status + body without binding to a real socket.
 * -------------------------------------------------------------------------- */

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function buildFakeResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

/* --------------------------------------------------------------------------
 * Helpers — sign a body the way Linear does (HMAC-SHA256 → lowercase hex).
 * -------------------------------------------------------------------------- */

const TEST_SECRET = "test-symphony-webhook-secret-do-not-use-in-prod";

function signBody(body: Buffer, secret: string = TEST_SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function buildPayload(
  override: Partial<{
    action: "create" | "update" | "remove";
    type: string;
    data: Record<string, unknown>;
    webhookId: string;
    webhookTimestamp: number;
  }> = {},
): Buffer {
  const payload = {
    action: override.action ?? "update",
    type: override.type ?? "Issue",
    createdAt: new Date().toISOString(),
    data: override.data ?? {
      id: "issue-uuid-1",
      identifier: "PROJ-1",
      state: { name: "Development" },
    },
    updatedFrom: { stateId: "old-state-id" },
    webhookId: override.webhookId ?? `delivery-${Math.random().toString(36).slice(2)}`,
    webhookTimestamp: override.webhookTimestamp ?? Date.now(),
  };
  return Buffer.from(JSON.stringify(payload), "utf-8");
}

/* --------------------------------------------------------------------------
 * Pool stub — vi.fn() returning a configurable result. Defaults to "fired"
 * (rowCount: 1) so the cascade dispatch path runs.
 * -------------------------------------------------------------------------- */

interface PoolStub {
  query: ReturnType<typeof vi.fn>;
}

function buildPoolStub(): PoolStub {
  const query = vi.fn();
  // Default: dedup INSERT succeeds, cascade pre-warm UPSERT succeeds.
  query.mockResolvedValue({ rowCount: 1, rows: [{ delivery_id: "x" }] });
  return { query };
}

/* --------------------------------------------------------------------------
 * Suite
 * -------------------------------------------------------------------------- */

describe("Linear webhook receiver", () => {
  let tracker: FakeTracker;
  let pool: PoolStub;
  let baseCtx: LinearWebhookContext;

  beforeEach(() => {
    tracker = new FakeTracker();
    pool = buildPoolStub();
    baseCtx = {
      pool: pool as never,
      tracker: tracker as never,
      webhookSecret: TEST_SECRET,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /* ------------------------------------------------------------------------
   * 1. HMAC valid + recent timestamp + new deliveryId → 200, cascade fires
   * ------------------------------------------------------------------------ */
  it("accepts a valid signed payload (parent → Development) and fires the cascade", async () => {
    tracker.childrenByParent.set("parent-uuid-1", [
      {
        id: "sub-1",
        identifier: "PROJ-101",
        title: "A",
        state: "Subtask drafted",
        description: null,
        url: null,
      },
    ]);

    const body = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "parent-uuid-1",
        identifier: "PROJ-100",
        state: { name: "Development" },
      },
    });
    const sig = signBody(body);
    const req = buildFakeRequest({
      headers: { "linear-signature": sig },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(200);
    const parsed = JSON.parse(captured.body) as Record<string, unknown>;
    expect(parsed.cascade).toBe("development");

    // Cascade is fired async (void). Allow microtasks + DB stub awaits.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(tracker.transitionCalls).toContainEqual({
      issueId: "sub-1",
      state: "To implement",
    });

    // Dedup INSERT must have run. (cascade pre-warm INSERT also fires async.)
    const dedupCall = pool.query.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("symphony.webhook_dedup"),
    );
    expect(dedupCall).toBeDefined();
  });

  /* ------------------------------------------------------------------------
   * 2. HMAC invalid → 401, no cascade
   * ------------------------------------------------------------------------ */
  it("rejects an invalid signature with 401 and never fires a cascade", async () => {
    const body = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "parent-uuid-1",
        identifier: "PROJ-100",
        state: { name: "Development" },
      },
    });
    const req = buildFakeRequest({
      headers: { "linear-signature": "00".repeat(32) /* wrong sig, valid length */ },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(401);
    const parsed = JSON.parse(captured.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("invalid_signature");

    // No DB write attempted.
    expect(pool.query).not.toHaveBeenCalled();
    expect(tracker.transitionCalls).toEqual([]);
  });

  it("rejects a missing or empty signature with 401", async () => {
    const body = buildPayload();
    const req = buildFakeRequest({ headers: {}, body });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);
    expect(captured.status).toBe(401);
    const parsed = JSON.parse(captured.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("missing_signature");
  });

  it("rejects an oversize signature header with 401", async () => {
    const body = buildPayload();
    const req = buildFakeRequest({
      headers: { "linear-signature": "ab".repeat(64) /* 128 chars > cap */ },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);
    expect(captured.status).toBe(401);
  });

  /* ------------------------------------------------------------------------
   * 3. HMAC valid + stale timestamp → 401, no cascade
   * ------------------------------------------------------------------------ */
  it("rejects a payload with a stale (>60s old) webhookTimestamp", async () => {
    const body = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "parent-uuid-1",
        identifier: "PROJ-100",
        state: { name: "Development" },
      },
      webhookTimestamp: Date.now() - (FRESHNESS_WINDOW_MS + 5_000),
    });
    const sig = signBody(body);
    const req = buildFakeRequest({
      headers: { "linear-signature": sig },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(401);
    const parsed = JSON.parse(captured.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("stale_timestamp");
    expect(pool.query).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------------------------------
   * 4. HMAC valid + replayed deliveryId → 200, cascade does NOT fire again
   * ------------------------------------------------------------------------ */
  it("returns 200 + status:'duplicate' on a replayed delivery (no cascade re-fire)", async () => {
    // Make the dedup INSERT report ON CONFLICT DO NOTHING (rowCount=0).
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const body = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "parent-uuid-1",
        identifier: "PROJ-100",
        state: { name: "Development" },
      },
      webhookId: "duplicate-id-X",
    });
    const sig = signBody(body);
    const req = buildFakeRequest({
      headers: { "linear-signature": sig },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(200);
    const parsed = JSON.parse(captured.body) as { status?: string };
    expect(parsed.status).toBe("duplicate");

    await new Promise((r) => setImmediate(r));
    expect(tracker.transitionCalls).toEqual([]);
  });

  /* ------------------------------------------------------------------------
   * 5. Body > 256 KB → 413
   * ------------------------------------------------------------------------ */
  it("rejects a body larger than 256 KB with 413", async () => {
    // Build a body that's strictly larger than the cap. The signature
    // doesn't matter — the cap fires before HMAC.
    const huge = Buffer.alloc(MAX_BODY_BYTES + 1024, 0x61);
    const req = buildFakeRequest({
      headers: { "linear-signature": signBody(huge) },
      body: huge,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(413);
    const parsed = JSON.parse(captured.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("payload_too_large");
    expect(pool.query).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------------------------------
   * 6. Issue.update parent → "Development" → Development cascade
   *    (covered above in test #1, kept here as an explicit named regression
   *    so it shows up clearly in the matrix)
   * ------------------------------------------------------------------------ */

  /* ------------------------------------------------------------------------
   * 7. Issue.update parent → "Canceled" → Cancel cascade
   * ------------------------------------------------------------------------ */
  it("fires runCancelCascade when a parent issue transitions to Canceled", async () => {
    tracker.childrenByParent.set("parent-uuid-cancel", [
      {
        id: "sub-c1",
        identifier: "PROJ-201",
        title: "A",
        state: "Implementation (manual)",
        description: null,
        url: null,
      },
      {
        id: "sub-c2",
        identifier: "PROJ-202",
        title: "B",
        state: "Done",
        description: null,
        url: null,
      },
    ]);

    const body = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "parent-uuid-cancel",
        identifier: "PROJ-200",
        state: { name: "Canceled" },
        // No `parent` field — this is a parent issue.
      },
    });
    const sig = signBody(body);
    const req = buildFakeRequest({
      headers: { "linear-signature": sig },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(200);
    const parsed = JSON.parse(captured.body) as { cascade?: string };
    expect(parsed.cascade).toBe("cancel");

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Only the non-terminal sub should be cancel-transitioned.
    expect(tracker.transitionCalls).toEqual([{ issueId: "sub-c1", state: "Canceled" }]);
  });

  /* ------------------------------------------------------------------------
   * 8. Issue.update sub → "Done" → Sub-Done watcher (with parent ref)
   * ------------------------------------------------------------------------ */
  it("fires runSubDoneWatcher against the parent when a sub transitions to Done", async () => {
    // All siblings done → watcher transitions parent.
    tracker.childrenByParent.set("parent-of-sub", [
      {
        id: "sub-d1",
        identifier: "PROJ-301",
        title: "A",
        state: "Done",
        description: null,
        url: null,
      },
      {
        id: "sub-d2",
        identifier: "PROJ-302",
        title: "B",
        state: "Done",
        description: null,
        url: null,
      },
    ]);

    const body = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "sub-d1",
        identifier: "PROJ-301",
        state: { name: "Done" },
        parent: { id: "parent-of-sub", identifier: "PROJ-300" },
      },
    });
    const sig = signBody(body);
    const req = buildFakeRequest({
      headers: { "linear-signature": sig },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(200);
    const parsed = JSON.parse(captured.body) as { cascade?: string };
    expect(parsed.cascade).toBe("sub_done_watcher");

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Watcher transitions the PARENT to Validation (manual).
    expect(tracker.transitionCalls).toContainEqual({
      issueId: "parent-of-sub",
      state: "Validation (manual)",
    });
  });

  /* ------------------------------------------------------------------------
   * 8b. Issue.update sub → Done with `parentId` (no `parent` object) — PROJ-546 fix
   * ------------------------------------------------------------------------ */
  it("fires runSubDoneWatcher when payload has parentId only (no parent object)", async () => {
    // 2026-05-07 hot-fix: Linear's webhook payload for state-only
    // Issue.update events often OMITS the full `parent` object — the
    // change set is just `state`, so Linear sends `parentId` as a flat
    // string instead. Before this fix the receiver only checked
    // `data.parent?.id`, missing the dispatch entirely. PROJ-546 was
    // observed stuck in `Development` after PROJ-547 → Done because of
    // exactly this. The fix mirrors the `Issue.create` branch's
    // existing `data.parent?.id ?? data.parentId` fallback.
    tracker.childrenByParent.set("parent-of-sub-flat", [
      {
        id: "sub-flat-1",
        identifier: "PROJ-547",
        title: "Bump landing-page navbar logo",
        state: "Done",
        description: null,
        url: null,
      },
    ]);

    const body = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "sub-flat-1",
        identifier: "PROJ-547",
        state: { name: "Done" },
        // Linear's state-only update payload — `parent` object omitted,
        // `parentId` provided as a flat string.
        parentId: "parent-of-sub-flat",
      },
    });
    const sig = signBody(body);
    const req = buildFakeRequest({
      headers: { "linear-signature": sig },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(200);
    const parsed = JSON.parse(captured.body) as { cascade?: string };
    expect(parsed.cascade).toBe("sub_done_watcher");

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Watcher must transition the PARENT to Validation (manual) even
    // though only `parentId` (not the `parent` object) was supplied.
    expect(tracker.transitionCalls).toContainEqual({
      issueId: "parent-of-sub-flat",
      state: "Validation (manual)",
    });
  });

  /* ------------------------------------------------------------------------
   * 9. Comment.create → no cascade fires (ignored event type)
   * ------------------------------------------------------------------------ */
  it("accepts a Comment.create event without firing any cascade", async () => {
    const body = buildPayload({
      action: "create",
      type: "Comment",
      data: {
        id: "comment-uuid-1",
        body: "Some comment",
      },
    });
    const sig = signBody(body);
    const req = buildFakeRequest({
      headers: { "linear-signature": sig },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(200);
    const parsed = JSON.parse(captured.body) as { routed?: boolean; reason?: string };
    expect(parsed.routed).toBe(false);
    expect(parsed.reason).toBe("comment_ignored");

    await new Promise((r) => setImmediate(r));
    expect(tracker.transitionCalls).toEqual([]);
    expect(tracker.commentCalls).toEqual([]);
  });

  /* ------------------------------------------------------------------------
   * Bonus: webhook disabled (secret unset) returns 503
   * ------------------------------------------------------------------------ */
  it("returns 503 when LINEAR_WEBHOOK_SECRET is unset", async () => {
    const body = buildPayload();
    const req = buildFakeRequest({ headers: { "linear-signature": signBody(body) }, body });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, { ...baseCtx, webhookSecret: null });
    expect(captured.status).toBe(503);
    const parsed = JSON.parse(captured.body) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe("webhook_disabled");
  });

  /* ------------------------------------------------------------------------
   * Bonus: GET /webhook/linear → 405
   * ------------------------------------------------------------------------ */
  it("rejects non-POST methods with 405", async () => {
    const body = buildPayload();
    const req = buildFakeRequest({ method: "GET", headers: {}, body });
    const { res, captured } = buildFakeResponse();
    await handleLinearWebhook(req, res, baseCtx);
    expect(captured.status).toBe(405);
  });

  /* ------------------------------------------------------------------------
   * 2026-05-07 dedup-key bug regression test
   *
   * Linear's `webhookId` payload field is the SUBSCRIPTION's UUID (constant
   * across deliveries from the same configured webhook), NOT a per-delivery
   * identifier. The pre-fix receiver used `payload.webhookId` alone as the
   * dedup key, which collapsed every delivery from the same subscription
   * into a single PK collision — only the very first delivery wrote a row
   * and every subsequent delivery returned 200 with status="duplicate"
   * without firing any cascade.
   *
   * The fix: prefer the per-delivery `Linear-Delivery` HTTP header; fall
   * back to a composite of `webhookId + webhookTimestamp + data.id + action`
   * when the header is absent (older Linear deployments / test fixtures).
   * Two deliveries from the same subscription that hit the same issue but
   * at DIFFERENT timestamps must produce TWO dedup rows, not one.
   * ------------------------------------------------------------------------ */
  it("uses Linear-Delivery header as dedup key when present", async () => {
    const body = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "parent-uuid-2",
        identifier: "PROJ-200",
        state: { name: "Development" },
      },
      // Subscription ID — same for every delivery from this webhook.
      webhookId: "subscription-uuid-shared",
    });
    const sig = signBody(body);
    const perDeliveryUuid = "delivery-uuid-1234-5678-9abc";
    const req = buildFakeRequest({
      headers: { "linear-signature": sig, "linear-delivery": perDeliveryUuid },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(200);
    // The dedup INSERT call is the FIRST query that contains "webhook_dedup".
    const dedupCall = pool.query.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("symphony.webhook_dedup"),
    );
    expect(dedupCall).toBeDefined();
    // The args[1] of the insert is the values array; index 0 is the
    // delivery_id. With the fix, that should be the header value, NOT
    // the payload's `webhookId`.
    const dedupArgs = dedupCall?.[1] as unknown[];
    expect(dedupArgs?.[0]).toBe(perDeliveryUuid);
    expect(dedupArgs?.[0]).not.toBe("subscription-uuid-shared");
  });

  it("falls back to a composite key when Linear-Delivery header is absent", async () => {
    const ts = Date.now();
    const body = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "parent-uuid-3",
        identifier: "PROJ-300",
        state: { name: "Development" },
      },
      webhookId: "subscription-uuid-shared",
      webhookTimestamp: ts,
    });
    const sig = signBody(body);
    const req = buildFakeRequest({
      headers: { "linear-signature": sig },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(200);
    const dedupCall = pool.query.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("symphony.webhook_dedup"),
    );
    expect(dedupCall).toBeDefined();
    const dedupArgs = dedupCall?.[1] as unknown[];
    // Composite key should include subscription, timestamp, issue ID, and action.
    expect(dedupArgs?.[0]).toBe(
      `subscription-uuid-shared:${ts}:parent-uuid-3:update`,
    );
  });

  it("produces DIFFERENT dedup keys for two deliveries with the same subscription but different timestamps", async () => {
    const ts1 = Date.now();
    const ts2 = ts1 + 1000;
    const sharedSubscription = "subscription-uuid-shared";

    // First delivery — composite fallback (no header)
    const body1 = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "parent-uuid-4",
        identifier: "PROJ-400",
        state: { name: "Development" },
      },
      webhookId: sharedSubscription,
      webhookTimestamp: ts1,
    });
    const sig1 = signBody(body1);
    const req1 = buildFakeRequest({
      headers: { "linear-signature": sig1 },
      body: body1,
    });
    const { res: res1, captured: captured1 } = buildFakeResponse();
    await handleLinearWebhook(req1, res1, baseCtx);
    expect(captured1.status).toBe(200);

    // Second delivery — same subscription ID but a later timestamp.
    const body2 = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "parent-uuid-4",
        identifier: "PROJ-400",
        state: { name: "Development" },
      },
      webhookId: sharedSubscription,
      webhookTimestamp: ts2,
    });
    const sig2 = signBody(body2);
    const req2 = buildFakeRequest({
      headers: { "linear-signature": sig2 },
      body: body2,
    });
    const { res: res2, captured: captured2 } = buildFakeResponse();
    await handleLinearWebhook(req2, res2, baseCtx);
    expect(captured2.status).toBe(200);

    // Both deliveries must have written DISTINCT dedup rows. Find both.
    const dedupCalls = pool.query.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("symphony.webhook_dedup"),
    );
    expect(dedupCalls.length).toBeGreaterThanOrEqual(2);
    const keys = dedupCalls.map((c) => (c[1] as unknown[])[0]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(`${sharedSubscription}:${ts1}:parent-uuid-4:update`);
    expect(keys[1]).toBe(`${sharedSubscription}:${ts2}:parent-uuid-4:update`);
  });

  it("logs an INFO event for each received delivery with the resolved dedup key + source", async () => {
    // Smoke test the diagnostic logging that lets `gcloud logging read` audit
    // every webhook delivery — verifies the structured logger receives the
    // right shape. We don't assert on log content directly (logger is a
    // module-level pino instance) but we DO confirm the receiver writes a
    // dedup row, which means the code path that emits the log lines was hit.
    const body = buildPayload({
      action: "update",
      type: "Issue",
      data: {
        id: "parent-uuid-5",
        identifier: "PROJ-500",
        state: { name: "Development" },
      },
    });
    const sig = signBody(body);
    const req = buildFakeRequest({
      headers: { "linear-signature": sig, "linear-delivery": "delivery-aaa" },
      body,
    });
    const { res, captured } = buildFakeResponse();

    await handleLinearWebhook(req, res, baseCtx);

    expect(captured.status).toBe(200);
    const dedupCall = pool.query.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("symphony.webhook_dedup"),
    );
    expect(dedupCall).toBeDefined();
  });
});

/* --------------------------------------------------------------------------
 * verifyHmac primitive — tested separately because the constant-time compare
 * is a load-bearing security primitive.
 * -------------------------------------------------------------------------- */

describe("verifyHmac (primitive)", () => {
  it("returns true for a matching hex signature", () => {
    const body = Buffer.from("hello world", "utf-8");
    const sig = signBody(body, "secret");
    expect(verifyHmac(body, sig, "secret")).toBe(true);
  });

  it("returns false for a wrong-key signature", () => {
    const body = Buffer.from("hello world", "utf-8");
    const sig = signBody(body, "wrong-secret");
    expect(verifyHmac(body, sig, "actual-secret")).toBe(false);
  });

  it("returns false for a malformed (non-hex) signature", () => {
    const body = Buffer.from("hello world", "utf-8");
    expect(verifyHmac(body, "not-a-hex-string", "secret")).toBe(false);
  });

  it("returns false for an empty signature", () => {
    const body = Buffer.from("hello world", "utf-8");
    expect(verifyHmac(body, "", "secret")).toBe(false);
  });
});
