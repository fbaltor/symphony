#!/usr/bin/env node
import { createServer } from "node:http";
import { resolve } from "node:path";
import { logger } from "./observability/logger.js";
import { WorkflowError } from "./workflow/loader.js";
import { WorkflowWatcher } from "./workflow/watch.js";
import { LinearTrackerClient } from "./tracker/linear.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { shutdownPool } from "./audit/client.js";
import { buildDeps } from "./deps.js";
import { handleHttpRequest } from "./observability/http-routes.js";
import {
  pruneWebhookDedup,
  WEBHOOK_DEDUP_CLEANUP_INTERVAL_MS,
} from "./webhook/linear-receiver.js";
import { SYMPHONY_VERSION, readGitSha } from "./lib/build-info.js";
import type pg from "pg";
import type { SymphonyConfig } from "./workflow/config.js";

/**
 * Spec §17.7 — CLI lifecycle.
 *
 *   symphony [path-to-WORKFLOW.md]
 *
 * If no positional arg, defaults to `./WORKFLOW.md` relative to CWD.
 */

// Global last-resort guards. Node crashes on unhandled `error` events from
// EventEmitters; the orchestrator has many of those (pg pool clients, MCP
// stdio subprocesses, claude SDK streams). Specific event handlers
// (pool.on, client.on) are preferred; these handlers catch the ones we
// missed.
//
// Per IMPROVEMENTS.md S-D3 / A-3: log fatal + exit(1). Cloud Run restarts
// the revision; the singleton-lock lease (15s) ages out before the new
// instance reclaims it, so the brief downtime is bounded. The previous
// "swallow forever" behavior risked a wedged process that kept logging
// the same error indefinitely while not making real progress.
process.on("uncaughtException", (err) => {
  logger.fatal(
    { err: err.message, stack: err.stack },
    "uncaughtException — exiting (Cloud Run will restart; singleton lock lease ages out in 15s)",
  );
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const r = reason as Error | undefined;
  logger.fatal(
    { err: r?.message ?? String(reason), stack: r?.stack },
    "unhandledRejection — exiting (Cloud Run will restart)",
  );
  process.exit(1);
});

async function main(): Promise<void> {
  // B-15 follow-up: identify Symphony to upstream APIs. Anthropic logs the
  // `CLAUDE_AGENT_SDK_CLIENT_APP` env value alongside each request — letting
  // an operator filter Anthropic dashboard usage by build identifier. Set
  // BEFORE the first SDK import (the SDK reads env at module-load time, not
  // per-call). Format mirrors the GitHub User-Agent + Slack root footer:
  //   `symphony/<version>+<gitSha>`
  if (!process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = `symphony/${SYMPHONY_VERSION}+${readGitSha()}`;
  }

  // Bind the HTTP health endpoint as the FIRST thing we do, before any check
  // that can `process.exit(1)`. Cloud Run's startup probe is TCP on $PORT —
  // if we exit before binding (e.g. missing DATABASE_URL), the revision is
  // declared dead and pulumi/CI cannot tell config errors from crashes.
  // While bootstrap runs the endpoint reports `503 starting`; once orchestrator
  // is up it reports `200 ok` plus snapshot via /status.
  const httpPort = Number(process.env.PORT ?? 8080);
  let bootstrapReady = false;
  let bootstrapError: string | null = null;
  let orchestratorRef: Orchestrator | null = null;
  let poolRef: pg.Pool | null = null;
  let configRef: SymphonyConfig | null = null;
  let instanceIdRef: string | null = null;
  let watcherRef: WorkflowWatcher | null = null;
  // E-17 / E-18: tracker reference shared with the `/webhook/linear` receiver.
  // Bootstrap may not have constructed it yet when the first webhook lands;
  // the receiver returns 503 in that window so Linear retries.
  let trackerRef: LinearTrackerClient | null = null;
  // A-32: gate for the POST /admin/reload route. Empty / unset = route
  // returns 503 ("admin_disabled"); set to a strong random token in
  // Cloud Run env to enable.
  const adminToken = (process.env.SYMPHONY_ADMIN_TOKEN ?? "").trim() || null;
  // E-17 / E-18: Linear webhook HMAC secret. Operator pastes the value Linear
  // shows in their webhook config UI into the GCP Secret Manager secret
  // `symphony-linear-webhook-secret` (Pulumi-provisioned). When unset
  // (placeholder secret), the `/webhook/linear` route returns 503 and
  // Symphony falls back to the 30s polling loop.
  const webhookSecret = (process.env.LINEAR_WEBHOOK_SECRET ?? "").trim() || null;
  const httpServer = createServer((req, res) => {
    void handleHttpRequest(
      req.url ?? "",
      res,
      {
        bootstrapReady,
        bootstrapError,
        orchestrator: orchestratorRef,
        pool: poolRef,
        config: configRef,
        instanceId: instanceIdRef,
        watcher: watcherRef,
        adminToken,
        tracker: trackerRef,
        webhookSecret,
      },
      req,
    );
  });
  await new Promise<void>((resolveListen) =>
    httpServer.listen(httpPort, () => {
      logger.info({ port: httpPort }, "health endpoint listening");
      resolveListen();
    }),
  );

  const argv = process.argv.slice(2);
  const workflowPath = resolve(argv[0] ?? process.env.SYMPHONY_WORKFLOW_PATH ?? "WORKFLOW.md");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    bootstrapError = "DATABASE_URL not set";
    logger.error({ err: bootstrapError }, "bootstrap aborted; HTTP health stays at 503");
    return;
  }
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackChannel = process.env.SLACK_CHANNEL_ID;

  if (process.env.ANTHROPIC_API_KEY === undefined) {
    logger.warn("ANTHROPIC_API_KEY not set; the Claude adapter will fail at runtime");
  }

  let watcher;
  let pool;
  let lockHandle;
  let orchestrator: Orchestrator;
  // AGENT-520: forward-reference the shutdown trigger so the lock module's
  // heartbeat tick can fire it when another instance requests a handoff.
  // Assigned below after `shutdown` is defined; calls before then are no-ops
  // (the only caller is the heartbeat poll, which can only fire AFTER
  // acquireInstanceLock returns, which happens AFTER `shutdown` is wired up).
  let triggerHandoff: (() => void) | null = null;
  try {
    watcher = await WorkflowWatcher.start(workflowPath, process.env);
    watcherRef = watcher;
    const snapshot = watcher.snapshot();
    const cfg = snapshot.config;

    // Phase E (zero-dep E2E): build the orchestrator's dependency bundle via
    // the `buildDeps` composition factory. For `kind=linear` (the production
    // profile) this constructs the SAME impls main.ts always built — createPool,
    // the Postgres-backed stores, PostgresInstanceLock, LinearTrackerClient, the
    // per-turn-MCP-resolving Claude runner, the real/disabled SlackObserver, and
    // GithubDeliverableSource — so the boot path is behavior-identical. main.ts
    // still owns ALL boot orchestration (lock acquire, orphan reaper, viewer-id
    // fetch, watcher start, HTTP routes, signals, drain), reaching into the
    // bundle's `pool` / `lock` / `tracker` for those steps. The env-derived
    // inputs (DATABASE_URL, Slack creds) and the file-watching `watcher` are
    // owned here and threaded in via `overrides.linear`.
    const deps = buildDeps(cfg, {
      linear: {
        watcher,
        databaseUrl,
        dbSchema: process.env.DB_SCHEMA ?? "symphony",
        slackToken,
        slackChannel,
      },
    });
    pool = deps.pool as pg.Pool;
    poolRef = pool;

    // Phase D (zero-dep E2E): the advisory lock goes through the `InstanceLock`
    // seam from the bundle. `PostgresInstanceLock` delegates to the unchanged
    // `acquireInstanceLock`, so the real boot path is identical.
    lockHandle = await deps.lock.acquire({
      onHandoffRequested: () => {
        // AGENT-520: another Cloud Run revision is asking us to step down.
        // Re-use the existing SIGTERM-driven shutdown path (drain workers
        // gracefully, release lock early so the new revision can boot).
        // The deref is null until `shutdown` is defined below; in practice
        // the heartbeat tick can only fire AFTER acquireInstanceLock has
        // returned successfully, which means main has reached the end of
        // its bootstrap and `shutdown` IS defined.
        if (triggerHandoff) triggerHandoff();
      },
    });
    // PostgresInstanceLock always resolves to a handle (it blocks until held);
    // null would only come from a memory lock, which main.ts never builds.
    if (!lockHandle) {
      throw new Error("instance lock acquire returned null (unexpected for kind=linear)");
    }
    instanceIdRef = lockHandle.instanceId;

    // Task 2 (2026-05-06): orphan-run reaper. Find `running_runs` rows
    // from a previous instance (whose container died before its worker
    // could write an audit row) and write synthetic `outcome=Killed`
    // audit rows so `/cost` and ops dashboards reflect the cost-truth
    // surfaced by AGENT-521.
    //
    // Best-effort — failure here does NOT block boot (we've already
    // acquired the lock; observability gap is recoverable on next
    // boot). Synchronous before orchestrator.start() so reaped rows
    // settle before the new instance starts dispatching.
    const reaped = await deps.audit.reapOrphanedRuns(lockHandle.instanceId);
    if (reaped > 0) {
      logger.warn({ reaped }, "boot: reaped orphaned running_runs from prior instance");
    }

    const tracker = deps.tracker as LinearTrackerClient;
    // E-17 / E-18: publish the tracker to the HTTP route closure so the
    // `/webhook/linear` receiver can drive cascades via the same client
    // the poll loop uses (token, scope, retry semantics all match).
    trackerRef = tracker;

    // A-16 / S-D13 (Task 2): one-shot lookup of the bot's own Linear
    // user id. The reconciler reads this via `tracker.getViewerId()` to
    // distinguish bot-driven moves (revert candidate) from human-driven
    // moves (must NOT be reverted). Best-effort — failure leaves
    // viewerId=null and the reconciler falls back to the legacy revert
    // behavior, so a Linear API hiccup at boot doesn't block Symphony.
    const viewerId = await tracker.fetchViewerId().catch(() => null);
    if (viewerId) {
      logger.info({ viewerId }, "boot: bot Linear user id resolved");
    } else {
      logger.warn(
        {},
        "boot: tracker.fetchViewerId returned null; reconciler will use legacy revert behavior",
      );
    }

    orchestrator = new Orchestrator({
      ...deps,
      // Task 2 (2026-05-06): instance ID flows into the orchestrator so
      // each worker writes a `running_runs` row tagged with this
      // revision's identity. The orphan reaper above ran BEFORE this
      // point and already wrote synthetic Killed audit rows for any rows
      // from a prior crashed instance.
      instanceId: lockHandle.instanceId,
    });
    orchestratorRef = orchestrator;
    configRef = cfg;
  } catch (err) {
    const e = err as Error;
    bootstrapError = e instanceof WorkflowError ? `${e.code}: ${e.message}` : e.message;
    logger.error(
      { err: bootstrapError },
      "bootstrap failed; HTTP health stays at 503 (Cloud Run startup probe still passes)",
    );
    return;
  }

  let shuttingDown = false;
  // `signal` is widened from NodeJS.Signals to include AGENT-520's "handoff"
  // pseudo-signal. The handoff path is identical to SIGTERM otherwise — we
  // just want the log line to make the cause clear in the gcloud trail.
  const shutdown = async (signal: NodeJS.Signals | "handoff") => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown initiated");
    // Graceful drain: Cloud Run sends SIGTERM at the start of revision
    // rollout and gives us terminationGracePeriodSeconds (configured to
    // 540s) before SIGKILL. We stop accepting new dispatches and wait for
    // in-flight turns to finish so a rollout doesn't kill an active agent
    // mid-thought. Long-running turns (>540s) still get cancelled, but
    // this covers the median case.
    //
    // Tunable via SYMPHONY_DRAIN_TIMEOUT_MS env var. Default 540000 (9 min)
    // — leaves Cloud Run's 600s grace window 60s of headroom for the
    // post-drain steps below (watcher.stop, lock release, pool shutdown).
    // Validate + clamp: a misset env var (negative, NaN, "abc", or
    // "0") would otherwise turn into an invalid drain timeout and the
    // gracefulStop loop would skip its drain entirely, aborting every
    // in-flight turn immediately. Surfaced by CodeRabbit on PR #502.
    const DEFAULT_DRAIN_MS = 540_000;
    const MAX_DRAIN_MS = 600_000; // Cloud Run platform max for grace period
    const rawDrainEnv = process.env.SYMPHONY_DRAIN_TIMEOUT_MS;
    const parsedDrainMs = rawDrainEnv === undefined ? NaN : Number(rawDrainEnv);
    const drainTimeoutMs =
      Number.isFinite(parsedDrainMs) && parsedDrainMs > 0
        ? Math.min(parsedDrainMs, MAX_DRAIN_MS)
        : DEFAULT_DRAIN_MS;
    if (rawDrainEnv !== undefined && drainTimeoutMs !== Number(rawDrainEnv)) {
      logger.warn(
        { provided: rawDrainEnv, used: drainTimeoutMs },
        "SYMPHONY_DRAIN_TIMEOUT_MS invalid or out of range; falling back to default",
      );
    }
    // Kick off graceful drain. `gracefulStop` synchronously sets
    // `stopped = true` + cancels the polling timer in its prelude (before
    // its first await), so dispatch is halted the moment we call this —
    // independent of when the returned Promise resolves.
    const drainPromise = orchestrator.gracefulStop(drainTimeoutMs);

    // Release the singleton-instance advisory lock IMMEDIATELY, while the
    // cloud-sql-proxy sidecar is still alive. The lock is "may dispatch"
    // semantics; we already halted dispatch via `gracefulStop` above, so
    // releasing the lock now is safe and lets the next Cloud Run revision
    // boot + start dispatching new tickets while we drain in-flight work
    // here (workers track their own claimed tickets in-memory; the new
    // revision picks up DIFFERENT tickets via the polling loop).
    //
    // Why early release matters: Cloud Run sends SIGTERM to the main
    // container AND the cloud-sql-proxy sidecar at the same time. If we
    // wait for the drain to complete (up to 540s) before releasing,
    // the sidecar is long dead by then, the unlock query fails over a
    // closed socket, and the PG session-scoped advisory lock survives
    // until Postgres reaps the orphaned TCP session — a window of
    // tcp_keepalive_idle + several keepalive probes (minutes). The
    // subsequent revision then sits in `advisory lock not yet free` for
    // its full 60s retry window and crashes its startup probe.
    //
    // The `release()` call is idempotent; the post-drain fallback below
    // is a defensive no-op if this early call already fired.
    try {
      await lockHandle.release();
      logger.info("singleton lock released early (proxy still alive)");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "early lock release failed");
    }

    try {
      const r = await drainPromise;
      logger.info(r, "graceful stop completed");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "orchestrator.gracefulStop failed");
    }
    try {
      watcher.stop();
    } catch (err) {
      logger.error({ err: (err as Error).message }, "watcher.stop failed");
    }
    try {
      // Defensive fallback — release() is idempotent so this is a no-op
      // unless the early release above was skipped (e.g. lockHandle was
      // never assigned because acquireInstanceLock threw; guarded below).
      if (lockHandle) await lockHandle.release();
    } catch (err) {
      logger.error({ err: (err as Error).message }, "lock release fallback failed");
    }
    try {
      await shutdownPool();
    } catch (err) {
      logger.error({ err: (err as Error).message }, "pool shutdown failed");
    }
    // Flush pino's async stream before exit. Without this, the last few
    // log lines (including the all-important "all turns drained cleanly"
    // and orchestrator outcome writes) can be buffered and lost on
    // process.exit(0). We observed this on multiple redeploys: only 5
    // log lines from the old revision after SIGTERM, then silence —
    // even though the drain ran for 5+ seconds and wrote audit rows.
    // pino's `flush(cb)` is async; wrap in a 1s timeout so a stuck
    // flush doesn't block the exit indefinitely.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1_000);
      logger.flush?.((_err) => {
        clearTimeout(t);
        // Don't log here — pino's stream is on its way out.
        resolve();
      });
    });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // AGENT-520: wire the lock module's heartbeat-tick handoff signal to
  // the same shutdown path. The heartbeat tick can only fire AFTER
  // acquireInstanceLock returned (which it has, by the time we reach
  // here), but the closure passed to acquireInstanceLock has been
  // capturing this `triggerHandoff` reference since main started — so
  // we just need to point it at the now-defined `shutdown`.
  triggerHandoff = () => void shutdown("handoff");

  await orchestrator.start();
  bootstrapReady = true;

  // E-18 follow-up: webhook dedup table cleanup. Linear retries failed
  // deliveries for up to 24h on 5xx, so the table needs at least a 24h
  // retention window. Without periodic cleanup the table grows unbounded
  // (~few thousand rows/day at current volume — acceptable short-term but
  // not forever). Surfaced 2026-05-07 by Copilot review on PR #684.
  //
  // Run once on boot (catches up after a long downtime) and then every
  // hour. Best-effort: pruneWebhookDedup() already catches and logs its
  // own pg errors; the .catch() here surfaces any UNEXPECTED rejection
  // (e.g., the function itself throwing a programmer error) so an
  // operator can see retention is silently failing rather than the
  // table growing without alarm.
  pruneWebhookDedup(pool).catch((err: Error) =>
    logger.warn(
      { err: err.message },
      "boot pruneWebhookDedup rejected unexpectedly",
    ),
  );
  const webhookDedupTimer = setInterval(() => {
    pruneWebhookDedup(pool).catch((err: Error) =>
      logger.warn(
        { err: err.message },
        "scheduled pruneWebhookDedup rejected unexpectedly",
      ),
    );
  }, WEBHOOK_DEDUP_CLEANUP_INTERVAL_MS);
  // Don't keep the event loop alive on shutdown.
  webhookDedupTimer.unref();
  // Log resolved config at startup so an operator can verify model /
  // state-machine / write toggles without grepping through WORKFLOW.md +
  // resolveConfig in two places. Caught the agent_runtime snake-vs-camel
  // bug the hard way (SDK silently fell back to default model); this
  // single line would have flagged it on the first boot. Re-snapshot via
  // the watcher because the bootstrap-scope `cfg` const is out of scope
  // here.
  const startedSnap = watcher.snapshot().config;
  logger.info(
    {
      // B-15: surface build provenance in the boot banner so the first
      // log line after a deploy unambiguously names the running binary.
      version: SYMPHONY_VERSION,
      gitSha: readGitSha(),
      workflowPath,
      port: httpPort,
      model: startedSnap.agentRuntime.model ?? "(SDK default)",
      runtime: startedSnap.agentRuntime.runtime,
      activeStates: startedSnap.tracker.activeStates,
      terminalStates: startedSnap.tracker.terminalStates,
      stateTransitions: startedSnap.tracker.stateTransitions,
      announceDispatch: startedSnap.tracker.announceDispatch,
      announceOutcome: startedSnap.tracker.announceOutcome,
      pollIntervalMs: startedSnap.polling.intervalMs,
      maxConcurrentAgents: startedSnap.agent.maxConcurrentAgents,
    },
    "symphony started",
  );
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message, stack: (err as Error).stack }, "main crashed");
  process.exit(1);
});
