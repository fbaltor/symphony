import { WebClient } from "@slack/web-api";
import type pg from "pg";
import { buildIdentifier } from "../lib/build-info.js";
import type { Issue } from "../types.js";
import { logger } from "./logger.js";

/**
 * Spec extension — threaded ticket cards.
 *
 * For each issue Symphony works, we post a "root" message to a configured
 * Slack channel and reply in-thread with major lifecycle events:
 *
 *   - dispatch (turn 1 starting)
 *   - turn_completed
 *   - turn_failed / stalled / timeout
 *   - reconciled (terminal)
 *
 * If `SLACK_BOT_TOKEN` or `slack.channel_id` is missing, the observer
 * silently no-ops.
 *
 * Auth failure handling
 * ---------------------
 * Slack errors like `invalid_auth`, `not_authed`, `token_revoked`,
 * `account_inactive` are not transient — they will fail every call until the
 * token is rotated. Logging once per dispatch flooded the daemon's log
 * channel (5–10 lines/day per failed token). Instead, the first auth-fatal
 * error flips `slackHealthy = false`, logs a single actionable line pointing
 * at the runbook, and all subsequent calls early-return. State is in-memory
 * only — restarting the process re-tries Slack (which is what you want after
 * a token rotation deploy).
 */

/** Slack error codes that indicate the bot token is permanently broken until
 *  rotated. Other errors (rate limits, channel_not_found, network) are still
 *  logged per-call. */
const FATAL_AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope", // bot installed but lacks chat:write — same fix path
]);

export interface SlackObserverOptions {
  token: string | undefined;
  channelId: string | undefined;
  /**
   * optional Postgres pool for persisting the per-(issue,
   * channel) thread root timestamp. When provided, the SlackObserver
   * survives restarts — subsequent posts on the same Linear issue still
   * land in the same Slack thread instead of opening a new root.
   * Omit to keep the legacy in-memory-only behavior.
   */
  pool?: pg.Pool;
  /**
   * Test-only injection point. When provided, the observer uses this
   * function to construct its WebClient instead of `new WebClient(token)`.
   * Production callers omit this; tests pass a stub that captures the
   * postMessage args (used by the cache-hit-rate observability tests).
   */
  clientFactory?: (token: string) => WebClient;
}

// Rate-limit Slack posts so a flapping issue or a
// webhook storm can't blow past Slack's own rate ceiling AND fan-out their
// own per-second post wall.
const PER_ISSUE_MIN_GAP_MS = 5_000;
const GLOBAL_TOKEN_BUCKET_CAPACITY = 20;
const GLOBAL_TOKEN_BUCKET_WINDOW_MS = 60_000;

// Rate-limit rejection alerts per (kind, reason)
// pair across a 5-minute window. The same cause hammering 50 issues in one
// tick should announce ONCE in Slack, not 50 times — operator visibility is
// "something is broken, here's why" not "a list of every affected issue."
// 5 min is the dampening window we landed on.
const REJECTION_DAMPENING_WINDOW_MS = 5 * 60_000;

export class SlackObserver {
  private readonly client: WebClient | null;
  private readonly channelId: string | undefined;
  private readonly pool: pg.Pool | null;
  private readonly threadTs = new Map<string, string>();
  /** False after the first fatal auth error. All later calls early-return. */
  private slackHealthy = true;
  /**
   * per-issue last-post-time cache for the 5s min-gap rate limit. A
   * flapping ticket (rapid state oscillations or webhook storm) can't blow
   * past one post per 5s on its own thread.
   */
  private lastPostPerIssueMs: Map<string, number> = new Map();
  /**
   * global token bucket. 20 tokens refilled to capacity every 60s.
   * `lastRefillMs` tracks when the bucket was last fully replenished.
   * Sized to be comfortably under Slack's published per-channel rate
   * ceiling while leaving room for higher-priority posts.
   */
  private globalTokens: number = GLOBAL_TOKEN_BUCKET_CAPACITY;
  private globalLastRefillMs: number = Date.now();
  /**
   * per-`(kind, reason)` last-alert-time cache for the rejection
   * dampening window. Map key is `${kind}::${reason-or-empty}`. A burst of
   * identical rejections (e.g. 30 issues all hit the same daily-cap with
   * the same reason within one tick) collapses to a single Slack alert per
   * 5-minute window.
   */
  private lastRejectionAlertMs: Map<string, number> = new Map();

  constructor(opts: SlackObserverOptions) {
    if (opts.token && opts.channelId) {
      this.client = opts.clientFactory ? opts.clientFactory(opts.token) : new WebClient(opts.token);
      this.channelId = opts.channelId;
    } else {
      this.client = null;
      this.channelId = undefined;
    }
    this.pool = opts.pool ?? null;
  }

  /**
   * refill the global token bucket if at least one window has
   * elapsed since the last refill. Refills to capacity (not incremental
   * per-second) since the bucket is small and the window is short.
   */
  private refillGlobalBucket(): void {
    const now = Date.now();
    if (now - this.globalLastRefillMs >= GLOBAL_TOKEN_BUCKET_WINDOW_MS) {
      this.globalTokens = GLOBAL_TOKEN_BUCKET_CAPACITY;
      this.globalLastRefillMs = now;
    }
  }

  /**
   * try to consume one Slack-post token + check per-issue gap.
   * Returns `true` when the post should proceed, `false` when it should
   * be dropped (callers log `slack.rate_limited` and return early).
   */
  private acquirePostToken(issueId: string): boolean {
    this.refillGlobalBucket();
    if (this.globalTokens <= 0) {
      logger.warn(
        {
          issueId,
          capacity: GLOBAL_TOKEN_BUCKET_CAPACITY,
          windowMs: GLOBAL_TOKEN_BUCKET_WINDOW_MS,
        },
        "slack.rate_limited (global bucket empty)",
      );
      return false;
    }
    const lastPost = this.lastPostPerIssueMs.get(issueId);
    const now = Date.now();
    if (lastPost !== undefined && now - lastPost < PER_ISSUE_MIN_GAP_MS) {
      logger.warn(
        { issueId, sinceLastMs: now - lastPost, minGapMs: PER_ISSUE_MIN_GAP_MS },
        "slack.rate_limited (per-issue 5s min gap)",
      );
      return false;
    }
    this.globalTokens -= 1;
    this.lastPostPerIssueMs.set(issueId, now);
    return true;
  }

  /**
   * Resolve the thread-root timestamp for `issueId`. Checks the in-memory
   * cache first, then falls back to `symphony.slack_thread` (when a pool
   * is configured). Best-effort: a Postgres failure logs a warn and falls
   * through to the in-memory miss path (the announce caller will create
   * a fresh root and the next post persists it).
   */
  private async resolveThreadTs(issueId: string): Promise<string | undefined> {
    const cached = this.threadTs.get(issueId);
    if (cached) return cached;
    if (!this.pool || !this.channelId) return undefined;
    try {
      const res = await this.pool.query<{ thread_ts: string }>(
        `SELECT thread_ts FROM slack_thread WHERE issue_id = $1 AND channel_id = $2`,
        [issueId, this.channelId],
      );
      const ts = res.rows[0]?.thread_ts;
      if (ts) {
        this.threadTs.set(issueId, ts);
        return ts;
      }
      return undefined;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, issueId },
        "slack thread_ts read from DB failed; treating as miss",
      );
      return undefined;
    }
  }

  /**
   * Persist a freshly-minted thread root. Best-effort — a Postgres failure
   * leaves the in-memory cache populated so the rest of this process boot
   * still threads correctly.
   */
  private async persistThreadTs(issueId: string, ts: string): Promise<void> {
    this.threadTs.set(issueId, ts);
    if (!this.pool || !this.channelId) return;
    try {
      await this.pool.query(
        `INSERT INTO slack_thread (issue_id, channel_id, thread_ts)
           VALUES ($1, $2, $3)
         ON CONFLICT (issue_id, channel_id) DO NOTHING`,
        [issueId, this.channelId, ts],
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, issueId },
        "slack thread_ts persist failed; in-memory only for this run",
      );
    }
  }

  enabled(): boolean {
    return this.client !== null && this.channelId !== undefined && this.slackHealthy;
  }

  async announceDispatch(issue: Issue, attempt: number | null): Promise<void> {
    if (!this.client || !this.channelId || !this.slackHealthy) return;
    // rate limit before constructing payload. Drop the post if either
    // the per-issue gap or global bucket says no.
    if (!this.acquirePostToken(issue.id)) return;
    const text =
      attempt && attempt > 0
        ? `:repeat: Re-dispatching *${issue.identifier}* — ${escape(issue.title)} (attempt ${attempt})`
        : `:rocket: Dispatching *${issue.identifier}* — ${escape(issue.title)}`;
    try {
      let ts = await this.resolveThreadTs(issue.id);
      if (!ts) {
        // Include the running build identifier in the
        // root post so an operator can read it back to know which revision
        // was serving when the thread was opened. Format mirrors GitHub
        // App User-Agent (`symphony/<version>+<gitSha>`).
        const root = `*${issue.identifier}* — ${escape(issue.title)}\n_${buildIdentifier()}_`;
        const res = await this.client.chat.postMessage({
          channel: this.channelId,
          text: root,
        });
        if (res.ts) {
          await this.persistThreadTs(issue.id, res.ts);
          ts = res.ts;
        }
      }
      // If we still don't have a thread root (root post failed without throwing),
      // fall back to an un-threaded post rather than silently sending a
      // misleading thread_ts=undefined.
      await this.client.chat.postMessage({
        channel: this.channelId,
        text,
        ...(ts ? { thread_ts: ts } : {}),
      });
    } catch (err) {
      this.handleError(err, "slack announceDispatch failed");
    }
  }

  async announceOutcome(
    issue: Issue,
    outcome: string,
    detail: {
      tokens?: number;
      costUsd?: number;
      error?: string;
      /**
       * prompt-cache observability. To emit the
       * `cache_hit=NN.N%` segment ALL three of these conditions must hold:
       *   1. `cacheReadInputTokens` is defined and > 0 (a cache READ
       *      actually happened — first-dispatch cache writes don't count
       *      as a hit and would print a misleading `cache_hit=0.0%`).
       *   2. `inputTokens` and `cacheCreationInputTokens` are both
       *      defined (so the denominator covers the full input-side
       *      token universe; a partially-supplied call produces
       *      garbage percentages and is suppressed instead).
       * If any of those conditions fails the segment is omitted and the
       * card falls back to the pre-cache format (just `tokens` + `cost`).
       * Surfaced by Copilot review (2026-05-07).
       */
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      inputTokens?: number;
    } = {},
  ): Promise<void> {
    if (!this.client || !this.channelId || !this.slackHealthy) return;
    // rate-limited posts are dropped (logged but not queued). The
    // outcome is also captured in the audit log + Linear comment, so the
    // operator visibility loss is bounded.
    if (!this.acquirePostToken(issue.id)) return;
    const root = await this.resolveThreadTs(issue.id);
    const emoji =
      outcome === "Succeeded" || outcome === "completed"
        ? ":white_check_mark:"
        : outcome === "CanceledByReconciliation"
          ? ":eject:"
          : ":x:";
    const parts = [`${emoji} *${issue.identifier}* → \`${outcome}\``];
    if (typeof detail.tokens === "number") parts.push(`tokens=${detail.tokens}`);
    if (typeof detail.costUsd === "number") parts.push(`cost=$${detail.costUsd.toFixed(4)}`);
    // cache hit-rate as a fraction of total input-side tokens
    // (cache_read / (cache_read + cache_creation + input)). Emitted ONLY
    // when there's a real cache READ (cacheReadInputTokens > 0). The
    // first dispatch within a 5-min TTL window pays the cache-creation
    // fee and reads zero — emitting `cache_hit=0.0%` there would suggest
    // caching was disabled, which it isn't. Operators see the segment
    // appear from the second dispatch onward, which is the truthful
    // "caching is working" signal. We also require all three fields to
    // be DEFINED (not just defaulted via `??`) so a partially-supplied
    // call doesn't print a misleading percentage from a wrong
    // denominator. Surfaced by Copilot review.
    if (
      typeof detail.cacheReadInputTokens === "number" &&
      detail.cacheReadInputTokens > 0 &&
      typeof detail.cacheCreationInputTokens === "number" &&
      typeof detail.inputTokens === "number"
    ) {
      const cacheBudget =
        detail.cacheReadInputTokens + detail.cacheCreationInputTokens + detail.inputTokens;
      if (cacheBudget > 0) {
        const hitRate = (detail.cacheReadInputTokens / cacheBudget) * 100;
        parts.push(`cache_hit=${hitRate.toFixed(1)}%`);
      }
    }
    if (detail.error) parts.push(`error=${escape(detail.error.slice(0, 200))}`);

    try {
      // Same defensive pattern as announceDispatch — only attach thread_ts
      // when the root post actually returned a ts. Otherwise post in-channel.
      await this.client.chat.postMessage({
        channel: this.channelId,
        text: parts.join("  "),
        ...(root ? { thread_ts: root } : {}),
      });
    } catch (err) {
      this.handleError(err, "slack announceOutcome failed");
    }
  }

  /**
   * announce a dispatch rejection (e.g. cost-cap exceeded, kill-switch
   * engaged) — collapsed across a 5-minute window so a burst of identical
   * rejections fires ONE alert.
   *
   * Posts in-channel (NOT in the per-issue thread) because rejection alerts
   * are operator-facing — visible at-a-glance in the channel feed rather
   * than buried in a ticket thread the operator may not be watching. The
   * per-issue 5s gate is intentionally bypassed for the same reason; the
   * dampening window makes that safe.
   *
   * The global token bucket IS still consumed — rejection alerts are not
   * higher-priority than progress posts, just more sticky.
   */
  async announceRejection(args: {
    kind: "cost_cap" | "kill_switch" | "preflight_failed";
    reason: string;
    issueIdentifier?: string;
  }): Promise<void> {
    if (!this.client || !this.channelId || !this.slackHealthy) return;

    const key = `${args.kind}::${args.reason}`;
    const now = Date.now();
    const lastAlertMs = this.lastRejectionAlertMs.get(key);
    if (lastAlertMs !== undefined && now - lastAlertMs < REJECTION_DAMPENING_WINDOW_MS) {
      logger.warn(
        {
          kind: args.kind,
          reason: args.reason,
          sinceLastMs: now - lastAlertMs,
          windowMs: REJECTION_DAMPENING_WINDOW_MS,
        },
        "slack.rejection_alert_throttled (within 5min dampening window)",
      );
      return;
    }
    // Refill + check global token bucket only — skip the per-issue 5s gate.
    this.refillGlobalBucket();
    if (this.globalTokens <= 0) {
      logger.warn(
        { kind: args.kind, reason: args.reason },
        "slack.rejection_alert_dropped (global bucket empty)",
      );
      return;
    }
    this.globalTokens -= 1;
    this.lastRejectionAlertMs.set(key, now);

    const emoji =
      args.kind === "cost_cap"
        ? ":coin:"
        : args.kind === "kill_switch"
          ? ":octagonal_sign:"
          : ":warning:";
    const titleByKind: Record<typeof args.kind, string> = {
      cost_cap: "dispatch rejected — cost cap exceeded",
      kill_switch: "dispatch halted — kill-switch engaged",
      preflight_failed: "dispatch skipped — preflight validation failed",
    };
    const parts = [`${emoji} *Symphony*: ${titleByKind[args.kind]}`];
    if (args.issueIdentifier) parts.push(`(triggered by *${args.issueIdentifier}*)`);
    parts.push(`reason: ${escape(args.reason.slice(0, 250))}`);

    try {
      await this.client.chat.postMessage({
        channel: this.channelId,
        text: parts.join("  "),
      });
    } catch (err) {
      this.handleError(err, "slack announceRejection failed");
    }
  }

  /**
   * Centralized error sink. Auth-fatal errors disable the observer and emit
   * one actionable warning. Everything else is logged per-call (transient
   * errors should remain visible — they often clear on the next attempt).
   */
  private handleError(err: unknown, where: string): void {
    const errorCode = extractSlackErrorCode(err);
    if (errorCode && FATAL_AUTH_ERRORS.has(errorCode) && this.slackHealthy) {
      this.slackHealthy = false;
      logger.warn(
        { err: errorCode, runbook: "docs/slack-setup.md" },
        `slack disabled — ${errorCode}; configure SLACK_BOT_TOKEN with chat:write scope (see runbook)`,
      );
      return;
    }
    if (errorCode && FATAL_AUTH_ERRORS.has(errorCode)) {
      // Already logged the headline once; suppress quietly.
      return;
    }
    logger.warn({ err: (err as Error).message }, where);
  }

  /** Test-only — reset health so a process can re-test recovery flows.
   *  Production code never calls this; the daemon restart path is the
   *  intended recovery hook. */
  _resetHealthForTests(): void {
    this.slackHealthy = true;
  }

  /** Test-only — reset rate-limit state so unit tests can issue back-to-back
   *  posts without tripping the per-issue 5s gap or the global 20/min bucket.
   *  Production code never calls this. */
  _resetRateLimitsForTests(): void {
    this.lastPostPerIssueMs.clear();
    this.lastRejectionAlertMs.clear();
    this.globalTokens = GLOBAL_TOKEN_BUCKET_CAPACITY;
    this.globalLastRefillMs = Date.now();
  }
}

/**
 * @slack/web-api throws `WebAPIPlatformError` whose `data.error` carries the
 * Slack API error string (e.g. `"invalid_auth"`). It also tags the error
 * with `code === "slack_webapi_platform_error"`. We're permissive in what we
 * accept — duck-type the `.data.error` field rather than importing the
 * concrete class.
 */
function extractSlackErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object" && "error" in data) {
      const code = (data as { error?: unknown }).error;
      if (typeof code === "string") return code;
    }
  }
  // Fallback: some Slack errors stringify as "An API error occurred: invalid_auth".
  const msg = err instanceof Error ? err.message : String(err);
  const match = /An API error occurred:\s*(\w+)/.exec(msg);
  return match?.[1];
}

/**
 * Escape user-supplied text for Slack mrkdwn message bodies (`chat.postMessage`
 * with the default `text:` field — which Slack parses as mrkdwn).
 *
 * Slack's mrkdwn syntax has no documented backslash-escape mechanism, so a
 * Linear issue title containing `*bold*` or `_italic_` would render with the
 * intended formatting stripped — making "Fix `*` glob bug" land as
 * "Fix " + bold "" + " glob bug". The fix is twofold:
 *
 *   1. HTML-escape `<`, `>`, `&` — Slack honors these and decodes them back.
 *      Required because raw `<` / `>` would be interpreted as link tags.
 *   2. Replace mrkdwn-trigger glyphs (`*`, `_`, `~`, `` ` ``) with visually
 *      similar Unicode characters that don't trigger formatting. Not perfect
 *      (the homoglyphs render slightly differently in some fonts) but
 *      preferred over the alternative of accidentally bolding parts of a
 *      title or stripping characters entirely.
 *
 * For paths that need literal rendering (e.g. error messages with arbitrary
 * stack traces), wrap the value in a code span in the caller — `` `${value}` ``
 * — and skip this helper, since code spans don't parse inner mrkdwn.
 *
 * Long-term: persisting Slack thread-ts in DB lands first; a
 * follow-up could migrate to Block Kit `plain_text` sections, which avoid
 * mrkdwn parsing entirely. Out of scope for now.
 */
function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*/g, "∗") // U+2217 ASTERISK OPERATOR (visual ≈ `*`, no bold)
    .replace(/_/g, "ˍ") // U+02CD MODIFIER LETTER LOW MACRON (visual ≈ `_`, no italic)
    .replace(/~/g, "˜") // U+02DC SMALL TILDE (visual ≈ `~`, no strikethrough)
    .replace(/`/g, "ˋ"); // U+02CB MODIFIER LETTER GRAVE ACCENT (visual ≈ `` ` ``, no code span)
}
