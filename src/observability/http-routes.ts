import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { IssueTracker } from "../tracker/tracker.js";
import type { SymphonyConfig } from "../workflow/config.js";
import type { WorkflowWatcher } from "../workflow/watch.js";
import { getCostRollup } from "../audit/queries.js";
import { SYMPHONY_VERSION, readGitSha } from "../lib/build-info.js";
import { handleLinearWebhook, isWebhookPath } from "../webhook/index.js";
import { clearKillSwitch, engageKillSwitch, readKillSwitch } from "./kill-switch.js";
import { logger } from "./logger.js";

/**
 * HTTP route handler split out from `main.ts` so the routes can be unit
 * tested without booting the full orchestrator. The handler is async so
 * `/cost` can await the rollup query, but `/health` and `/status` resolve
 * synchronously to keep the Cloud Run startup-probe path fast.
 */

export interface HttpRouteContext {
  bootstrapReady: boolean;
  bootstrapError: string | null;
  orchestrator: Pick<Orchestrator, "snapshot"> | null;
  pool: pg.Pool | null;
  config: SymphonyConfig | null;
  instanceId: string | null;
  /** A-32: WorkflowWatcher exposed for `POST /admin/reload`. Optional so
   * existing callers (tests) can construct contexts without it. */
  watcher?: Pick<WorkflowWatcher, "reloadNow"> | null;
  /** A-32: token gating for /admin/* routes. Read from `SYMPHONY_ADMIN_TOKEN`
   * env var by main.ts; null/empty = admin routes return 503. */
  adminToken?: string | null;
  /** E-17 / E-18: Linear tracker shared with the poll loop, used by the
   * `/webhook/linear` receiver to drive cascades without re-establishing
   * an HTTP client. Optional so existing callers (tests for /health,
   * /status, /cost) don't need to wire it up. */
  tracker?: IssueTracker | null;
  /** E-17 / E-18: Linear webhook HMAC secret. Read from `LINEAR_WEBHOOK_SECRET`
   * env var by main.ts; null/empty = `/webhook/linear` returns 503
   * (`webhook_disabled`). The poll loop continues running as a fallback. */
  webhookSecret?: string | null;
}

export async function handleHttpRequest(
  url: string,
  res: ServerResponse,
  ctx: HttpRouteContext,
  req?: IncomingMessage,
): Promise<void> {
  // E-17 / E-18 — `POST /webhook/linear`. Routed BEFORE /health so a
  // misconfigured proxy that forwards Linear's POST body to /health doesn't
  // accidentally short-circuit on the `url === "/"` branch above.
  // Webhook receiver owns its own auth + size + dedup gates; main.ts threads
  // the tracker + secret + pool through `ctx`.
  if (req && isWebhookPath(url)) {
    await handleLinearWebhook(req, res, {
      pool: ctx.pool,
      tracker: ctx.tracker ?? null,
      webhookSecret: ctx.webhookSecret ?? null,
    });
    return;
  }

  if (url === "/health" || url === "/") {
    // B-15: surface build provenance on /health so an on-call operator can
    // confirm "the fix shipped" with a single curl. Field names mirror
    // Cerebro's /health envelope.
    const build = { version: SYMPHONY_VERSION, gitSha: readGitSha() };
    if (ctx.bootstrapReady) {
      respondJson(res, 200, { status: "ok", ...build });
    } else {
      respondJson(res, 503, { status: "starting", error: ctx.bootstrapError, ...build });
    }
    return;
  }

  if (url === "/status") {
    if (!ctx.orchestrator) {
      respondJson(res, 503, { status: "starting", error: ctx.bootstrapError });
      return;
    }
    const snap = ctx.orchestrator.snapshot();
    respondJson(res, 200, { instance_id: ctx.instanceId, ...snap });
    return;
  }

  if (url === "/cost") {
    if (!ctx.pool || !ctx.config) {
      respondJson(res, 503, { status: "starting", error: ctx.bootstrapError });
      return;
    }
    try {
      const rollup = await getCostRollup(ctx.pool);
      const guardrails = ctx.config.guardrails;
      const dailyCap = guardrails.dailyCapUsd;
      const perIssueCap = guardrails.perIssueCapUsd;
      const dailyRemaining = dailyCap > 0 ? round2(Math.max(0, dailyCap - rollup.todayUsd)) : 0;
      const anyCappedIssues =
        perIssueCap > 0
          ? rollup.byIssue.filter((row) => row.totalUsd >= perIssueCap).map((row) => row.identifier)
          : [];
      respondJson(res, 200, {
        today_usd: rollup.todayUsd,
        month_usd: rollup.monthUsd,
        by_issue: rollup.byIssue.map((row) => ({
          identifier: row.identifier,
          total_usd: row.totalUsd,
          runs: row.runs,
          first_seen: row.firstSeen,
          last_seen: row.lastSeen,
        })),
        caps: {
          daily_cap_usd: dailyCap,
          per_issue_cap_usd: perIssueCap,
          daily_remaining_usd: dailyRemaining,
          any_capped_issues: anyCappedIssues,
        },
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "/cost handler failed");
      respondJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // B-13 — `GET|POST /admin/kill-switch`: flip the dispatch halt-switch.
  // Token-gated like /admin/reload. Query string `op=engage|clear|status`
  // (default: status). On engage, optional `reason=` + `by=` query params
  // are persisted to the audit row. In-flight workers DRAIN — kill-switch
  // halts new dispatches only.
  if (url.startsWith("/admin/kill-switch")) {
    if (!ctx.adminToken || ctx.adminToken.length === 0) {
      respondJson(res, 503, {
        error: {
          code: "admin_disabled",
          message: "SYMPHONY_ADMIN_TOKEN not configured; /admin/* routes disabled",
        },
      });
      return;
    }
    const auth = req?.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (presented.length === 0 || presented !== ctx.adminToken) {
      respondJson(res, 401, {
        error: { code: "unauthorized", message: "Bearer token missing or mismatched" },
      });
      return;
    }
    if (!ctx.pool) {
      respondJson(res, 503, {
        error: { code: "pool_unavailable", message: "Postgres pool not bootstrapped" },
      });
      return;
    }
    // Parse query string (split off the path).
    const q = url.includes("?")
      ? new URLSearchParams(url.slice(url.indexOf("?") + 1))
      : new URLSearchParams();
    const op = (q.get("op") ?? "status").toLowerCase();
    try {
      if (op === "engage") {
        if (req?.method !== "POST") {
          respondJson(res, 405, {
            error: { code: "method_not_allowed", message: "POST required for op=engage" },
          });
          return;
        }
        await engageKillSwitch(ctx.pool, {
          reason: q.get("reason") ?? undefined,
          by: q.get("by") ?? undefined,
        });
        const state = await readKillSwitch(ctx.pool);
        respondJson(res, 200, { status: "engaged", ...serializeKillSwitch(state) });
        return;
      }
      if (op === "clear") {
        if (req?.method !== "POST") {
          respondJson(res, 405, {
            error: { code: "method_not_allowed", message: "POST required for op=clear" },
          });
          return;
        }
        await clearKillSwitch(ctx.pool);
        respondJson(res, 200, { status: "cleared" });
        return;
      }
      if (op === "status") {
        const state = await readKillSwitch(ctx.pool);
        respondJson(res, 200, serializeKillSwitch(state));
        return;
      }
      respondJson(res, 400, {
        error: { code: "invalid_op", message: "op must be one of: engage, clear, status" },
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "/admin/kill-switch failed");
      respondJson(res, 500, {
        error: { code: "kill_switch_failed", message: (err as Error).message },
      });
    }
    return;
  }

  // A-32 — `POST /admin/reload`: re-read WORKFLOW.md from disk on demand.
  // Token-gated; useful in production where `fs.watch` doesn't fire (the
  // file is baked into the Cloud Run image). Operator workflow:
  //
  //   gcloud run services proxy symphony-orchestrator --port=8080 ...
  //   curl -X POST -H "Authorization: Bearer $SYMPHONY_ADMIN_TOKEN" \
  //     localhost:8080/admin/reload
  if (url === "/admin/reload") {
    if (!req || req.method !== "POST") {
      respondJson(res, 405, { error: { code: "method_not_allowed", message: "POST required" } });
      return;
    }
    if (!ctx.adminToken || ctx.adminToken.length === 0) {
      respondJson(res, 503, {
        error: {
          code: "admin_disabled",
          message: "SYMPHONY_ADMIN_TOKEN not configured; /admin/* routes disabled",
        },
      });
      return;
    }
    const auth = req.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (presented.length === 0 || presented !== ctx.adminToken) {
      respondJson(res, 401, {
        error: { code: "unauthorized", message: "Bearer token missing or mismatched" },
      });
      return;
    }
    if (!ctx.watcher) {
      respondJson(res, 503, {
        error: { code: "watcher_unavailable", message: "WorkflowWatcher not bootstrapped" },
      });
      return;
    }
    try {
      const snap = await ctx.watcher.reloadNow();
      respondJson(res, 200, {
        status: "reloaded",
        loaded_at: new Date(snap.loadedAt).toISOString(),
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "/admin/reload failed");
      respondJson(res, 500, { error: { code: "reload_failed", message: (err as Error).message } });
    }
    return;
  }

  res.writeHead(404);
  res.end();
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Convert KillSwitchState to a JSON-friendly envelope. */
function serializeKillSwitch(state: {
  engaged: boolean;
  reason: string | null;
  engagedAt: Date | null;
  engagedBy: string | null;
}): Record<string, unknown> {
  return {
    engaged: state.engaged,
    reason: state.reason,
    engaged_at: state.engagedAt ? state.engagedAt.toISOString() : null,
    engaged_by: state.engagedBy,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
