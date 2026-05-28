/**
 * Linear webhook receiver — Phase 2.6 of the 16-state pipeline (E-17 / E-18 in
 * `independent/IMPROVEMENTS.md` §8).
 *
 * Routes Linear's `Issue.update` and `Issue.create` deliveries into the same
 * cascade primitives the 30s poll loop already uses. The poll loop stays
 * running as a safety net — webhooks are additive, not a replacement.
 *
 * Layered defenses (top-down, in order of evaluation):
 *
 *   1. Method gate — only POST is accepted.
 *   2. Signature header presence + length cap (≤64 hex chars).
 *   3. Body size cap (256 KB) — read with a hard byte counter, reject 413
 *      before parsing.
 *   4. HMAC-SHA256 verification against `LINEAR_WEBHOOK_SECRET` using
 *      `crypto.timingSafeEqual` (constant-time compare).
 *   5. Freshness window — `webhookTimestamp` from the body, rejected if
 *      drift > 60s in either direction.
 *   6. Dedup — INSERT into `symphony.webhook_dedup` keyed on `webhookId`.
 *      A PK collision means Linear is replaying; respond 200 (idempotent)
 *      WITHOUT re-firing the cascade.
 *   7. Routing — match the event type + state transition to a cascade.
 *
 * Reuses `cascade.ts` (`runDevelopmentCascade`, `runCancelCascade`,
 * `runSubDoneWatcher`) so behavior is identical to the poll-loop path.
 *
 * # Linear webhook payload shape (subset we consume)
 *
 * Linear delivers a JSON envelope like:
 *
 *   {
 *     "action": "update",                 // create | update | remove
 *     "type": "Issue",                    // Issue | Comment | ...
 *     "createdAt": "2026-05-06T12:34:56Z",
 *     "data": {
 *       "id": "<uuid>",
 *       "identifier": "STG-101",
 *       "state": { "name": "Development" },
 *       "parent": { "id": "<uuid>", "identifier": "STG-100" } | null,
 *       ...
 *     },
 *     "updatedFrom": {                    // present on update events; the
 *       "stateId": "<old-state-id>"       // PRE-change snapshot of fields
 *     },
 *     "webhookId": "<uuid-per-delivery>", // dedup key
 *     "webhookTimestamp": 1714997696000   // millis since epoch
 *   }
 *
 * `updatedFrom.stateId` only contains state IDs (not names), so to know if a
 * state actually changed we compare the new `data.state.name` against the
 * cascade's "did this transition into trigger state X" semantics. The cascade
 * functions are themselves idempotent (they query Linear's current truth
 * before firing), so over-firing here is at worst wasted work, never a
 * correctness bug.
 */

import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import { logger } from "../observability/logger.js";
import {
  type CascadeContext,
  runCancelCascade,
  runDevelopmentCascade,
  runSubDoneWatcher,
} from "../orchestrator/cascade.js";
import type { IssueTracker } from "../tracker/tracker.js";
import { ensureIssueMetadataRow } from "../audit/issue-metadata.js";

/**
 * Hard cap on the raw POST body. Linear's typical Issue.update payload is
 * a few KB; 256 KB is comfortably above the worst case (issue with hundreds
 * of comments inlined) while keeping memory + parse work bounded.
 */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * Allowed clock drift between Linear's `webhookTimestamp` and our `Date.now()`.
 * 60s is wide enough to absorb NTP skew + Linear-side queueing while narrow
 * enough that a captured-and-replayed signature can't trivially be re-used
 * minutes later (defense in depth — HMAC alone is enough to authenticate, but
 * dedup table cleanup runs at 24h TTL, so the freshness window prevents an
 * attacker from holding an old delivery and replaying it just outside the
 * dedup window).
 */
export const FRESHNESS_WINDOW_MS = 60 * 1000;

/**
 * Maximum length for the `Linear-Signature` header. Linear sends a
 * 64-char hex string (HMAC-SHA256). Capping defends against a malformed
 * client sending an arbitrarily-long header that we'd then constant-time
 * compare byte-by-byte.
 */
export const MAX_SIGNATURE_LENGTH = 64;

export interface LinearWebhookContext {
  /** Postgres pool — used for dedup INSERT + cascade `issue_metadata` UPSERTs. */
  pool: pg.Pool | null;
  /** Linear tracker — shared with poll loop. Null while bootstrap pending. */
  tracker: IssueTracker | null;
  /**
   * HMAC secret. Read from `LINEAR_WEBHOOK_SECRET` env in main.ts. Empty /
   * unset means the route returns 503 (`webhook_disabled`) — operator hasn't
   * pasted the secret yet.
   */
  webhookSecret: string | null;
  /**
   * Optional clock override for tests. When unset, uses `Date.now()`.
   */
  now?: () => number;
}

/* -------------------------------------------------------------------------- */
/*                              payload typings                                */
/* -------------------------------------------------------------------------- */

/**
 * Subset of Linear's webhook payload we actually use. We INTENTIONALLY do
 * NOT add Zod parsing here — webhooks must be cheap to validate (they're
 * a hot path Linear retries aggressively on 5xx) and the cascade functions
 * tolerate undefined fields gracefully (treat as "no transition matched").
 */
interface LinearWebhookPayload {
  action: "create" | "update" | "remove";
  type: string;
  createdAt?: string;
  data?: {
    id?: string;
    identifier?: string;
    state?: { name?: string | null } | null;
    parent?: { id?: string; identifier?: string } | null;
    parentId?: string | null;
  };
  updatedFrom?: {
    stateId?: string | null;
  };
  webhookId?: string;
  webhookTimestamp?: number;
  /**
   * A-16 / S-D13 (Task 2): the user/app that triggered this event.
   * Linear includes this on every webhook delivery; it's load-bearing
   * for the reconciler's revert-vs-allow decision (humans dragging
   * tickets must NOT be reverted; the agent's own moves are the bug
   * worth reverting).
   *
   * `id` is a Linear user UUID. `type` is one of:
   *   - `"user"` — a human, OR an API key (personal access token; Linear
   *     reports the API key's owning user as actor.id with type=user)
   *   - `"application"` — an OAuth-installed app
   *   - `"webhook"` — Linear-internal automation
   *   - missing — older webhooks or unusual events
   *
   * The reconciler checks `actor.id === LinearTrackerClient.getViewerId()`
   * to identify the bot's own moves, regardless of `actor.type` (which
   * is a heuristic that breaks under personal-API-key auth).
   */
  actor?: {
    id?: string;
    type?: string;
    name?: string;
  };
}

/* -------------------------------------------------------------------------- */
/*                           main HTTP handler                                 */
/* -------------------------------------------------------------------------- */

/**
 * Returns true if the URL path matches the webhook receiver. Use this from
 * `handleHttpRequest` to short-circuit before the regular route table.
 */
export function isWebhookPath(url: string): boolean {
  // Strip query string before comparison.
  const path = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
  return path === "/webhook/linear";
}

/**
 * Handle a `POST /webhook/linear` request. Reads + parses the body, runs
 * all the security gates, deduplicates, and dispatches to the right cascade.
 *
 * Always responds — never throws past this boundary. Errors during the
 * cascade itself are swallowed-and-logged because we've already returned
 * 200 to Linear (responding fast prevents Linear from retrying).
 */
export async function handleLinearWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: LinearWebhookContext,
): Promise<void> {
  // -- 1. method gate -----------------------------------------------------
  if (req.method !== "POST") {
    respondJson(res, 405, {
      error: { code: "method_not_allowed", message: "POST required" },
    });
    return;
  }

  // -- 2. webhook-disabled gate ------------------------------------------
  // Operator hasn't pasted the secret yet — return 503 so Linear's webhook
  // health page surfaces this clearly. (HTTP 200 with an error body would
  // be silently swallowed by Linear's UI.)
  if (!ctx.webhookSecret || ctx.webhookSecret.length === 0) {
    respondJson(res, 503, {
      error: {
        code: "webhook_disabled",
        message: "LINEAR_WEBHOOK_SECRET not configured; receiver disabled",
      },
    });
    return;
  }

  // Pool not bootstrapped yet — admin reload during bootstrap, or a
  // failed boot. Surface as 503 so Linear retries.
  if (!ctx.pool) {
    respondJson(res, 503, {
      error: { code: "pool_unavailable", message: "Postgres pool not bootstrapped" },
    });
    return;
  }

  // Tracker not bootstrapped — same logic. We could buffer the delivery
  // but that opens a leak vector; rely on Linear's retry instead.
  if (!ctx.tracker) {
    respondJson(res, 503, {
      error: { code: "tracker_unavailable", message: "Linear tracker not bootstrapped" },
    });
    return;
  }

  // -- 3. signature header presence + length cap -------------------------
  const signature = (req.headers["linear-signature"] ?? "") as string;
  if (signature.length === 0 || signature.length > MAX_SIGNATURE_LENGTH) {
    respondJson(res, 401, {
      error: { code: "missing_signature", message: "Linear-Signature header missing or oversize" },
    });
    return;
  }

  // -- 4. read body with hard byte cap -----------------------------------
  let rawBody: Buffer;
  try {
    rawBody = await readBodyWithCap(req, MAX_BODY_BYTES);
  } catch (err) {
    if ((err as { code?: string }).code === "PAYLOAD_TOO_LARGE") {
      respondJson(res, 413, {
        error: { code: "payload_too_large", message: `body exceeds ${MAX_BODY_BYTES} bytes` },
      });
      return;
    }
    logger.warn({ err: (err as Error).message }, "/webhook/linear body read failed");
    respondJson(res, 400, {
      error: { code: "body_read_failed", message: (err as Error).message },
    });
    return;
  }

  // -- 5. verify HMAC over the RAW body bytes ----------------------------
  // CRITICAL: HMAC must be computed over the bytes received (rawBody),
  // NOT over the parsed-then-restringified body — re-stringify changes
  // whitespace + key order and the signature won't match.
  if (!verifyHmac(rawBody, signature, ctx.webhookSecret)) {
    respondJson(res, 401, {
      error: { code: "invalid_signature", message: "HMAC verification failed" },
    });
    return;
  }

  // -- 6. parse body JSON ------------------------------------------------
  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf-8")) as LinearWebhookPayload;
  } catch (err) {
    respondJson(res, 400, {
      error: { code: "invalid_json", message: (err as Error).message },
    });
    return;
  }

  // -- 7. freshness window -----------------------------------------------
  const nowMs = (ctx.now ?? Date.now)();
  if (typeof payload.webhookTimestamp !== "number") {
    respondJson(res, 401, {
      error: { code: "missing_timestamp", message: "webhookTimestamp missing from payload" },
    });
    return;
  }
  const drift = Math.abs(nowMs - payload.webhookTimestamp);
  if (drift > FRESHNESS_WINDOW_MS) {
    respondJson(res, 401, {
      error: {
        code: "stale_timestamp",
        message: `drift ${drift}ms exceeds ${FRESHNESS_WINDOW_MS}ms`,
      },
    });
    return;
  }

  // -- 8. dedup-insert + dispatch (transactional) ------------------------
  // We insert the dedup row FIRST. If the row already exists, the cascade
  // already fired on a prior delivery — return 200 without re-firing.
  // The "what cascade does this map to" decision happens AFTER the dedup
  // insert succeeds, because we want the dedup to bind whether this
  // delivery was handleable at all.
  //
  // 2026-05-07 dedup-key bug fix: previously we used `payload.webhookId`
  // alone as the dedup key. Linear's `webhookId` field in the JSON body is
  // the WEBHOOK SUBSCRIPTION's UUID — the SAME value across every
  // delivery from a single configured webhook — NOT a per-delivery UUID.
  // The result was that the very first delivery succeeded and inserted
  // a row, then every subsequent delivery hit the ON CONFLICT branch and
  // returned 200 with status="duplicate" without firing any cascade.
  // Empirically: only 1 row in `symphony.webhook_dedup` despite dozens
  // of valid Linear deliveries (verified 2026-05-06).
  //
  // The correct per-delivery identifier comes from the `Linear-Delivery`
  // HTTP header (UUID v4 per delivery). We fall back to a composite of
  // `webhookId + webhookTimestamp + data.id + action` if the header is
  // missing — this is still per-delivery for the vast majority of events
  // because `webhookTimestamp` is the millis-of-delivery (different per
  // delivery) and `data.id + action` further disambiguate replays of the
  // same delivery.
  const headerDelivery = (req.headers["linear-delivery"] ?? "") as string;
  const fallbackKey = `${payload.webhookId ?? "no-sub"}:${payload.webhookTimestamp}:${payload.data?.id ?? "no-issue"}:${payload.action}`;
  const deliveryId =
    headerDelivery.length > 0 && headerDelivery.length <= 128 ? headerDelivery : fallbackKey;

  const eventType = `${payload.type}.${payload.action}`;
  // INFO-level log so the receiver's reachability is auditable via
  // `gcloud logging read 'resource.labels.service_name="symphony-orchestrator"
  // jsonPayload.msg="webhook: received"'`. Logs the delivery key + event
  // type + which key source we used so an operator can confirm the fix is
  // live (header vs. fallback) without reading the dist.
  logger.info(
    {
      delivery_id: deliveryId,
      delivery_key_source: headerDelivery.length > 0 ? "header" : "fallback",
      event_type: eventType,
      issue_identifier: payload.data?.identifier ?? null,
      state_name: payload.data?.state?.name ?? null,
    },
    "webhook: received",
  );
  const dedupOutcome = await tryRecordDelivery(ctx.pool, deliveryId, eventType);
  // Audit trail: log the dedup outcome alongside the delivery so an operator
  // can confirm INSERT actually happened (the original bug masked itself by
  // returning 200 without writing — symptom-vs-cause distinguishable from
  // logs alone).
  logger.info(
    {
      delivery_id: deliveryId,
      event_type: eventType,
      dedup_outcome: dedupOutcome,
    },
    "webhook: dedup recorded",
  );
  if (dedupOutcome === "duplicate") {
    // Replay — Linear retried a delivery we already handled. 200 is the
    // contract Linear expects to stop retrying.
    respondJson(res, 200, { status: "duplicate" });
    return;
  }
  if (dedupOutcome === "error") {
    // The dedup write itself failed (Postgres outage). Fail-safe: respond
    // 500 so Linear retries — better to re-deliver than to silently lose
    // the event. The poll loop is also a safety net.
    respondJson(res, 500, {
      error: { code: "dedup_write_failed", message: "could not record delivery" },
    });
    return;
  }

  // -- 9. ROUTE the event ------------------------------------------------
  // Respond 200 BEFORE awaiting the cascade. Linear's docs recommend
  // <500ms response time; cascades can take seconds (Linear API roundtrips
  // for fetchChildIssues + comment posts). Pattern matches the GitHub
  const action = payload.action;
  const linearType = payload.type;
  const data = payload.data ?? {};
  const issueId = data.id ?? "";
  const issueIdentifier = data.identifier ?? "";
  const stateName = data.state?.name ?? "";

  // Comment events are accepted but not routed (per requirements). The
  // dedup row is still written so a future routing rule for comments
  // can rely on the same idempotency guarantee without restructuring.
  if (linearType === "Comment") {
    respondJson(res, 200, { status: "accepted", routed: false, reason: "comment_ignored" });
    return;
  }

  // Only Issue events route into cascades.
  if (linearType !== "Issue") {
    respondJson(res, 200, {
      status: "accepted",
      routed: false,
      reason: `unhandled_type:${linearType}`,
    });
    return;
  }

  if (issueId.length === 0) {
    respondJson(res, 400, {
      error: { code: "missing_issue_id", message: "data.id missing for Issue event" },
    });
    return;
  }

  // ---- Issue.create with parent → ensure metadata row exists ----------
  // Mirrors the cascade pre-warm: when a sub-issue is filed by the
  // Technical plan agent, the cascade later moves it to
  // `To implement (manual)` and creates the metadata row. But if a sub
  // is created OUT-OF-BAND (manual sub-ticketing by a human, or via the
  // `/admin/...` path), this hook ensures `symphony.issue_metadata`
  // tracks it from creation.
  if (action === "create") {
    const parentId = data.parent?.id ?? data.parentId ?? null;
    if (parentId !== null && issueIdentifier.length > 0) {
      // Best-effort — failure here means cascade pre-warm runs later.
      void ensureIssueMetadataRow(ctx.pool, {
        issueId,
        issueIdentifier,
      }).catch((err) => {
        logger.warn(
          { err: (err as Error).message, issueId },
          "webhook: ensureIssueMetadataRow failed for created sub",
        );
      });
    }
    respondJson(res, 200, { status: "accepted", routed: false, reason: "issue_create_handled" });
    return;
  }

  // ---- Issue.update — examine state transition and route to cascade ---
  if (action !== "update") {
    respondJson(res, 200, {
      status: "accepted",
      routed: false,
      reason: `unhandled_action:${action}`,
    });
    return;
  }

  if (stateName.length === 0) {
    // Update event without a current-state name (e.g., an update that
    // touched a different field). Cascades only care about state, so
    // accept-and-skip.
    respondJson(res, 200, {
      status: "accepted",
      routed: false,
      reason: "no_state_in_payload",
    });
    return;
  }

  // A-16 / S-D13 (Task 2): persist the actor that drove this state
  // change so the reconciler can distinguish bot vs human moves.
  // Best-effort — runs in parallel with the cascade dispatch below.
  // We persist on EVERY Issue.update with a state, even ones that don't
  // route to a cascade — the reconciler is independent of cascades.
  if (payload.actor?.id) {
    void recordIssueStateActor(ctx.pool, {
      issueId,
      issueIdentifier,
      actorId: payload.actor.id,
      actorType: payload.actor.type ?? null,
      state: stateName,
    });
  }

  // Build a logger pre-bound with the issue identity.
  const cascadeLogger = logger.child({
    issue_id: issueId,
    issue_identifier: issueIdentifier,
    webhook_id: deliveryId,
  });
  const cascadeCtx: CascadeContext = {
    tracker: ctx.tracker,
    pool: ctx.pool,
    logger: cascadeLogger,
  };

  // ----- Sub → Done/Canceled/Duplicate fires the Sub-Done watcher -----
  // The watcher needs the SUB's PARENT to query siblings. Symphony only
  // has the data Linear sent; if neither `parent` nor `parentId` is
  // present the sub has no parent and no watcher should fire (orphan
  // sub — likely a top-level Linear issue that landed here by mistake).
  //
  // 2026-05-07 hot-fix (AGENT-546 forensic): Linear's webhook payload
  // for state-only Issue.update events often OMITS the full `parent`
  // object — the change set is just `state`, so Linear sends the bare
  // minimum and supplies `parentId` as a flat string instead. Before
  // this fix the Sub-Done watcher only checked `data.parent?.id`, so
  // when Liuri marked AGENT-547 as Done at 16:36:34Z, Symphony received
  // the webhook (delivery 59ebf002… recorded in symphony.webhook_dedup
  // at 16:36:35) but the watcher never fired and AGENT-546 stayed
  // stuck in `Development`. The `Issue.create` branch already had the
  // `data.parent?.id ?? data.parentId` fallback for the metadata-row
  // pre-warm; this commit mirrors it here.
  const parentRef = data.parent ?? null;
  const parentId = parentRef?.id ?? data.parentId ?? null;
  const parentIdentifier = parentRef?.identifier ?? "";
  const isSubTerminalState =
    stateName === "Done" || stateName === "Canceled" || stateName === "Duplicate";
  if (isSubTerminalState && parentId) {
    // The watcher requires the parent's CURRENT state to make its
    // idempotency decision. We don't have it in the payload; pass a
    // placeholder ("unknown") and let the watcher's GraphQL fetch
    // surface the truth — the watcher does NOT fast-path on "unknown",
    // it falls through to the children fetch.
    //
    // Note: we DO route both terminal-sub and parent-cancel transitions
    // through this branch when applicable; they don't conflict because
    // the Sub-Done watcher only cares when the issue is a sub.
    respondJson(res, 200, { status: "accepted", routed: true, cascade: "sub_done_watcher" });
    void runSubDoneWatcher(cascadeCtx, {
      id: parentId,
      // Identifier may be empty when Linear sent only `parentId` (state-
      // only payload). The watcher's GraphQL fetch resolves the identifier
      // from the children query; the empty fallback only impacts log
      // messages until the first child fetch completes.
      identifier: parentIdentifier,
      // Watcher fast-paths on Done / Canceled / Duplicate / Validation (manual).
      // We don't know the parent's state yet, so pass an empty state — the
      // watcher then proceeds to query children. If the parent is in fact
      // already in a terminal state, the watcher posts no comment because
      // the child fetch returns siblings whose count matches but the
      // parent transition itself fails-safe (idempotent).
      state: "",
    }).catch((err) => {
      cascadeLogger.error(
        { err: (err as Error).message },
        "runSubDoneWatcher threw (webhook path); cascade may have partially completed",
      );
    });
    return;
  }

  // ----- Parent → Development fires the Development cascade -----------
  if (stateName.toLowerCase() === "development") {
    respondJson(res, 200, { status: "accepted", routed: true, cascade: "development" });
    void runDevelopmentCascade(cascadeCtx, {
      id: issueId,
      identifier: issueIdentifier,
    }).catch((err) => {
      cascadeLogger.error(
        { err: (err as Error).message },
        "runDevelopmentCascade threw (webhook path); cascade may have partially completed",
      );
    });
    return;
  }

  // ----- Parent → Canceled fires the Cancel cascade -------------------
  // We can't distinguish "parent" from "sub" purely from the payload
  // (Linear doesn't tag issues). Heuristic: if the issue has a parent
  // reference (object OR flat parentId), it's a sub; otherwise it's a
  // parent. Subs hitting Canceled already routed above into the
  // Sub-Done watcher; this branch is the parent path.
  if (stateName === "Canceled" && !parentId) {
    respondJson(res, 200, { status: "accepted", routed: true, cascade: "cancel" });
    void runCancelCascade(cascadeCtx, {
      id: issueId,
      identifier: issueIdentifier,
    }).catch((err) => {
      cascadeLogger.error(
        { err: (err as Error).message },
        "runCancelCascade threw (webhook path); cascade may have partially completed",
      );
    });
    return;
  }

  // No matching cascade — accepted but not routed. The poll loop will
  // pick up any state transitions we don't handle here.
  respondJson(res, 200, {
    status: "accepted",
    routed: false,
    reason: `no_cascade_for_state:${stateName}`,
  });
}

/* -------------------------------------------------------------------------- */
/*                              helpers                                        */
/* -------------------------------------------------------------------------- */

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  // Linear cares about quick responses; don't add headers it doesn't need.
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Stream the request body into a Buffer with a hard byte cap. Throws an
 * error with `code: "PAYLOAD_TOO_LARGE"` if the cap is exceeded.
 *
 * Why a hard cap matters: a single attacker-controlled POST that streams
 * gigabytes of payload would otherwise blow up our memory before we get
 * to the body-parse step. The cap is enforced BEFORE HMAC verification
 * because we read bytes regardless of whether we'll authenticate them.
 */
async function readBodyWithCap(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      total += buf.length;
      if (total > maxBytes) {
        const err: Error & { code?: string } = new Error(
          `body size ${total} exceeds cap ${maxBytes}`,
        );
        err.code = "PAYLOAD_TOO_LARGE";
        // Pause the stream — don't keep reading bytes we'll discard.
        req.pause();
        reject(err);
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Constant-time HMAC-SHA256 verification.
 *
 * Linear sends the signature as the lowercase hex digest of HMAC-SHA256
 * over the RAW body bytes, keyed on the configured secret. We compute the
 * same digest, then `crypto.timingSafeEqual` against the provided header.
 *
 * Length mismatch fails BEFORE the timingSafeEqual call (timingSafeEqual
 * throws on length mismatch). Returning false instead of throwing keeps
 * the error path uniform — no try/catch in the caller.
 */
export function verifyHmac(rawBody: Buffer, signatureHex: string, secret: string): boolean {
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(signatureHex, "hex");
  } catch {
    return false;
  }
  // hex parse silently produces an empty buffer for non-hex input;
  // catch that explicitly so an attacker-controlled non-hex header
  // doesn't pass length-equality with an empty expected buf.
  if (providedBuf.length === 0) return false;

  const expectedBuf = crypto.createHmac("sha256", secret).update(rawBody).digest();
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

type DedupOutcome = "fired" | "duplicate" | "error";

/**
 * Insert a dedup row. Returns:
 *   - "duplicate" if the row already exists (PK collision) — caller should
 *     respond 200 without firing the cascade.
 *   - "fired" if the row was inserted — caller should proceed to dispatch.
 *   - "error" on any other DB failure — caller should respond 500.
 *
 * The `outcome` column on the row is set to "fired" on insert; if the
 * subsequent cascade detects mid-flight that nothing was actually done
 * (e.g., parent has zero children), the row stays as "fired" — the column
 * tracks "was a cascade attempted?" not "did the cascade do anything?".
 * That's fine for dedup purposes; the audit trail for cascade outcomes
 * lives in the Linear comments the cascades themselves post.
 */
async function tryRecordDelivery(
  pool: pg.Pool,
  deliveryId: string,
  eventType: string,
): Promise<DedupOutcome> {
  try {
    const res = await pool.query(
      `INSERT INTO symphony.webhook_dedup (delivery_id, event_type, outcome)
         VALUES ($1, $2, 'fired')
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING delivery_id`,
      [deliveryId, eventType],
    );
    if (res.rowCount === 0) {
      // Row already existed — Linear is replaying.
      return "duplicate";
    }
    return "fired";
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, deliveryId },
      "tryRecordDelivery: dedup INSERT failed",
    );
    return "error";
  }
}

/**
 * A-16 / S-D13 (Task 2): persist the actor that drove this Issue.update
 * event into `symphony.issue_state_actor`. The reconciler reads this row
 * before reverting an unauthorized state move; if `last_actor_id` is
 * NOT the bot's viewer id, the move was human-driven and the revert
 * is skipped.
 *
 * Best-effort: a Postgres failure logs a warn and lets the webhook
 * continue. The reconciler's null-fallback path treats "no row" as
 * "unknown actor → use legacy revert behavior" — same as before
 * Task 2 landed, so failures here degrade gracefully.
 */
async function recordIssueStateActor(
  pool: pg.Pool,
  args: {
    issueId: string;
    issueIdentifier: string;
    actorId: string;
    actorType: string | null;
    state: string;
  },
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO symphony.issue_state_actor
         (issue_id, issue_identifier, last_actor_id, last_actor_type,
          last_state, last_changed_at)
         VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (issue_id) DO UPDATE
         SET issue_identifier = EXCLUDED.issue_identifier,
             last_actor_id    = EXCLUDED.last_actor_id,
             last_actor_type  = EXCLUDED.last_actor_type,
             last_state       = EXCLUDED.last_state,
             last_changed_at  = EXCLUDED.last_changed_at`,
      [
        args.issueId,
        args.issueIdentifier,
        args.actorId,
        args.actorType,
        args.state,
      ],
    );
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        issueId: args.issueId,
        identifier: args.issueIdentifier,
      },
      "recordIssueStateActor: upsert failed (reconciler will fall back to legacy revert behavior)",
    );
  }
}

/**
 * Webhook dedup retention. Linear retries failed deliveries for up to 24h on
 * 5xx, so 24h is the minimum safe retention window. We delete anything older
 * to keep the table from growing unbounded — at current volume the table
 * stays under ~1 MB but a long-running deployment without rotation would
 * eventually accumulate millions of rows. Surfaced 2026-05-07 by Copilot
 * review on PR #684 (the original schema TODO punted this to operator-managed
 * pg_cron, but in-process is simpler and survives a Postgres host swap).
 */
const WEBHOOK_DEDUP_RETENTION_HOURS = 24;
/** Default cleanup cadence — re-run once per hour. */
export const WEBHOOK_DEDUP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delete `symphony.webhook_dedup` rows older than the retention window.
 * Returns the number of rows pruned (best-effort — a Postgres failure logs
 * a warn and returns 0; the next tick will retry).
 *
 * Exported so callers (main.ts via setInterval) can trigger periodic
 * cleanup, and tests can call it deterministically.
 */
export async function pruneWebhookDedup(pool: pg.Pool): Promise<number> {
  try {
    const res = await pool.query(
      `DELETE FROM symphony.webhook_dedup
        WHERE received_at < now() - interval '${WEBHOOK_DEDUP_RETENTION_HOURS} hours'`,
    );
    const pruned = res.rowCount ?? 0;
    if (pruned > 0) {
      logger.info(
        { pruned, retentionHours: WEBHOOK_DEDUP_RETENTION_HOURS },
        "webhook_dedup cleanup: pruned old delivery rows",
      );
    }
    return pruned;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "pruneWebhookDedup: DELETE failed (next tick will retry)",
    );
    return 0;
  }
}
