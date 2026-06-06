import type pg from "pg";
import { setTimeout as wait } from "node:timers/promises";
import type { Issue, OrchestratorState, RetryEntry, RunningEntry } from "../types.js";
import { logger, withContext } from "../observability/logger.js";
import { preflightValidate, type SymphonyConfig } from "../workflow/config.js";
import type { WorkflowSnapshot, WorkflowWatcher } from "../workflow/watch.js";
import type { IssueTracker } from "../tracker/tracker.js";
import { availableSlots, createState, perStateLimit, runningInState } from "./state.js";
import { computeBackoffMs, isEligible, sortForDispatch } from "./dispatch.js";
import { reconcileStalledRuns, reconcileTrackerStates } from "./reconcile.js";
import { ensureWorkspace } from "../workspace/manager.js";
import { runHook } from "../workspace/hooks.js";
import { getInstallationToken } from "../lib/github-auth.js";
import { branchMatchesIdentifier, fetchBranches, fetchPullRequestForIssue } from "../lib/github.js";
import { cleanupTerminalIssues, cleanupWorkspace } from "../workspace/cleanup.js";
import {
  buildContinuationGuidance,
  buildFullPrompt,
  buildSpecialistPrompt,
} from "../agent/prompt.js";
import type { AgentRunner } from "../agent/runner.js";
import { attachWorkspace } from "../agent/claude-adapter.js";
import { recordRunEnd, recordRunStart, writeRunAudit } from "../audit/writer.js";
import { recordSpecialistRun } from "../audit/issue-metadata.js";
import { findSpecialist } from "../agents/index.js";
import { readGitSha } from "../lib/build-info.js";
import { countAttemptsForIssue, lastFailedAtForIssue } from "../audit/queries.js";
import { checkCaps, recordCost } from "../guardrails/cost-cap.js";
import { readBudget } from "../guardrails/budget-state.js";
import type { SlackObserver } from "../observability/slack.js";
import { cancelTimer, nowMonotonicMs, scheduleTimer } from "../lib/time.js";
import { sanitizeIdentifier } from "../lib/ids.js";
import {
  parseSubTickets,
  renderChildDescription,
  shouldInjectNoPrRequiredMarker,
} from "./sub-tickets.js";
import { ReviewGateStore, WriteThroughLastSeenMap } from "./review-gate-store.js";
import { runDevelopmentCascade } from "./cascade.js";
import { readKillSwitch } from "../observability/kill-switch.js";
import { parseDecisionOverride } from "../lib/section-manager.js";

/**
 * Spec §8 — top-level orchestrator. Owns the poll loop, retry queue,
 * reconciliation, and the per-issue worker lifecycle.
 */

export interface OrchestratorDeps {
  watcher: WorkflowWatcher;
  /**
   * Issue tracker. Typed as the base `IssueTracker` interface — the
   * sub-ticketing extensions the orchestrator calls (`createIssue`,
   * `archiveIssue`, `resolveLabelIds`, `getTeamId`, `updateIssueDescription`)
   * now live on `IssueTracker` itself, so an alternate implementation (e.g.
   * the in-memory `MemoryTracker`) plugs in without the orchestrator reaching
   * for Linear-specific types.
   */
  tracker: IssueTracker;
  runner: AgentRunner;
  pool: pg.Pool;
  slack: SlackObserver;
  /**
   * Task 2 (2026-05-06): instance ID from `acquireInstanceLock`. Stored
   * with each `running_runs` row so the orphan reaper can identify
   * previous-instance entries. Optional for backward compatibility with
   * tests that construct orchestrators without going through main.ts;
   * runtime tracking degrades gracefully (no row, no reaper coverage)
   * when undefined.
   */
  instanceId?: string;
}

/**
 * Shape returned by `Orchestrator.snapshot()`. Consumed by the `/status`
 * HTTP route in `src/main.ts`. Field names use snake_case because they're
 * serialized straight to JSON over an HTTP API surface (cerebro convention).
 *
 * `instance_id` is NOT included here — the orchestrator doesn't know its
 * singleton-lock identity. The HTTP handler in `main.ts` merges that field
 * onto this object before responding.
 */
export interface OrchestratorSnapshot {
  running: Array<{
    identifier: string;
    state: string;
    started_at: string;
    duration_seconds: number;
  }>;
  retrying: Array<{
    identifier: string;
    attempt: number;
    next_due_in_seconds: number;
    kind: "retry" | "continuation";
  }>;
  totals_since_start: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
    seconds_running: number;
  };
  config: {
    active_states: string[];
    terminal_states: string[];
    max_concurrent_agents: number;
    model: string | null;
  };
}

/**
 * Bug F (AGENT-512): behavioural-probe tickets have no PR by design — the
 * deliverable IS a Linear comment (e.g. T-017 v2 redaction probe). Without
 * an opt-out, the deliverable-gate loops these tickets through warn →
 * escalate-to-Error → re-dispatch, burning ~$1.20 per cycle.
 *
 * The fix: an operator drops `<!-- symphony:no-pr-required -->` anywhere in
 * the issue body and the gate short-circuits the GitHub branch check. Match
 * is case-insensitive and tolerates whitespace inside the comment, so the
 * marker survives Linear's markdown round-tripping. Substring rather than
 * full-line so it can sit anywhere — top, bottom, inside a `## Notes`
 * section, etc.
 *
 * Convention follows the existing `<!-- symphony:event=... -->` markers
 * the orchestrator emits on lifecycle comments (see e.g. the
 * `deliverable_missing` warning body downstream in this file).
 */
const NO_PR_REQUIRED_MARKER_RE = /<!--\s*symphony:no-pr-required\s*-->/i;

export class Orchestrator {
  private state: OrchestratorState;
  private deps: OrchestratorDeps;
  private currentConfig: SymphonyConfig;
  private currentTemplate: string;
  private nextTickTimer: NodeJS.Timeout | null = null;
  /**
   * Periodic timer for the Error → auto-retry recovery loop. Fires every
   * `polling.errorRetryIntervalMs` and runs `processErrorRetries()` to
   * scan `tracker.errorStates` for tickets ready to be released back into
   * the dispatch loop. Cancelled in `stop()` and `gracefulStop()` so a
   * draining instance doesn't move tickets back to active right as it's
   * about to exit.
   */
  private errorRetryTimer: NodeJS.Timeout | null = null;
  /**
   * Set of issue ids currently being processed by `processErrorRetries()`.
   * The processing path issues a Linear state-transition mutation that
   * isn't instantaneous; without this guard a fast `errorRetryIntervalMs`
   * could double-fire on the same issue between mutation send and its
   * `state` field flipping in Linear's response. Same idea as
   * `state.claimed` for the dispatch loop.
   */
  private errorRetryInFlight: Set<string> = new Set();
  private stopped = false;
  private unsubscribeReload: (() => void) | null = null;
  /**
   * Worker promises in flight. Tracked so gracefulStop() can await the
   * full lifecycle (audit + linear writes happen in runWorker's `finally`,
   * AFTER state.running.delete()) — without this, the drain loop could
   * exit while the post-finally I/O is still pending and the pool would
   * close mid-write, dropping audit rows + Linear outcome comments.
   */
  private workerPromises: Set<Promise<void>> = new Set();
  /**
   * Per-issue counter of consecutive `outcome=Succeeded` turns where the
   * deliverable check (a branch / PR for the issue) failed. Reset on a
   * passing check or a non-Succeeded outcome. After
   * `tracker.noPrRetryLimit` (default 3) consecutive misses we move the
   * issue to `Error` so a human can intervene.
   *
   * Closes the bug observed on AGENT-441 + AGENT-439 (2026-04-29) where
   * the orchestrator auto-advanced to `Code Review` despite the agent
   * never pushing a branch.
   */
  private noDeliverableCount: Map<string, number> = new Map();
  /**
   * Bug D fix (AGENT-490): when the deliverable-gate escalation tries to
   * transition the issue to `Error` and the Linear team doesn't have an
   * `Error` state (Cerebro team currently has none — `error_states: []`
   * in WORKFLOW.md), the transition fails silently and `noDeliverableCount`
   * resets. Without this map, the orchestrator would re-dispatch the same
   * issue every poll forever, each dispatch costing ~$1.20 because the
   * agent correctly recognizes "deliverable already exists" and no-ops.
   *
   * After escalation, we record the issue + its dispatch state in this map.
   * `tick()` checks the map before dispatching: if the issue's current
   * Linear state still matches the recorded state, dispatch is SKIPPED
   * (the human hasn't intervened yet). When the human moves the issue out
   * of that state (or back into it from elsewhere), the recorded state no
   * longer matches and dispatch resumes.
   *
   * In-memory only — a Cloud Run revision rollover clears the map, which
   * means the new instance allows one more dispatch attempt. Acceptable
   * trade-off: rollover is rare and one extra dispatch ≈ $1.20.
   */
  private dispatchSkipUntilStateChange: Map<string, string> = new Map();
  /**
   * Per-issue snapshot of the last `state` the reconciler observed. The
   * reconciler compares this against the `fresh.state` it just fetched
   * from Linear; an unauthorized transition to/from a human-review
   * state (RFC, Code Review, Human Review) gets reverted with a
   * Linear comment. Cleared on dispatch / worker exit so a new
   * dispatch starts with a fresh baseline.
   *
   * Closes the gate-bypass observed on AGENT-447 (2026-04-29) where
   * the agent moved Plan → Implement itself, skipping the configured
   * RFC review gate.
   */
  // A-17 / S-D14: lastSeenState is a write-through Map backed by
  // `symphony.review_gate_state`. Constructed in the constructor; loaded
  // from DB in `start()` so cross-restart state survives Cloud Run revision
  // rollovers (closes the ~30s post-boot window where the reconciler had
  // no `prev` to compare against).
  private readonly reviewGateStore: ReviewGateStore;
  private lastSeenState: WriteThroughLastSeenMap;
  /**
   * A-18: per-issue revert-timestamp tracker. The reconciler pushes a
   * timestamp every time it reverts an unauthorized review-gate move; if
   * an issue accumulates >3 entries within the last hour, the reconciler
   * escalates to `tracker.errorStates[0]` instead of reverting again.
   * Cleared per-issue on dispatch (matches lastSeenState's lifecycle) so
   * a re-dispatched issue starts with a fresh budget.
   */
  private recentRevertTimestamps: Map<string, number[]> = new Map();
  /**
   * Per-issue snapshot of the last state observed in `tick()` across ALL
   * polled candidates (not just running ones — see `lastSeenState` for
   * that). Used to detect parent state changes that fire cascade flows
   * (§8 / E-9, E-13, E-16): when an issue transitions into a cascade
   * trigger state (currently `Development` for the development cascade)
   * we fire the cascade once per transition.
   *
   * Idempotency: re-firing on the same state change must not double-cascade.
   * The cascade module's functions are idempotent on the Linear side
   * (transitionIssueToState skips children already in the target state),
   * but we still gate at the orchestrator level via `prev !== next` so we
   * don't post a redundant parent comment on every tick.
   *
   * In-memory only — a Cloud Run revision rollover clears the map. The
   * cost of an extra cascade post-rollover is one duplicate parent comment;
   * no Linear state inconsistency results because the cascade itself is
   * idempotent. We accept this trade-off rather than pay the Postgres
   * round-trip on every tick.
   */
  private cascadeTriggerLastState: Map<string, string> = new Map();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.reviewGateStore = new ReviewGateStore(deps.pool);
    this.lastSeenState = new WriteThroughLastSeenMap(this.reviewGateStore);
    const snapshot = deps.watcher.snapshot();
    this.currentConfig = snapshot.config;
    this.currentTemplate = snapshot.raw.promptTemplate;
    this.state = createState(
      snapshot.config.polling.intervalMs,
      snapshot.config.agent.maxConcurrentAgents,
    );
  }

  async start(): Promise<void> {
    this.unsubscribeReload = this.deps.watcher.onChange((s) => this.applyReload(s));
    // A-17: restore lastSeenState from `symphony.review_gate_state` so the
    // first reconciler tick after a Cloud Run rollover has a real `prev`
    // to compare against. Best-effort: load failures fall back to an empty
    // map and the reconciler rebuilds it on subsequent ticks.
    const restored = await this.reviewGateStore.loadAll();
    for (const [issueId, state] of restored) {
      // Use raw super.set so we don't echo the load back into a DB write.
      Map.prototype.set.call(this.lastSeenState, issueId, state);
    }
    await this.startupCleanup();
    void this.tick();
    this.scheduleNextErrorRetryTick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    cancelTimer(this.nextTickTimer);
    cancelTimer(this.errorRetryTimer);
    if (this.unsubscribeReload) this.unsubscribeReload();
    for (const entry of this.state.running.values()) {
      await entry.abort().catch(() => undefined);
    }
    for (const r of this.state.retryAttempts.values()) {
      cancelTimer(r.timerHandle);
    }
  }

  /**
   * Graceful shutdown — used by Cloud Run rollouts. Stops accepting new
   * dispatches (so the new revision can pick up fresh work via tracker
   * polling) but lets in-flight turns drain. Cancels the polling timer
   * and retry queue, then awaits running workers up to `drainTimeoutMs`.
   * After the timeout, hard-aborts the rest so the process can exit.
   *
   * Cloud Run gives us up to `terminationGracePeriodSeconds` (configured
   * to 600s in infra) before SIGKILL — pass a value <= that.
   */
  async gracefulStop(drainTimeoutMs: number): Promise<{
    drained: number;
    aborted: number;
  }> {
    this.stopped = true;
    cancelTimer(this.nextTickTimer);
    cancelTimer(this.errorRetryTimer);
    if (this.unsubscribeReload) this.unsubscribeReload();
    for (const r of this.state.retryAttempts.values()) {
      cancelTimer(r.timerHandle);
    }
    const startMs = Date.now();
    const initiallyRunning = this.state.running.size;
    const initiallyTracked = this.workerPromises.size;
    logger.info(
      { running: initiallyRunning, tracked: initiallyTracked, drainTimeoutMs },
      "gracefulStop: draining in-flight turns",
    );

    // Wait for ALL tracked worker promises (not just `state.running`):
    // `runWorker`'s `finally` block deletes from `state.running` BEFORE it
    // performs audit/Linear/slack writes. If we drain on `state.running`
    // alone, the finally-block I/O races against `process.exit(0)` and
    // audit rows + outcome comments silently disappear. The set is
    // self-cleaning (each worker removes itself on settle), so polling
    // `workerPromises.size` mirrors the invariant we actually want:
    // "all post-turn writes have flushed".
    const allDone = (): boolean => this.state.running.size === 0 && this.workerPromises.size === 0;
    while (!allDone() && Date.now() - startMs < drainTimeoutMs) {
      await wait(500);
    }
    const remainingRunning = this.state.running.size;
    const remainingTracked = this.workerPromises.size;
    if (remainingRunning > 0 || remainingTracked > 0) {
      logger.warn(
        { running: remainingRunning, tracked: remainingTracked },
        "gracefulStop: drain timeout — aborting remaining turns",
      );
      for (const entry of this.state.running.values()) {
        await entry.abort().catch(() => undefined);
      }
      // Last-ditch wait so any abort-driven finally blocks (audit row with
      // outcome=Cancelled) get a few seconds to flush before exit.
      const lastDitchDeadlineMs = Math.min(5_000, drainTimeoutMs);
      const dlMs = Date.now() + lastDitchDeadlineMs;
      while (this.workerPromises.size > 0 && Date.now() < dlMs) {
        await wait(250);
      }
    } else {
      logger.info(
        { drained: initiallyTracked, durationMs: Date.now() - startMs },
        "gracefulStop: all turns drained cleanly",
      );
    }
    return {
      drained: initiallyTracked - this.workerPromises.size,
      aborted: this.workerPromises.size,
    };
  }

  /**
   * Structured snapshot consumed by the `/status` HTTP route. Synchronous
   * (no awaits) so the handler can serialize in a single tick. The
   * `instance_id` field is added by the HTTP handler from the singleton
   * lock, since the orchestrator doesn't carry it.
   */
  snapshot(): OrchestratorSnapshot {
    const nowMono = nowMonotonicMs();
    const running = Array.from(this.state.running.values()).map((entry) => ({
      identifier: entry.issue.identifier,
      state: entry.issue.state,
      started_at: new Date(entry.attempt.startedAt).toISOString(),
      duration_seconds: Math.max(0, Math.round((nowMono - entry.startedAtMonotonicMs) / 1000)),
    }));
    const retrying = Array.from(this.state.retryAttempts.values()).map((r) => ({
      identifier: r.identifier,
      attempt: r.attempt,
      next_due_in_seconds: Math.max(0, Math.round((r.dueAtMs - nowMono) / 1000)),
      kind: r.kind,
    }));
    return {
      running,
      retrying,
      totals_since_start: {
        input_tokens: this.state.totals.inputTokens,
        output_tokens: this.state.totals.outputTokens,
        total_tokens: this.state.totals.totalTokens,
        cost_usd: Math.round((this.state.totals.costUsd ?? 0) * 10000) / 10000,
        seconds_running: Math.round(this.state.totals.secondsRunning),
      },
      config: {
        active_states: this.currentConfig.tracker.activeStates.slice(),
        terminal_states: this.currentConfig.tracker.terminalStates.slice(),
        max_concurrent_agents: this.currentConfig.agent.maxConcurrentAgents,
        model: this.currentConfig.agentRuntime.model ?? null,
      },
    };
  }

  /* ------------------------- reload ------------------------- */

  private applyReload(snapshot: WorkflowSnapshot): void {
    this.currentConfig = snapshot.config;
    this.currentTemplate = snapshot.raw.promptTemplate;
    this.state.pollIntervalMs = snapshot.config.polling.intervalMs;
    this.state.maxConcurrentAgents = snapshot.config.agent.maxConcurrentAgents;
    // A-13 / S-D11: drop any cached Linear team-states so the next
    // transitionIssueToState call picks up freshly-added states without a
    // daemon restart. Cheap (no I/O) and prevents `linear_state_not_found`
    // errors after an operator edits WORKFLOW.md to add a new state.
    this.deps.tracker.invalidateTeamStatesCache();
    logger.info(
      {
        pollIntervalMs: this.state.pollIntervalMs,
        max: this.state.maxConcurrentAgents,
      },
      "orchestrator applied reloaded config",
    );
  }

  /* ------------------------- startup ------------------------ */

  private async startupCleanup(): Promise<void> {
    try {
      const terminal = await this.deps.tracker.fetchIssuesByStates(
        this.currentConfig.tracker.terminalStates,
      );
      await cleanupTerminalIssues({
        workspaceRoot: this.currentConfig.workspace.root,
        issues: terminal,
        beforeRemoveScript: this.currentConfig.hooks.beforeRemove,
        hookTimeoutMs: this.currentConfig.hooks.timeoutMs,
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "startup terminal cleanup failed; continuing startup",
      );
    }
  }

  /* ------------------------- release-protected predicate ----- */

  /**
   * 2026-05-07 release-cancellation conflict fix (Option B).
   *
   * Returns true when the orchestrator should NOT cancel the issue's
   * running worker even though Linear reports the issue is now in a
   * terminal state. The narrow case this protects: the Release specialist
   * has just successfully merged its PR (`gh pr merge --squash`) and
   * Linear's native GitHub integration auto-transitioned the issue to
   * Done before the worker could write its `## Release report` and
   * audit row. Without this guard, the very next reconciler tick sees
   * Done and cancels the worker via `onTerminal({cleanup:true})`,
   * clobbering the audit cost capture and the auto-advance handoff.
   *
   * Heuristic: protect ANY worker whose CURRENT in-memory issue state
   * is one of the specialist-owned active states that immediately
   * precede Done in `state_transitions` AND has a registered specialist.
   * In practice this is just "Release". We don't bind to a hard-coded
   * "Release" name because state names are operator-configurable in
   * WORKFLOW.md; instead we compute the set dynamically:
   *
   *   1. Find every state X where `state_transitions[X]` is in
   *      `terminal_states` (Done/Canceled/Duplicate).
   *   2. Of those, keep the ones that are also in `active_states`
   *      (i.e. specialist-owned, not human-owned).
   *
   * For the current 16-state pipeline this resolves to {"Release"}.
   *
   * The protection lasts ONE reconciler tick — by the next tick the
   * worker has finished, the audit row is written, the in-memory
   * `state.running` entry is removed, and the reconciler doesn't even
   * see the issue. If the worker hangs past `codex.stallTimeoutMs`,
   * `reconcileStalledRuns` still cancels it (different code path,
   * unaffected by this hook).
   *
   * Best-effort and synchronous (no DB lookup) — a misconfigured
   * `state_transitions` map or a state name that doesn't match the
   * running worker's state simply means we fall through to
   * status-quo cancellation behavior.
   */
  private isProtectedTerminalIssue(issueId: string): boolean {
    const entry = this.state.running.get(issueId);
    if (!entry) return false;
    const cfg = this.currentConfig.tracker;
    const terminalLower = cfg.terminalStates.map((s) => s.toLowerCase());
    const activeLower = cfg.activeStates.map((s) => s.toLowerCase());
    const workerStateLower = entry.issue.state.toLowerCase();
    // The worker's current Linear state must be active AND its forward
    // edge in `state_transitions` must point at a terminal state — that's
    // the "specialist that hands off to Done" pattern (Release).
    if (!activeLower.includes(workerStateLower)) return false;
    for (const [k, v] of Object.entries(cfg.stateTransitions)) {
      if (k.toLowerCase() === workerStateLower) {
        // The schema allows `null` (cascade-only states with no
        // automatic forward edge — e.g. "Subtask drafted", which is
        // moved exclusively by the Development cascade). A null here
        // means there's no terminal hand-off pattern to protect.
        // Surfaced by Copilot review on PR #684.
        if (typeof v !== "string") return false;
        return terminalLower.includes(v.toLowerCase());
      }
    }
    return false;
  }

  /* ------------------------- poll tick ---------------------- */

  private async tick(): Promise<void> {
    if (this.stopped) return;

    try {
      await reconcileStalledRuns({
        state: this.state,
        stallTimeoutMs: this.currentConfig.codex.stallTimeoutMs,
        onStall: ({ issueId }) => this.cancelWorker(issueId, "stalled", true),
      });
      await reconcileTrackerStates({
        state: this.state,
        tracker: this.deps.tracker,
        activeStates: this.currentConfig.tracker.activeStates,
        terminalStates: this.currentConfig.tracker.terminalStates,
        humanReviewStates: this.currentConfig.tracker.humanReviewStates,
        stateTransitions: this.currentConfig.tracker.stateTransitions,
        lastSeenState: this.lastSeenState,
        // A-18: revert-rate-limit telemetry; reconciler escalates to
        // `errorStates[0]` after >3 reverts in 1h to break busy-loop.
        recentRevertTimestampsMs: this.recentRevertTimestamps,
        errorStates: this.currentConfig.tracker.errorStates,
        onTerminal: async ({ issueId, cleanup }) =>
          this.cancelWorker(issueId, "CanceledByReconciliation", cleanup),
        // 2026-05-07 release-cancellation conflict fix: skip terminal
        // cancellation for one tick when the running worker is the
        // Release specialist mid-merge. Linear's native `merge → Done`
        // automation transitions the issue to Done immediately after
        // `gh pr merge --squash`; without this guard the very next
        // reconciler tick cancels the worker before it can write
        // `## Release report` + the audit row's cumulative cost.
        // See `reconcile.ts#isProtectedTerminalIssue` for the full
        // rationale. The predicate consults `state.running` (in-memory)
        // for the worker's current Linear state — a Release specialist
        // is active when the in-memory issue's state is the configured
        // Release-stage active state. Stall reconciler still wins if
        // the worker hangs past stallTimeoutMs.
        isProtectedTerminalIssue: (issueId: string) =>
          this.isProtectedTerminalIssue(issueId),
        // A-16 / S-D13 (Task 2): pass the bot's Linear user id + pool
        // so the reconciler can consult `symphony.issue_state_actor`
        // and skip the revert when a human dragged the ticket. Both
        // are optional — when fetchViewerId() failed at boot the
        // reconciler falls back to the legacy revert behavior.
        botUserId:
          typeof this.deps.tracker.getViewerId === "function"
            ? this.deps.tracker.getViewerId()
            : null,
        pool: this.deps.pool,
      });

      const validation = preflightValidate(this.currentConfig);
      if (validation) {
        logger.error({ reason: validation }, "dispatch preflight validation failed; skipping tick");
        // B-8: rate-limited Slack alert. Without dampening a misconfigured
        // WORKFLOW.md would log this every tick (~5-15s) until manual fix.
        await this.deps.slack.announceRejection({
          kind: "preflight_failed",
          reason: validation,
        });
        this.scheduleNextTick();
        return;
      }

      // B-13: kill-switch gate. When engaged, log + skip dispatch.
      // Reconciliation already ran above, so in-flight workers continue
      // to drain naturally. Operators flip via POST /admin/kill-switch.
      const kill = await readKillSwitch(this.deps.pool);
      if (kill.engaged) {
        logger.warn(
          {
            reason: kill.reason,
            engagedBy: kill.engagedBy,
            engagedAt: kill.engagedAt?.toISOString() ?? null,
          },
          "kill-switch engaged; skipping dispatch this tick",
        );
        // B-8: rate-limited Slack alert. Tick-frequency is ~5-15s so without
        // dampening this would post 12+ times per minute while engaged.
        await this.deps.slack.announceRejection({
          kind: "kill_switch",
          reason: kill.reason ?? "engaged (no reason recorded)",
        });
        this.scheduleNextTick();
        return;
      }

      let issues: Issue[];
      try {
        issues = await this.deps.tracker.fetchCandidateIssues(
          this.currentConfig.tracker.activeStates,
        );
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "candidate fetch failed; skipping tick");
        this.scheduleNextTick();
        return;
      }

      // §8 / E-9, E-13: cascade trigger detection. Run BEFORE dispatch so
      // that a parent landing in `Development` fans its subs out to
      // `To implement (manual)` before any other side effect of this tick.
      // The cascade itself is fire-and-forget at the orchestrator level —
      // it doesn't dispatch a specialist (Development is cascade-only) and
      // doesn't block the dispatch loop on Linear write latency.
      //
      // TODO (P2.6): the Cancel cascade (parent → Canceled) and the
      // Sub-Done watcher (any sub → Done → check if all siblings done →
      // parent → Validation (manual)) require visibility into terminal
      // state transitions, which the active-state poll loop here cannot
      // see. Both belong in the webhook handler that lands as part of the
      // P2.6 (webhook ingest) work. Until then, those cascades can be
      // triggered manually via the future `/admin/cascade` HTTP route OR
      // by an operator dragging the parent through Validation (manual)
      // by hand once all subs are Done.
      this.detectAndFireCascades(issues);

      for (const issue of sortForDispatch(issues)) {
        if (availableSlots(this.state) <= 0) break;
        const elig = isEligible(issue, {
          state: this.state,
          activeStates: this.currentConfig.tracker.activeStates,
          terminalStates: this.currentConfig.tracker.terminalStates,
          perStateLimits: this.currentConfig.agent.maxConcurrentAgentsByState,
        });
        if (!elig.ok) continue;

        // §8 / E-13 cascade-only states: states that are in `active_states`
        // (so the orchestrator visits them on each tick to fire cascade
        // logic via detectAndFireCascades above) but have NO LLM specialist
        // and NO state_transitions edge. Development is the canonical
        // example — it triggers a sub fan-out via runDevelopmentCascade,
        // but no LLM turn should run on the parent. Without this skip the
        // orchestrator falls through to buildSpecialistPrompt → null →
        // legacy WORKFLOW.staging.md envelope → wasted Anthropic spend on
        // a tautological turn that produces nothing the cascade hasn't
        // already done.
        const stateLower = issue.state.toLowerCase();
        const hasSpecialist = findSpecialist(issue.state) !== null;
        const transitionEntry = Object.keys(
          this.currentConfig.tracker.stateTransitions,
        ).find((k) => k.toLowerCase() === stateLower);
        const hasTransition =
          transitionEntry !== undefined &&
          this.currentConfig.tracker.stateTransitions[transitionEntry] !== "" &&
          this.currentConfig.tracker.stateTransitions[transitionEntry] !== null;
        if (!hasSpecialist && !hasTransition) {
          logger.debug(
            { issue: issue.identifier, state: issue.state },
            "skipping dispatch: cascade-only state (no specialist, no auto-advance edge)",
          );
          continue;
        }

        // §8 / E-13 transition-only states: state HAS a state_transitions
        // edge but NO LLM specialist (e.g. "Ready to deploy" auto-advances
        // to "PR validation"). Without this skip, the orchestrator falls
        // through to the legacy WORKFLOW.staging.md envelope and dispatches
        // a no-op LLM turn (~$1/turn), where the agent reads a "NO LLM CALL"
        // instruction in the Liquid template, posts a brief comment, and
        // exits. Fire the auto-advance directly here and skip dispatch
        // entirely — the next tick will pick up the issue in its new
        // (specialist-owned) state.
        if (!hasSpecialist && hasTransition) {
          const nextState = this.lookupNextState(issue.state);
          if (nextState) {
            logger.info(
              { issue: issue.identifier, fromState: issue.state, toState: nextState },
              "transition-only state: firing auto-advance directly without dispatching",
            );
            await this.deps.tracker
              .transitionIssueToState(issue.id, nextState)
              .catch((err) =>
                logger.warn(
                  { err: (err as Error).message, issue: issue.identifier },
                  "transition-only auto-advance failed; will retry on next tick",
                ),
              );
          }
          continue;
        }

        // Bug D fix: skip if the deliverable-gate previously escalated this
        // issue and the human hasn't moved it out of that state yet.
        // Case-insensitive comparison so subtle casing differences between
        // the dispatch path and the candidate-fetch path don't cause stale
        // entries to be silently cleared.
        const skipState = this.dispatchSkipUntilStateChange.get(issue.id);
        // Diagnostic: log every check + the full map size + the issue
        // candidate's id/state — surfaces value mismatches the v1 fix
        // didn't catch.
        logger.debug(
          {
            issue: issue.identifier,
            issueId: issue.id,
            issueState: issue.state,
            skipState: skipState ?? null,
            mapSize: this.dispatchSkipUntilStateChange.size,
          },
          "skip-map check",
        );
        if (skipState !== undefined) {
          if (skipState.toLowerCase() === issue.state.toLowerCase()) {
            logger.warn(
              { issue: issue.identifier, state: issue.state, skipState },
              "dispatch skipped: deliverable-gate previously escalated; awaiting human state change",
            );
            continue;
          }
          logger.warn(
            { issue: issue.identifier, fromState: skipState, toState: issue.state },
            "skip-map: state changed — clearing entry and allowing dispatch",
          );
          this.dispatchSkipUntilStateChange.delete(issue.id);
        }

        // Cost-cap check lives in dispatch() so it gates retries + continuations
        // through the same code path.
        await this.dispatch(issue, null);
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, "tick failed");
    } finally {
      this.scheduleNextTick();
    }
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    cancelTimer(this.nextTickTimer);
    this.nextTickTimer = scheduleTimer(this.state.pollIntervalMs, () => {
      void this.tick();
    });
  }

  /* ------------------------- cascade triggers --------------- */

  /**
   * §8 / E-9, E-13: walk the freshly-fetched candidate set, compare each
   * issue's current state against `cascadeTriggerLastState`, and fire the
   * relevant cascade when a transition matches a trigger. The cascade
   * functions in `cascade.ts` are idempotent on the Linear side; gating
   * here on `prev !== next` prevents redundant parent comments.
   *
   * Currently wired triggers:
   *   - parent → Development → `runDevelopmentCascade`
   *
   * Deferred to webhook implementation (P2.6) — those triggers can't be
   * detected via the active-state poll loop here:
   *   - parent → Canceled → `runCancelCascade`
   *     (Canceled is terminal; never appears in active_states fetch.)
   *   - any sub → Done → `runSubDoneWatcher(parent)`
   *     (Need parent reverse-lookup + visibility into a sub's Done
   *     transition; both come from the webhook payload.)
   *
   * Errors are swallowed per-issue so a single Linear write outage
   * doesn't kill the whole tick.
   */
  private detectAndFireCascades(issues: Issue[]): void {
    for (const issue of issues) {
      const prev = this.cascadeTriggerLastState.get(issue.id);
      const next = issue.state;
      // Update the snapshot first so we never re-fire on the same observed
      // state — even if the cascade itself throws.
      this.cascadeTriggerLastState.set(issue.id, next);

      if (!prev || prev.toLowerCase() === next.toLowerCase()) continue;

      // Development cascade: parent moved into Development from somewhere
      // else (typically Plan review (manual)). Fan out drafted subs.
      if (next.toLowerCase() === "development") {
        const cascadeLogger = withContext({
          issue_id: issue.id,
          issue_identifier: issue.identifier,
        });
        cascadeLogger.info(
          { from: prev, to: next },
          "detected Development transition; firing development cascade",
        );
        // Fire-and-forget — cascade owns its own error handling per-sub.
        void runDevelopmentCascade(
          {
            tracker: this.deps.tracker,
            pool: this.deps.pool,
            logger: cascadeLogger,
          },
          { id: issue.id, identifier: issue.identifier },
        ).catch((err) => {
          cascadeLogger.error(
            { err: (err as Error).message },
            "runDevelopmentCascade threw unexpectedly; cascade may have partially completed",
          );
        });
      }
    }
  }

  /* ----------------------- error auto-retry ----------------- */

  /**
   * Periodic scan over `tracker.errorStates`. For each parked issue:
   *
   *   - Read attempts + last-failure timestamp from `symphony.run_audit`.
   *   - If attempts exceed `tracker.maxErrorRetries`, post a Linear comment
   *     once asking for human review and skip (the `<!-- symphony:event=…
   *     -->` HTML comment in the body de-dupes across ticks).
   *   - Otherwise compute `delay = min(60s * 2^min(8, attempts), 24h)` and
   *     skip if `now - lastFailedAt < delay`.
   *   - When ready, re-derive the previous-active state from the audit
   *     row's `runtime` column (we store the dispatching state there
   *     historically — fall back to the FIRST active state in
   *     `activeStates` if the audit row didn't capture it).
   *   - Move the issue back via `tracker.transitionIssueToState` and let
   *     the regular dispatch loop pick it up on the next poll tick.
   *
   * Best-effort: every step is wrapped so a single failure (Postgres,
   * Linear) doesn't take out the loop. The next tick re-evaluates from
   * scratch.
   *
   * Closes the Error → auto-retry recovery gap that previously required
   * an operator to manually drag tickets out of the Error column.
   */
  async processErrorRetries(): Promise<void> {
    if (this.stopped) return;
    const errorStates = this.currentConfig.tracker.errorStates;
    if (!errorStates || errorStates.length === 0) return;

    let parked: Issue[];
    try {
      parked = await this.deps.tracker.fetchIssuesByStates(errorStates);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, errorStates },
        "processErrorRetries: fetchIssuesByStates failed; skipping tick",
      );
      return;
    }
    if (parked.length === 0) return;

    const maxRetries = this.currentConfig.tracker.maxErrorRetries;
    const targetState = this.pickActiveStateForRetry();
    if (!targetState) {
      logger.warn("processErrorRetries: no active state configured; cannot release parked tickets");
      return;
    }

    for (const issue of parked) {
      if (this.stopped) return;
      // Skip the running / claimed / in-flight cases. Running shouldn't
      // happen (issue is in Error, not active) but defense in depth costs
      // nothing. Claimed covers the "we just released this in the prior
      // tick and the dispatch poll hasn't yet noticed" race.
      if (this.errorRetryInFlight.has(issue.id)) continue;
      if (this.state.running.has(issue.id)) continue;
      if (this.state.claimed.has(issue.id)) continue;

      // Reserve BEFORE the first await so a concurrent invocation of
      // `processErrorRetries()` (e.g. the periodic timer overlapping a
      // reconciler-driven call) can't progress past this gate for the
      // same issue. Cleared in the `finally` after the Linear mutation
      // settles.
      this.errorRetryInFlight.add(issue.id);
      try {
        const attempts = await countAttemptsForIssue(this.deps.pool, issue.id);
        if (attempts > maxRetries) {
          await this.postBudgetExhaustedComment(issue, attempts).catch((err) =>
            logger.warn(
              { err: (err as Error).message, issue: issue.identifier },
              "processErrorRetries: budget-exhausted comment failed",
            ),
          );
          continue;
        }

        const delayMs = computeErrorBackoffMs(attempts);
        const lastFailedAt = await lastFailedAtForIssue(this.deps.pool, issue.id);
        if (lastFailedAt) {
          const elapsedMs = Date.now() - lastFailedAt.getTime();
          if (elapsedMs < delayMs) {
            logger.debug(
              {
                issue: issue.identifier,
                attempts,
                delayMs,
                elapsedMs,
                waitMs: delayMs - elapsedMs,
              },
              "processErrorRetries: still in backoff window; skipping",
            );
            continue;
          }
        }

        try {
          await this.deps.tracker.transitionIssueToState(issue.id, targetState);
          logger.info(
            { issue: issue.identifier, attempts, delayMs, targetState },
            "processErrorRetries: released parked ticket back to active state",
          );
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, issue: issue.identifier, targetState },
            "processErrorRetries: state transition failed; leaving parked",
          );
        }
      } finally {
        this.errorRetryInFlight.delete(issue.id);
      }
    }
  }

  private scheduleNextErrorRetryTick(): void {
    if (this.stopped) return;
    cancelTimer(this.errorRetryTimer);
    const delayMs = this.currentConfig.polling.errorRetryIntervalMs;
    this.errorRetryTimer = scheduleTimer(delayMs, () => {
      void this.processErrorRetries()
        .catch((err) => logger.error({ err: (err as Error).message }, "processErrorRetries threw"))
        .finally(() => this.scheduleNextErrorRetryTick());
    });
  }

  /**
   * Pick the state to move a parked ticket back to. Today we always use
   * the FIRST entry in `tracker.activeStates`, which for cerebro's
   * pipeline is `Refinement` — i.e. "start the issue over from the top".
   *
   * Rationale: by the time a ticket lands in `Error` we usually don't
   * trust the partial work done at whatever stage it failed (cost cap
   * fires mid-Implement leaves an inconsistent half-PR; SDK error
   * mid-Plan leaves a half-RFC). Resetting to the top of the pipeline
   * gives the next agent a clean slate. A future enhancement could read
   * the LAST started state out of `symphony.run_audit` and resume from
   * there, but that's out of scope here.
   */
  private pickActiveStateForRetry(): string | null {
    const states = this.currentConfig.tracker.activeStates;
    return states[0] ?? null;
  }

  private async postBudgetExhaustedComment(issue: Issue, attempts: number): Promise<void> {
    if (!this.currentConfig.tracker.announceOutcome) return;
    const body = `_via **Symphony** (orchestrator-driven)_\n\n⚠️ Symphony — auto-retry budget exhausted (${attempts} attempts); needs human review. Move to a different state to retry once you've fixed the cause.\n\n<!-- symphony:event=auto_retry_exhausted attempts=${attempts} -->`;
    await this.deps.tracker.createComment(issue.id, body);
  }

  /* ------------------------- dispatch ----------------------- */

  private async dispatch(issue: Issue, attempt: number | null): Promise<void> {
    this.state.claimed.add(issue.id);
    const log = withContext({ issue_id: issue.id, issue_identifier: issue.identifier, attempt });
    log.info({ state: issue.state }, "dispatching");

    // Cost-cap is enforced here (the central choke-point) so retries and
    // continuations are gated too — not just first-time dispatches from tick().
    const cap = await checkCaps(this.deps.pool, this.currentConfig.guardrails, issue.id);
    if (!cap.allowed) {
      log.warn({ reason: cap.reason }, "dispatch rejected: cost cap exceeded");
      // B-8: rate-limited Slack alert (per-reason 5-min dampening) so a
      // burst of identical cap rejections collapses to one channel post.
      await this.deps.slack.announceRejection({
        kind: "cost_cap",
        reason: cap.reason ?? "unknown",
        issueIdentifier: issue.identifier,
      });
      this.state.claimed.delete(issue.id);
      return;
    }

    try {
      const ws = await ensureWorkspace({
        workspaceRoot: this.currentConfig.workspace.root,
        identifier: issue.identifier,
        // Disk-pressure safeguard. ensureWorkspace runs an emergency GC
        // if free space on the workspace filesystem drops below the
        // safeguard threshold, dropping every workspace not in
        // running/claimed before allocating the new one.
        diskPressure: {
          runningKeys: this.activeWorkspaceKeys(),
          claimedKeys: this.claimedWorkspaceKeys(),
          beforeRemoveScript: this.currentConfig.hooks.beforeRemove,
          hookTimeoutMs: this.currentConfig.hooks.timeoutMs,
        },
      });
      // Mint a GitHub App installation token once per dispatch attempt and
      // pass it through to both hooks. Returns null when GH App env vars
      // are absent — hooks then run without GITHUB_TOKEN, which is the
      // expected behavior for placeholder / local-dev environments.
      const githubToken = await getInstallationToken();
      const hookExtraEnv: Record<string, string | undefined> = githubToken
        ? { GITHUB_TOKEN: githubToken }
        : {};
      if (ws.createdNow) {
        const r = await runHook({
          kind: "after_create",
          script: this.currentConfig.hooks.afterCreate,
          cwd: ws.path,
          timeoutMs: this.currentConfig.hooks.timeoutMs,
          extraEnv: hookExtraEnv,
        });
        if (r.ran && !r.ok) {
          throw new Error("after_create hook failed");
        }
      }

      // before_run hook (per attempt).
      const before = await runHook({
        kind: "before_run",
        script: this.currentConfig.hooks.beforeRun,
        cwd: ws.path,
        timeoutMs: this.currentConfig.hooks.timeoutMs,
        extraEnv: hookExtraEnv,
      });
      if (before.ran && !before.ok) {
        throw new Error("before_run hook failed");
      }

      // Spec §9.5 invariant 1 (agent runs in per-issue workspace) is enforced
      // inside the AgentRunner adapter, which receives `cwd: workspacePath`
      // when launching the subprocess. The orchestrator process does not chdir.

      // Spawn worker — runs in the background, schedules its own retries.
      // If runWorker rejects before registering the issue in `state.running`
      // (e.g. startSession fails), `claimed` would otherwise leak forever and
      // the issue would never be re-dispatched. Catch here and reschedule.
      // We also track the wrapped promise so `gracefulStop()` can await
      // post-finally I/O (audit row, Linear outcome comment, slack) — those
      // run AFTER `state.running.delete()` and would otherwise be cut off
      // by `process.exit(0)` during a Cloud Run rollout.
      const workerPromise = this.runWorker(issue, attempt, ws.path).catch((err) => {
        log.error({ err: (err as Error).message }, "worker promise threw");
        if (!this.state.running.has(issue.id) && !this.state.retryAttempts.has(issue.id)) {
          this.scheduleRetry(
            issue.id,
            issue.identifier,
            (attempt ?? 0) + 1,
            (err as Error).message,
            "retry",
          );
        }
      });
      this.workerPromises.add(workerPromise);
      void workerPromise.finally(() => this.workerPromises.delete(workerPromise));

      await this.deps.slack.announceDispatch(issue, attempt);
      // Orchestrator-driven Linear comment so the board reflects what symphony
      // is doing, regardless of whether the agent itself reaches for the
      // Linear MCP. Cerebro has the same pattern — write-side reliability
      // is the orchestrator's job, not the agent's. Best-effort, never
      // throws into the dispatch path.
      if (this.currentConfig.tracker.announceDispatch) {
        const model = this.currentConfig.agentRuntime.model ?? "(SDK default)";
        const attemptStr = attempt && attempt > 0 ? ` · attempt ${attempt}` : "";
        const maxTurns = this.currentConfig.agent.maxTurns;
        // Body is authored by the user whose Linear API key we're using, so
        // a leading "via Symphony" line keeps attribution clear when the
        // human reading the board scans for symphony context.
        const body = `_via **Symphony** (orchestrator-driven)_\n\n🤖 **Symphony — ${issue.state} turn started**${attemptStr}\n\n- Model: \`${model}\`\n- Workspace: \`${ws.path}\`\n- Max turns this run: ${maxTurns}\n\n_Working in the background. I'll comment again when the turn lands or fails._\n\n<!-- symphony:event=dispatch_started state=${issue.state} -->`;
        await this.deps.tracker
          .createComment(issue.id, body)
          .catch((err) =>
            logger.warn(
              { err: (err as Error).message, issue: issue.identifier },
              "linear announceDispatch comment failed",
            ),
          );
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, "dispatch failed");
      this.scheduleRetry(issue.id, issue.identifier, (attempt ?? 0) + 1, (err as Error).message);
    }
  }

  /* ------------------------- worker ------------------------- */

  private async runWorker(
    issue: Issue,
    attempt: number | null,
    workspacePath: string,
  ): Promise<void> {
    const startedAtUtc = new Date();
    const startedAtMonotonic = nowMonotonicMs();
    // Per-worker AbortController. Reconciliation calls entry.abort() and the
    // adapter's runTurn observes the signal — that's how we actually stop
    // an in-flight turn (vs. the previous endSession-only no-op).
    const workerAc = new AbortController();
    const session = await this.deps.runner.startSession({
      workspacePath,
      issue,
      signal: workerAc.signal,
      logContext: { issue_id: issue.id, issue_identifier: issue.identifier },
    });
    attachWorkspace(session, workspacePath);

    const entry: RunningEntry = {
      issue,
      attempt: {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        attempt,
        workspacePath,
        startedAt: startedAtUtc.getTime(),
        status: "StreamingTurn",
        error: null,
      },
      session: null,
      startedAtMonotonicMs: startedAtMonotonic,
      lastEventMonotonicMs: startedAtMonotonic,
      abort: async () => {
        workerAc.abort();
        await this.deps.runner.endSession(session).catch(() => undefined);
      },
    };
    this.state.running.set(issue.id, entry);
    // Seed the review-gate baseline so the reconciler has a `prev` to
    // compare against on its very first tick after dispatch.
    this.lastSeenState.set(issue.id, issue.state);

    // Task 2 (2026-05-06): record this worker in `running_runs` so the
    // orphan reaper on the NEXT boot can write a synthetic `Killed`
    // audit row if the container dies before the audit-write `finally`
    // block below runs (OOM, SIGKILL during scale-down, etc.). Skipped
    // when `instanceId` is unset (test / standalone runs).
    if (this.deps.instanceId) {
      await recordRunStart(this.deps.pool, {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        instanceId: this.deps.instanceId,
        attempt: attempt ?? null,
        sessionId: session.sessionId,
      });
    }

    // Definite-assignment assertion: every code path through the try/catch
    // below assigns lastOutcome before it's read in the finally block.
    let lastOutcome!: "completed" | "failed" | "cancelled" | "timeout" | "stalled";
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    // B-3 / D-21 (AGENT-529): per-run prompt-cache accumulators. Both start
    // at 0 and grow as runTurn results accumulate. Forwarded to the audit
    // row + Slack succeeded card; cache hit-rate computed at outcome time.
    let totalCacheCreationInputTokens = 0;
    let totalCacheReadInputTokens = 0;
    let lastError: string | null = null;
    let turnIndex = 0;

    try {
      // Pull prior Linear comments so each stage's agent has the previous
      // stage's deliverables in-context (Refinement → Requirements, Plan
      // → RFC). Without this each new dispatch starts from a clean slate
      // and the agent re-discovers context via expensive Linear MCP
      // calls (or, worse, doesn't find it and produces work duplicating
      // earlier stages). Best-effort: if Linear is down we ship the
      // prompt without history rather than block dispatch.
      //
      // Filter down to the SUBSTANTIVE comments (stage deliverables +
      // free-form human Q/A) — lifecycle telemetry is dropped. By
      // Implement-stage on a busy ticket the unfiltered prompt grew
      // ~quadratically in tokens; observed ~$0.30/turn just on
      // comment-history input on AGENT-447. See
      // `selectSubstantiveComments` in tracker/linear.ts for the
      // canonical filter rules.
      const priorComments = await this.deps.tracker
        .fetchSubstantiveComments(issue.id)
        .catch(() => [] as Array<{ createdAt: string; body: string; author: string }>);

      // First turn: try the 16-state specialist registry first (§8 / E-10..
      // E-15). When the issue's state is owned by a specialist (Prioritized,
      // Technical plan, PR validation, Release), we drive the LLM with the
      // specialist's SYSTEM_PROMPT + buildUserMessage(ctx) instead of the
      // legacy WORKFLOW.staging.md envelope. When no specialist is
      // registered for the state, fall back to buildFullPrompt — adding
      // specialists is purely additive.
      const specialistPrompt = await buildSpecialistPrompt({
        state: issue.state,
        issue,
        attempt,
        comments: priorComments,
        pool: this.deps.pool,
        tracker: this.deps.tracker,
        // Pass the real workspace path through so the prompt's
        // `${ctx.workspacePath}` interpolation reflects the cloned-monorepo
        // root the agent will actually `cd` into. Previously this was
        // hard-coded to "/tmp", which made the prompt instruct agents to
        // run `gh` from a directory the tool guard denied. Surfaced by
        // Copilot review on PR #684.
        workspacePath,
      });
      const firstPrompt =
        specialistPrompt ??
        (await buildFullPrompt({
          template: this.currentTemplate,
          issue,
          attempt,
          comments: priorComments,
        }));
      // A-29 / S-D24: read the issue's already-recorded cumulative cost so
      // the adapter can mid-stream-abort if the per-issue cap would be
      // exceeded. Best-effort: a Postgres failure leaves the cap inactive
      // for this turn (still active at dispatch via checkCaps). The cap
      // applies cumulatively across turns within a single runWorker too —
      // see the continuation loop below.
      const issueBudgetAtStart = await readBudget(this.deps.pool, {
        kind: "issue",
        key: issue.id,
      }).catch(() => 0);
      const firstResult = await this.deps.runner.runTurn(session, {
        prompt: firstPrompt,
        attempt,
        turnTimeoutMs: this.currentConfig.codex.turnTimeoutMs,
        stallTimeoutMs: this.currentConfig.codex.stallTimeoutMs,
        signal: workerAc.signal,
        perIssueCapUsd: this.currentConfig.guardrails.perIssueCapUsd,
        alreadyRecordedCostUsd: issueBudgetAtStart,
        // B-6: per-state cap looked up by lowercased state name. Map is
        // empty by default; only fires when WORKFLOW.md sets
        // `guardrails.per_state_cap_usd`.
        perStateCapUsd:
          this.currentConfig.guardrails.perStateCapUsd[issue.state.toLowerCase()] ?? 0,
        // B-12: per-state write-scope discipline. Map is empty by default;
        // only fires when WORKFLOW.md sets `agent.write_cwds_by_state`.
        // `undefined` ⇒ adapter falls back to the default workspace-wide
        // write rule. An explicit `[]` blocks all file writes.
        writeCwds: this.currentConfig.agent.writeCwdsByState[issue.state.toLowerCase()],
      });
      lastOutcome = firstResult.outcome;
      totalCost += firstResult.usageDelta.costUsd;
      totalInputTokens += firstResult.usageDelta.inputTokens;
      totalOutputTokens += firstResult.usageDelta.outputTokens;
      // B-3 / D-21 (AGENT-529): accumulate prompt-cache token subsets so
      // the audit row and Slack succeeded card can show hit-rate. See
      // RunTurnResult.usageDelta JSDoc for semantics.
      totalCacheCreationInputTokens += firstResult.usageDelta.cacheCreationInputTokens;
      totalCacheReadInputTokens += firstResult.usageDelta.cacheReadInputTokens;
      entry.lastEventMonotonicMs = nowMonotonicMs();
      lastError =
        firstResult.outcome === "completed" ? null : (firstResult.finalEvent.message ?? null);

      // Continuation turns while issue is still active.
      //
      // After every successful turn we (a) refresh live state and (b) try
      // to auto-advance per `state_transitions` BEFORE deciding to loop
      // again. Without the in-loop advance, a stage's deliverable
      // completes on turn 1 but the worker keeps spinning the SDK until
      // `maxTurns` (20) — the agent posts "no-op convergence" comments
      // and burns ~$0.5 each. Observed on AGENT-441 (16 wasted Refinement
      // turns, $7 burned) and AGENT-444 (6 wasted turns).
      //
      // We also break the continuation if the live state drifted from
      // the dispatch state (whether by us auto-advancing OR by the agent
      // calling `update_issue` itself OR by a human moving the ticket).
      // A new dispatch picks up the issue in the new state with the
      // correct stage prompt; reusing the SDK session under the wrong
      // prompt would produce nonsense.
      const dispatchState = issue.state;
      while (
        lastOutcome === "completed" &&
        turnIndex + 1 < this.currentConfig.agent.maxTurns &&
        !this.stopped &&
        this.state.running.has(issue.id)
      ) {
        // Fire auto-advance based on the LATEST successful turn.
        await this.tryAutoAdvanceMidWorker(issue, dispatchState);

        turnIndex++;
        const refreshed = await this.deps.tracker
          .fetchIssueStatesByIds([issue.id])
          .catch(() => [] as Issue[]);
        const fresh = refreshed[0];
        if (!fresh) break;
        const stateLower = fresh.state.toLowerCase();
        const stillActive = this.currentConfig.tracker.activeStates
          .map((s) => s.toLowerCase())
          .includes(stateLower);
        if (!stillActive) break;
        // Live state diverged from the dispatch-time state — exit so a
        // new dispatch can pick up with the right stage prompt.
        if (fresh.state.toLowerCase() !== dispatchState.toLowerCase()) {
          logger.info(
            {
              issueId: issue.id,
              identifier: issue.identifier,
              dispatchState,
              currentState: fresh.state,
            },
            "continuation: state diverged from dispatch; exiting worker for re-dispatch",
          );
          break;
        }

        const guidance = buildContinuationGuidance(fresh, turnIndex);
        const turnRes = await this.deps.runner.runTurn(session, {
          prompt: guidance,
          attempt,
          turnTimeoutMs: this.currentConfig.codex.turnTimeoutMs,
          stallTimeoutMs: this.currentConfig.codex.stallTimeoutMs,
          signal: workerAc.signal,
          perIssueCapUsd: this.currentConfig.guardrails.perIssueCapUsd,
          // A-29: cumulative budget = DB value at run start + cost
          // accumulated across this run's prior turns. The DB hasn't been
          // updated yet (recordCost runs in the finally block); we track
          // intra-run cost via `totalCost`.
          alreadyRecordedCostUsd: issueBudgetAtStart + totalCost,
          // B-6: per-state cap based on the LIVE state — handles the case
          // where the agent or orchestrator advanced the state mid-run
          // and continuation turns are running under a different cap.
          perStateCapUsd:
            this.currentConfig.guardrails.perStateCapUsd[fresh.state.toLowerCase()] ?? 0,
          // B-12: per-state write-scope based on LIVE state (mid-run state
          // advances re-pin the write allowlist for continuation turns).
          writeCwds: this.currentConfig.agent.writeCwdsByState[fresh.state.toLowerCase()],
        });
        lastOutcome = turnRes.outcome;
        totalCost += turnRes.usageDelta.costUsd;
        totalInputTokens += turnRes.usageDelta.inputTokens;
        totalOutputTokens += turnRes.usageDelta.outputTokens;
        totalCacheCreationInputTokens += turnRes.usageDelta.cacheCreationInputTokens;
        totalCacheReadInputTokens += turnRes.usageDelta.cacheReadInputTokens;
        entry.lastEventMonotonicMs = nowMonotonicMs();
        lastError = turnRes.outcome === "completed" ? null : (turnRes.finalEvent.message ?? null);
      }
    } catch (err) {
      lastOutcome = "failed";
      lastError = (err as Error).message;
    } finally {
      // CRITICAL: state.running.delete() MUST run unconditionally. Earlier
      // versions placed it after best-effort I/O (audit/cost/slack) which
      // could throw and strand the issue in `running` until a stall reconcile.
      this.state.running.delete(issue.id);
      this.lastSeenState.delete(issue.id);
      this.recentRevertTimestamps.delete(issue.id);

      // Task 2 (2026-05-06): clear the running_runs row paired with the
      // recordRunStart call above. We do this UNCONDITIONALLY in the
      // finally block — same critical-path invariant as state.running —
      // so the orphan reaper on the next boot doesn't false-positive
      // synthetic Killed rows for runs that completed normally.
      if (this.deps.instanceId) {
        await recordRunEnd(this.deps.pool, {
          issueId: issue.id,
          instanceId: this.deps.instanceId,
        });
      }

      // Best-effort outbound steps — wrap each so a single failure doesn't
      // skip the rest or block retry scheduling.
      await this.deps.runner.endSession(session).catch(() => undefined);
      await runHook({
        kind: "after_run",
        script: this.currentConfig.hooks.afterRun,
        cwd: workspacePath,
        timeoutMs: this.currentConfig.hooks.timeoutMs,
      }).catch((err) =>
        logger.warn({ err: (err as Error).message }, "after_run hook threw unexpectedly"),
      );

      const finishedAtUtc = new Date();
      const totalTokens = totalInputTokens + totalOutputTokens;
      const outcomeLabel = mapOutcome(lastOutcome);

      this.state.totals.inputTokens += totalInputTokens;
      this.state.totals.outputTokens += totalOutputTokens;
      this.state.totals.totalTokens += totalTokens;
      this.state.totals.secondsRunning += (finishedAtUtc.getTime() - startedAtUtc.getTime()) / 1000;
      this.state.totals.costUsd += totalCost;

      await recordCost(this.deps.pool, issue.id, totalCost).catch((err) =>
        logger.warn({ err: (err as Error).message }, "recordCost failed; continuing"),
      );
      await writeRunAudit(this.deps.pool, {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        attempt,
        sessionId: session.sessionId,
        startedAt: startedAtUtc,
        finishedAt: finishedAtUtc,
        outcome: outcomeLabel,
        runtime: this.deps.runner.kind,
        model: this.currentConfig.agentRuntime.model ?? null,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens,
        costUsd: totalCost,
        error: lastError,
        // B-2: capture prompt provenance. Until TL-2 (prompts-in-code)
        // ships per-stage prompt modules, the build SHA is the closest
        // proxy — every WORKFLOW.md change is captured by a redeploy
        // and a new git SHA. Once prompt.ts modules exist, replace with
        // the per-stage content hash.
        promptVersion: readGitSha(),
        // B-3 / D-21 (AGENT-529): persist cache-fee subsets so the
        // post-hoc cache hit-rate is queryable from `symphony.run_audit`.
        cacheCreationInputTokens: totalCacheCreationInputTokens,
        cacheReadInputTokens: totalCacheReadInputTokens,
      }).catch((err) =>
        logger.warn({ err: (err as Error).message }, "writeRunAudit threw unexpectedly"),
      );

      // §8 / E-6 — bump per-issue specialist counters for the 16-state
      // pipeline. When the dispatch was on a state owned by a specialist
      // (Prioritized, Technical plan, PR validation, Release), record the
      // run in symphony.issue_metadata so re-run paths can see the count
      // (validation_iteration / plan_iteration / pr_validation_iteration)
      // and the PR validation cap-check has a counter to read.
      //
      // Skipped when no specialist matches the dispatch state — Development
      // and Ready to deploy are cascade/transition-only and don't bump
      // a counter; non-specialist (8-state) deployments don't touch this
      // table at all.
      const specialist = findSpecialist(issue.state);
      if (specialist) {
        const iterationKey =
          specialist.name === "prioritized"
            ? ("validation" as const)
            : specialist.name === "technical-plan"
              ? ("plan" as const)
              : specialist.name === "pr-validation"
                ? ("pr_validation" as const)
                : null; // release: cumulative cost only, no counter
        await recordSpecialistRun(this.deps.pool, {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          specialist: specialist.name,
          costUsdDelta: totalCost,
          iterationKey,
        }).catch((err) =>
          logger.warn(
            { err: (err as Error).message, identifier: issue.identifier },
            "recordSpecialistRun threw unexpectedly",
          ),
        );
      }
      await this.deps.slack
        .announceOutcome(issue, outcomeLabel, {
          tokens: totalTokens,
          costUsd: totalCost,
          error: lastError ?? undefined,
          // B-3 / D-21 (AGENT-529): surface cache-fee subsets so the Slack
          // succeeded card shows hit-rate alongside cost. The observer
          // computes the displayed percentage; we just hand off the raw
          // counters so the formatting logic lives in one place.
          cacheCreationInputTokens: totalCacheCreationInputTokens,
          cacheReadInputTokens: totalCacheReadInputTokens,
          inputTokens: totalInputTokens,
        })
        .catch((err) =>
          logger.warn({ err: (err as Error).message }, "slack announceOutcome threw"),
        );

      // Orchestrator-driven Linear outcome comment. We always announce the
      // outcome (Succeeded / Failed / Stalled / Timeout) so the board has a
      // paper trail. Cancelled runs (reconciler-driven) skip this — the
      // human moved the issue out of active state for a reason.
      if (
        this.currentConfig.tracker.announceOutcome &&
        outcomeLabel !== "CanceledByReconciliation"
      ) {
        const emoji = outcomeForEmoji(outcomeLabel);
        const errBlock = lastError ? `\n\n> _Last error_: \`${lastError.slice(0, 200)}\`` : "";
        const costStr = totalCost > 0 ? `$${totalCost.toFixed(4)}` : "$0";
        const nextStateForOutcome =
          outcomeLabel === "Succeeded" ? this.lookupNextState(issue.state) : null;
        const transitionLine = nextStateForOutcome
          ? `\n- Next state: **${nextStateForOutcome}** (auto-advanced)`
          : "";
        const body = `_via **Symphony** (orchestrator-driven)_\n\n${emoji} **Symphony — ${issue.state} turn ${outcomeLabel.toLowerCase()}**\n\n- Cost: ${costStr}\n- Tokens: ${totalTokens.toLocaleString()} (in ${totalInputTokens.toLocaleString()} / out ${totalOutputTokens.toLocaleString()})\n- Wall: ${Math.round((finishedAtUtc.getTime() - startedAtUtc.getTime()) / 1000)}s\n- Turns: ${turnIndex + 1}${transitionLine}${errBlock}\n\n<!-- symphony:event=turn_${outcomeLabel.toLowerCase()} state=${issue.state} -->`;
        await this.deps.tracker
          .createComment(issue.id, body)
          .catch((err) =>
            logger.warn(
              { err: (err as Error).message, issue: issue.identifier },
              "linear announceOutcome comment failed",
            ),
          );
      }

      // Auto-advance Linear state on Succeeded outcome per WORKFLOW.md
      // tracker.state_transitions map. Skip on Failed/Stalled/Timeout
      // (operator decides), and skip when no mapping is configured for
      // the current state (human-review states like RFC / Code Review).
      //
      // Re-check the LIVE Linear state right before auto-advancing — the
      // dispatch-time `issue.state` is stale (this turn ran for many
      // minutes; a human or another agent may have moved the ticket).
      // Without this re-check, our auto-advance can stomp a manual move
      // and send the issue to the wrong next state. Surfaced by
      // CodeRabbit on PR #502.
      if (outcomeLabel === "Succeeded") {
        const dispatchState = issue.state;
        let liveState = dispatchState;
        try {
          const refreshed = await this.deps.tracker.fetchIssueStatesByIds([issue.id]);
          if (refreshed[0]?.state) liveState = refreshed[0].state;
        } catch (err) {
          logger.warn(
            {
              err: (err as Error).message,
              issue: issue.identifier,
            },
            "auto-advance live-state refresh failed; falling back to dispatch-time state",
          );
        }
        if (liveState !== dispatchState) {
          logger.info(
            {
              issue: issue.identifier,
              dispatchState,
              liveState,
            },
            "live state diverged from dispatch state; skipping auto-advance to respect manual move",
          );
        } else {
          // §8 / E-15, E-16 nextStateOverride wiring. After the agent's turn
          // we fetch the FRESH description and look for a Decision line in
          // its specialist-owned report section (parseDecisionOverride scans
          // `## PR validation report`, `## Release report`, `## Error`).
          // When the agent emitted `Bouncing to Pull request.` or
          // `Escalating to Error (manual).`, we use that as the explicit
          // routing override instead of the default state_transitions edge.
          //
          // The agent CANNOT call `update_issue` to move state itself —
          // the reconciler reverts unauthorized agent moves. The Decision
          // line is the authorized handoff: agent writes intent into the
          // description, orchestrator does the state transition.
          let nextStateOverride: string | null = null;
          try {
            const freshDescription = await this.deps.tracker.fetchIssueDescriptionById(issue.id);
            if (freshDescription) {
              nextStateOverride = parseDecisionOverride(freshDescription);
            }
          } catch (err) {
            logger.warn(
              {
                err: (err as Error).message,
                issue: issue.identifier,
              },
              "auto-advance: parseDecisionOverride description fetch failed; falling back to default state_transitions",
            );
          }

          const defaultNextState = this.lookupNextState(liveState);

          // Merge-verify guard for Release → Done. The Release specialist's
          // `gh pr merge` command can fail silently (red CI on PR head;
          // transient GitHub 5xx; agent timed out before merge) while the
          // LLM turn still returns `outcome=Succeeded` because the agent
          // posted a comment + exited cleanly. Without this guard the
          // orchestrator default-advances Release → Done per
          // `state_transitions["Release"]`, marking the sub Done with the
          // PR still open. Real symptom on STG-17 (2026-05-07 cutover).
          //
          // Fire when:
          //   - liveState === "Release", AND
          //   - we're about to advance to "Done" (default OR explicit
          //     `Advancing to Done.` decision line — defense in depth: the
          //     agent can hallucinate the merge succeeded).
          //
          // We DON'T fire when the agent explicitly bounced or escalated
          // (`Bouncing to Pull request.` / `Escalating to Error (manual).`)
          // — that's a deliberate routing override, not a Done advance.
          //
          // Result semantics:
          //   - PR exists + mergedAt non-null → merged → proceed (no override)
          //   - PR exists + mergedAt null     → not merged → bounce to "Pull request"
          //   - PR not found                  → cannot verify → bounce to "Pull request"
          //   - GitHub API failure (undefined)→ transient → fail open (no override)
          let mergeVerifyOverride: string | null = null;
          const aboutToAdvanceToDone =
            liveState === "Release" &&
            (nextStateOverride === null || nextStateOverride === "Done") &&
            defaultNextState === "Done";
          if (aboutToAdvanceToDone) {
            try {
              const token = await getInstallationToken();
              if (token) {
                const prStatus = await fetchPullRequestForIssue(token, issue.identifier, {
                  owner: this.currentConfig.github.owner,
                  repo: this.currentConfig.github.repo,
                });
                if (prStatus === null) {
                  // No PR found via search → cannot verify merge → bounce.
                  mergeVerifyOverride = "Pull request";
                  logger.warn(
                    { issue: issue.identifier },
                    "auto-advance: Release merge-verify failed — no PR found containing Closes <ID>; bouncing to Pull request",
                  );
                  await this.deps.tracker
                    .createComment(
                      issue.id,
                      `🛑 **Symphony — Release → Done auto-advance blocked.**\n\nNo PR found containing \`Closes ${issue.identifier}\` in body. The Release specialist reported success but produced no merge. Routing back to \`Pull request\` so a human or the next Release run can investigate.\n\n<!-- symphony:event=release_merge_verify_failed reason=no_pr_found -->`,
                    )
                    .catch((err) =>
                      logger.warn(
                        { err: (err as Error).message, issue: issue.identifier },
                        "release-merge-verify bounce comment failed",
                      ),
                    );
                } else if (prStatus !== undefined && prStatus.mergedAt === null) {
                  // PR exists but is open or closed-without-merge → bounce.
                  mergeVerifyOverride = "Pull request";
                  logger.warn(
                    {
                      issue: issue.identifier,
                      prNumber: prStatus.number,
                      prState: prStatus.state,
                    },
                    "auto-advance: Release merge-verify failed — PR not merged; bouncing to Pull request",
                  );
                  await this.deps.tracker
                    .createComment(
                      issue.id,
                      `🛑 **Symphony — Release → Done auto-advance blocked.**\n\nPR [#${prStatus.number}](${prStatus.htmlUrl}) is \`${prStatus.state}\` but not merged (no \`merged_at\` timestamp). The Release specialist reported success but the merge did not land. Routing back to \`Pull request\` so the next Release run can retry.\n\n<!-- symphony:event=release_merge_verify_failed reason=pr_not_merged pr=${prStatus.number} -->`,
                    )
                    .catch((err) =>
                      logger.warn(
                        { err: (err as Error).message, issue: issue.identifier },
                        "release-merge-verify bounce comment failed",
                      ),
                    );
                } else if (prStatus === undefined) {
                  // Transient GitHub failure — fail open (proceed with default).
                  logger.info(
                    { issue: issue.identifier },
                    "auto-advance: Release merge-verify inconclusive (GitHub API failure); failing open",
                  );
                }
                // else: mergedAt non-null → merged → proceed normally.
              } else {
                // No GH App token (local dev / placeholder env) — fail open.
                logger.info(
                  { issue: issue.identifier },
                  "auto-advance: Release merge-verify skipped (no GH token); failing open",
                );
              }
            } catch (err) {
              logger.warn(
                { err: (err as Error).message, issue: issue.identifier },
                "auto-advance: Release merge-verify guard threw; failing open",
              );
            }
          }

          const finalOverride = mergeVerifyOverride ?? nextStateOverride;
          const nextState = finalOverride ?? defaultNextState;
          if (finalOverride) {
            logger.info(
              {
                issue: issue.identifier,
                liveState,
                defaultNext: defaultNextState,
                override: finalOverride,
                source: mergeVerifyOverride ? "merge_verify" : "decision_line",
              },
              "auto-advance: routing override detected; routing to override target",
            );
          }
          const gate = nextState ? await this.deliverableGate(issue, liveState) : { allowed: true };
          if (nextState && gate.allowed) {
            await this.deps.tracker
              .transitionIssueToState(issue.id, nextState)
              .then((res) =>
                logger.info(
                  {
                    issue: issue.identifier,
                    from: liveState,
                    to: res.state,
                    override: finalOverride,
                  },
                  "linear auto-advanced state",
                ),
              )
              .catch((err) =>
                logger.warn(
                  {
                    err: (err as Error).message,
                    issue: issue.identifier,
                    from: liveState,
                    to: nextState,
                  },
                  "linear auto-advance failed; leaving state alone",
                ),
              );
          }
        }

        // Post-Plan sub-ticketing hook. When the just-finished turn was a
        // Plan stage AND the most recent agent comment contains an
        // `## RFC` block with a `## Sub-tickets` section, file each
        // sub-ticket as a child of this issue and post a summary comment
        // on the parent linking the children.
        //
        // Decoupled from auto-advance success (A-20 / S-D16): we gate on
        // `dispatchState` — the stage the worker was DISPATCHED on, not on
        // `liveState` (the current Linear state). This means sub-tickets
        // file even if:
        //   - `transitionIssueToState` failed (5xx, race, network blip).
        //     The auto-advance error is caught + logged above; we still
        //     reach this block.
        //   - The agent's `update_issue` call (or a human) moved the
        //     ticket to RFC mid-turn. The RFC body is real; children
        //     should be filed.
        // Best-effort: a failure here doesn't unwind anything else.
        //
        // Motivating case: AGENT-444 ("letter assignee"), where the Plan
        // agent correctly identified 5 sub-tickets but had no path to
        // file them; the parent was manually closed because it couldn't
        // proceed under the existing one-PR-per-ticket assumption.
        if (dispatchState.toLowerCase() === "plan") {
          await this.tryFileSubTickets(issue).catch((err) =>
            logger.warn(
              { err: (err as Error).message, issue: issue.identifier },
              "post-plan sub-ticketing hook failed",
            ),
          );
        }
      }

      if (lastOutcome === "completed") {
        // Spec §7.1 — schedule continuation retry (~1s) to re-check tracker.
        this.scheduleRetry(issue.id, issue.identifier, 1, null, "continuation");
      } else if (lastOutcome === "cancelled") {
        // Reconciliation-driven cancellation — release without retry.
        this.state.claimed.delete(issue.id);
      } else {
        const nextAttempt = (attempt ?? 0) + 1;
        this.scheduleRetry(
          issue.id,
          issue.identifier,
          nextAttempt,
          lastError ?? "failure",
          "retry",
        );
      }
    }
  }

  /**
   * Post-Plan sub-ticketing: parse the agent's most recent `## RFC`
   * comment for a `## Sub-tickets` section; if present, file each entry
   * as a child of `issue` via Linear's `issueCreate`, then drop a
   * summary comment on the parent linking the children.
   *
   * The section format and parser tolerance are documented in
   * `sub-tickets.ts`. Children are filed sequentially (so a failure on
   * #3 doesn't lose #4/#5) and any failures are logged + summarized in
   * the parent comment so the human reviewer sees them.
   *
   * Skip conditions (all return early without error):
   *   - tracker isn't team-scoped (we need a teamId for issueCreate)
   *   - we couldn't find an `## RFC`-bearing comment in the recent
   *     thread (agent skipped the RFC; nothing to decompose)
   *   - the RFC has no `## Sub-tickets` section (single-PR scope)
   */
  private async tryFileSubTickets(parent: Issue): Promise<void> {
    const teamId = this.deps.tracker.getTeamId();
    if (!teamId) return;

    const comments = await this.deps.tracker.fetchIssueComments(parent.id, 25).catch(() => []);
    if (comments.length === 0) return;

    // Find the most recent comment that looks like an RFC. Scan newest-first
    // to handle the rare case of a Plan-stage agent posting multiple RFC
    // drafts; the latest is the one that drove the auto-advance.
    // Match an `## RFC` heading at start-of-line. Prefix with `\n` so the
    // header can match at the very start of the comment body too.
    const RFC_HEADING_RE = /(^|\n)#{1,6}\s*rfc\b/i;
    let rfcBody: string | null = null;
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i];
      if (c && RFC_HEADING_RE.test(c.body)) {
        rfcBody = c.body;
        break;
      }
    }
    if (!rfcBody) return;

    const subs = parseSubTickets(rfcBody);
    if (subs.length === 0) return;

    logger.info(
      { issue: parent.identifier, count: subs.length },
      "post-plan sub-ticketing: filing children",
    );

    interface Filed {
      title: string;
      identifier: string;
      url: string;
    }
    const filed: Filed[] = [];
    const failed: Array<{ title: string; error: string }> = [];

    // A-19 / S-D15: resolve parent's label-name list into Linear label IDs
    // ONCE before the sub-ticket loop so each child inherits the same tags.
    // Failure-mode: tracker returns [] on Linear read outage; subs file
    // without labels rather than blocking the whole batch.
    const inheritedLabelIds = await this.deps.tracker.resolveLabelIds(parent.labels);

    // Bug F follow-up: if the parent is a behavioural-probe ticket (body
    // has the no-pr-required marker, OR title starts with [TEST]/[PROBE]),
    // propagate the marker to every child so the deliverable_missing guard
    // exempts them too. Saves the operator from re-typing it on every
    // probe sub-ticket and prevents the Bug F loop reappearing on tests.
    const noPrRequired = shouldInjectNoPrRequiredMarker(parent);

    for (const sub of subs) {
      const depsOnTitle =
        sub.depsOnIndex !== null && sub.depsOnIndex >= 0 && sub.depsOnIndex < subs.length
          ? (subs[sub.depsOnIndex]?.title ?? null)
          : null;
      try {
        const created = await this.deps.tracker.createIssue({
          teamId,
          title: sub.title,
          description: renderChildDescription({
            parentIdentifier: parent.identifier,
            scope: sub.scope,
            depsOnTitle,
            noPrRequired,
          }),
          parentId: parent.id,
          // Inherit the parent's priority by default. Linear's enum is
          // 0..4 inclusive — `priority` is `number | null` on Issue.
          priority: typeof parent.priority === "number" ? parent.priority : null,
          // A-19 / S-D15: inherit parent's labels (e.g. `area:billing`,
          // `kind:bug`) so children land on the same board filters as the
          // parent. Empty array when parent has no labels OR the labels
          // lookup failed — never blocks ticket creation.
          labelIds: inheritedLabelIds,
        });
        filed.push({ title: sub.title, identifier: created.identifier, url: created.url });
      } catch (err) {
        const message = (err as Error).message;
        logger.warn(
          { err: message, issue: parent.identifier, sub: sub.title },
          "sub-ticket create failed",
        );
        failed.push({ title: sub.title, error: message });
      }
    }

    if (filed.length === 0 && failed.length === 0) return;

    const lines: string[] = [];
    lines.push(`_via **Symphony** (orchestrator-driven)_`);
    lines.push("");
    lines.push(`🧵 **Symphony — sub-tickets filed from RFC**`);
    lines.push("");
    if (filed.length > 0) {
      lines.push(`Created **${filed.length}** child issue${filed.length === 1 ? "" : "s"}:`);
      for (const f of filed) {
        lines.push(`- [${f.identifier}](${f.url}) — ${f.title}`);
      }
    }
    if (failed.length > 0) {
      lines.push("");
      lines.push(
        `⚠️ **${failed.length}** sub-ticket${failed.length === 1 ? "" : "s"} failed to file (please file manually):`,
      );
      for (const f of failed) {
        lines.push(`- _${f.title}_ — \`${f.error.slice(0, 160)}\``);
      }
    }
    lines.push("");
    lines.push(
      "_The parent issue is in **RFC** for human review. Children inherit the standard pipeline (Refinement → Plan → ...) and dispatch independently._",
    );
    lines.push("");
    lines.push(`<!-- symphony:event=sub_tickets_filed count=${filed.length} -->`);

    await this.deps.tracker
      .createComment(parent.id, lines.join("\n"))
      .catch((err) =>
        logger.warn(
          { err: (err as Error).message, issue: parent.identifier },
          "sub-ticket parent summary comment failed",
        ),
      );
  }

  /**
   * Auto-advance an issue's state mid-worker (after each successful
   * continuation turn), so the worker's continuation loop sees the
   * state divergence on its next iteration and exits — letting a fresh
   * dispatch pick up the issue with the correct stage prompt instead
   * of spinning out no-op convergence turns under a stale prompt.
   *
   * - Looks up the configured next-state for `dispatchState`.
   * - Re-checks live state and skips if a manual move happened.
   * - Skips if there's no mapping (human-review states like RFC).
   * - Best-effort: a Linear write outage logs and returns; the worker
   *   keeps running and the finally-block's auto-advance retries.
   */
  private async tryAutoAdvanceMidWorker(issue: Issue, dispatchState: string): Promise<void> {
    const issueId = issue.id;
    const nextState = this.lookupNextState(dispatchState);
    if (!nextState) return;
    let liveState = dispatchState;
    try {
      const refreshed = await this.deps.tracker.fetchIssueStatesByIds([issueId]);
      if (refreshed[0]?.state) liveState = refreshed[0].state;
    } catch {
      return;
    }
    if (liveState.toLowerCase() !== dispatchState.toLowerCase()) {
      // State already moved (manually or agent-driven). Don't fight it.
      return;
    }
    const gate = await this.deliverableGate(issue, dispatchState);
    if (!gate.allowed) return;
    await this.deps.tracker
      .transitionIssueToState(issueId, nextState)
      .then((res) =>
        logger.info(
          { issueId, from: liveState, to: res.state },
          "linear auto-advanced state (mid-worker)",
        ),
      )
      .catch((err) =>
        logger.warn(
          { err: (err as Error).message, issueId, from: liveState, to: nextState },
          "mid-worker auto-advance failed; loop will retry from finally block",
        ),
      );
  }

  /**
   * Look up the next-state name configured for the issue's current state.
   * Case-insensitive on the key (matches Linear's mixed-case names like
   * "Code Review" / "code review"). Returns null when no mapping is
   * configured — the orchestrator then leaves the issue's state alone,
   * which is what we want for human-review halts (RFC, Code Review,
   * Human Review).
   */
  private lookupNextState(currentState: string): string | null {
    const map = this.currentConfig.tracker.stateTransitions;
    const lower = currentState.toLowerCase();
    for (const [k, v] of Object.entries(map)) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  }

  /** True if `state` is in `tracker.prRequiredStates` (case-insensitive). */
  private isPrRequiredState(state: string): boolean {
    const lower = state.toLowerCase();
    return this.currentConfig.tracker.prRequiredStates.some((s) => s.toLowerCase() === lower);
  }

  /**
   * Check whether GitHub has a branch matching `issue.identifier`.
   *
   * Returns:
   *   - `true`  → a deliverable exists (advance allowed).
   *   - `false` → no deliverable found (advance blocked).
   *   - `null`  → couldn't tell (no GH App token configured, network or
   *               5xx error). Caller MUST treat null as "fail open" — i.e.
   *               let the existing auto-advance run, since blocking every
   *               advance during a GitHub outage is worse than the bug
   *               we're fixing.
   *
   * The injectable `tokenProvider` / `branchFetcher` parameters exist so
   * unit tests can substitute fakes without monkey-patching the cached
   * GH-App token minter or `globalThis.fetch`.
   */
  private async checkDeliverableExists(
    issue: Issue,
    tokenProvider: () => Promise<string | null> = getInstallationToken,
    branchFetcher: typeof fetchBranches = fetchBranches,
  ): Promise<boolean | null> {
    const token = await tokenProvider();
    if (!token) {
      // No GH App token (local dev / placeholder env). Fail open.
      return null;
    }
    // Read repo coordinates from WORKFLOW.md `github.owner` / `github.repo`
    // (required fields — preflightValidate rejects a boot without them).
    const branches = await branchFetcher(token, {
      owner: this.currentConfig.github.owner,
      repo: this.currentConfig.github.repo,
    });
    if (branches === null) return null;
    return branches.some((b) => branchMatchesIdentifier(b.name, issue.identifier));
  }

  /**
   * Centralized "should we auto-advance OUT of `dispatchState`?" decision.
   *
   * Returns `{ allowed: true }` when:
   *   - the dispatch state is NOT in `tracker.prRequiredStates`, OR
   *   - the deliverable check returned true (branch / PR found), OR
   *   - the deliverable check returned null (couldn't tell — fail open).
   *
   * Returns `{ allowed: false }` when:
   *   - the dispatch state IS in `tracker.prRequiredStates` AND
   *   - the deliverable check returned false.
   *
   * Side effects on the false branch:
   *   - increments `noDeliverableCount[issueId]`
   *   - posts a Linear comment via `tracker.createComment` ("⚠️ Symphony
   *     — <state> stage produced no PR …").
   *   - if the counter reaches `tracker.noPrRetryLimit`, transitions the
   *     issue to `Error` (best-effort) and posts a more detailed comment.
   *
   * Side effect on the true branch:
   *   - clears `noDeliverableCount[issueId]`.
   */
  private async deliverableGate(
    issue: Issue,
    dispatchState: string,
  ): Promise<{ allowed: boolean }> {
    if (!this.isPrRequiredState(dispatchState)) {
      // Not a PR-required stage — clear any stale counter for this issue
      // (e.g. issue was bumped back from Implement to Refinement after a
      // blocker resolved) and allow.
      this.noDeliverableCount.delete(issue.id);
      return { allowed: true };
    }
    // Bug F (AGENT-512): behavioural-probe opt-out. When the issue body has
    // `<!-- symphony:no-pr-required -->`, skip the GitHub branch check
    // entirely so the gate doesn't loop the ticket through warn → escalate
    // → re-dispatch. The skip clears any stale miss-counter from a prior
    // dispatch (in case the marker was added AFTER an earlier no-PR run
    // already incremented the counter).
    if (issue.description && NO_PR_REQUIRED_MARKER_RE.test(issue.description)) {
      this.noDeliverableCount.delete(issue.id);
      logger.info(
        { issue: issue.identifier, state: dispatchState },
        "deliverable check skipped: issue body has <!-- symphony:no-pr-required --> marker",
      );
      return { allowed: true };
    }
    const exists = await this.checkDeliverableExists(issue);
    if (exists === null) {
      // Couldn't tell — fail open per the contract on `checkDeliverableExists`.
      logger.info(
        { issue: issue.identifier, state: dispatchState },
        "deliverable check inconclusive (no GH token or fetch failure); allowing advance",
      );
      return { allowed: true };
    }
    if (exists) {
      this.noDeliverableCount.delete(issue.id);
      return { allowed: true };
    }
    const prev = this.noDeliverableCount.get(issue.id) ?? 0;
    const next = prev + 1;
    this.noDeliverableCount.set(issue.id, next);
    const limit = this.currentConfig.tracker.noPrRetryLimit;
    logger.warn(
      { issue: issue.identifier, state: dispatchState, miss: next, limit },
      "deliverable check failed: no branch / PR found for issue",
    );
    if (next >= limit) {
      // Limit reached — escalate to Error so a human can intervene. Reset
      // the counter so the issue isn't permanently stuck if the human
      // moves it back into an active state.
      this.noDeliverableCount.delete(issue.id);
      const detail = `🛑 **Symphony — escalating to \`Error\`**\n\nThe ${dispatchState} stage agent reported \`outcome=Succeeded\` ${limit} consecutive turns in a row, but no GitHub branch / PR was found for this issue. This is the symptom of a no-op convergence loop — the agent thinks it's done but never produced the deliverable.\n\nA human needs to:\n1. Inspect the agent's last few turn comments in this issue.\n2. Decide whether to re-dispatch (move back to ${dispatchState}) or rewrite the requirements.\n\n<!-- symphony:event=deliverable_missing_escalated state=${dispatchState} consecutive=${next} -->`;
      await this.deps.tracker
        .createComment(issue.id, detail)
        .catch((err) =>
          logger.warn(
            { err: (err as Error).message, issue: issue.identifier },
            "deliverable-gate escalation comment failed",
          ),
        );
      await this.deps.tracker
        .transitionIssueToState(issue.id, "Error")
        .then((res) =>
          logger.warn(
            { issue: issue.identifier, to: res.state },
            "deliverable-gate: moved issue to Error after consecutive no-PR misses",
          ),
        )
        .catch((err) =>
          logger.warn(
            { err: (err as Error).message, issue: issue.identifier },
            "deliverable-gate: transition to Error failed (state may not exist)",
          ),
        );
      // Bug D fix: regardless of whether the transition above succeeded, mark
      // this issue as "do not re-dispatch until the human moves it". When the
      // team has no `Error` state (Cerebro team currently — `error_states: []`)
      // the transition fails silently and we need an explicit skip so the
      // poll loop doesn't re-dispatch every 30s. The skip clears in `tick()`
      // when the issue's Linear state changes from `dispatchState`.
      this.dispatchSkipUntilStateChange.set(issue.id, dispatchState);
      logger.warn(
        {
          issue: issue.identifier,
          issueId: issue.id,
          state: dispatchState,
          mapSize: this.dispatchSkipUntilStateChange.size,
        },
        "deliverable-gate: marked issue as skip-until-state-change",
      );
      return { allowed: false };
    }
    const body = `⚠️ Symphony — ${dispatchState} stage produced no PR. Worker reported success but no branch/PR was created. Will retry on next dispatch; if this persists, escalate to Error. (${next}/${limit})\n\n<!-- symphony:event=deliverable_missing state=${dispatchState} consecutive=${next} -->`;
    await this.deps.tracker
      .createComment(issue.id, body)
      .catch((err) =>
        logger.warn(
          { err: (err as Error).message, issue: issue.identifier },
          "deliverable-gate warning comment failed",
        ),
      );
    return { allowed: false };
  }

  /* ------------------------- retry queue -------------------- */

  private scheduleRetry(
    issueId: string,
    identifier: string,
    attempt: number,
    error: string | null,
    kind: "retry" | "continuation" = "retry",
  ): void {
    // Bail out if shutdown has begun. `runWorker`'s finally block calls
    // `scheduleRetry()` for completed/failed/timed-out turns; without this
    // guard, a draining worker enqueues a continuation, the timer fires
    // (synchronously inside `setTimeout`), `onRetryFire` runs, and we
    // dispatch fresh work AFTER `gracefulStop` has signalled the
    // singleton to release the lock. Surfaced by CodeRabbit on PR #502.
    if (this.stopped) {
      this.state.claimed.delete(issueId);
      return;
    }
    const existing = this.state.retryAttempts.get(issueId);
    if (existing) cancelTimer(existing.timerHandle);

    const delayMs = computeBackoffMs({
      attempt,
      isContinuation: kind === "continuation",
      maxBackoffMs: this.currentConfig.agent.maxRetryBackoffMs,
    });
    const dueAtMs = nowMonotonicMs() + delayMs;

    const handle = scheduleTimer(delayMs, () => {
      void this.onRetryFire(issueId).catch((err) =>
        logger.error({ err: (err as Error).message, issueId }, "retry timer threw"),
      );
    });

    const entry: RetryEntry = {
      issueId,
      identifier,
      attempt,
      kind,
      dueAtMs,
      timerHandle: handle,
      error,
    };
    this.state.retryAttempts.set(issueId, entry);
    this.state.claimed.add(issueId);
    logger.info({ issueId, identifier, attempt, delayMs, kind }, "retry scheduled");
  }

  private async onRetryFire(issueId: string): Promise<void> {
    // Second guard for the case where `scheduleRetry` was called BEFORE
    // `this.stopped` flipped, then the timer fires AFTER. Both gates are
    // needed because the retry timer is independent of the shutdown
    // signal — the kindest exit is no-op + cleanup.
    if (this.stopped) {
      this.state.retryAttempts.delete(issueId);
      this.state.claimed.delete(issueId);
      return;
    }
    const entry = this.state.retryAttempts.get(issueId);
    if (!entry) return;
    this.state.retryAttempts.delete(issueId);

    let candidates: Issue[];
    try {
      candidates = await this.deps.tracker.fetchCandidateIssues(
        this.currentConfig.tracker.activeStates,
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, issueId: entry.issueId },
        "retry: candidate fetch failed; rescheduling",
      );
      // Preserve `kind` so a continuation isn't silently demoted to a retry
      // (which would change backoff and pass a non-null attempt downstream).
      this.scheduleRetry(
        entry.issueId,
        entry.identifier,
        entry.attempt + 1,
        "retry poll failed",
        entry.kind,
      );
      return;
    }

    const issue = candidates.find((c) => c.id === entry.issueId);
    if (!issue) {
      this.state.claimed.delete(entry.issueId);
      return;
    }

    if (availableSlots(this.state) <= 0) {
      this.scheduleRetry(
        entry.issueId,
        entry.identifier,
        entry.attempt + 1,
        "no available orchestrator slots",
        entry.kind,
      );
      return;
    }
    const limit = perStateLimit(
      this.state,
      this.currentConfig.agent.maxConcurrentAgentsByState,
      issue.state,
    );
    if (runningInState(this.state, issue.state) >= limit) {
      this.scheduleRetry(
        entry.issueId,
        entry.identifier,
        entry.attempt + 1,
        "no per-state slots available",
        entry.kind,
      );
      return;
    }

    // Bug D fix v3: the skip-map check must ALSO gate the auto-retry path.
    // Without this, every retry timer ignores the skip map and re-dispatches
    // the issue immediately after the deliverable-gate escalates and
    // populates the map. T-004 v5 (AGENT-500) surfaced this:
    //   17:24:23 — marked issue as skip-until-state-change (map populated)
    //   17:24:23 — retry scheduled  ← retry path queued before skip-map check
    //   17:24:24 — dispatching       ← retry fired, bypassing my tick() filter
    //
    // The regular `tick()` poll loop already has the equivalent check (see
    // line ~459); duplicating it here is the simplest fix. An alternative
    // is to make `dispatch()` itself check the map, but that would also
    // gate explicit dispatches (e.g. operator-triggered) which is too
    // aggressive.
    const skipState = this.dispatchSkipUntilStateChange.get(issue.id);
    if (skipState !== undefined) {
      if (skipState.toLowerCase() === issue.state.toLowerCase()) {
        logger.warn(
          { issue: issue.identifier, state: issue.state, skipState },
          "retry skipped: deliverable-gate previously escalated; awaiting human state change",
        );
        // Don't reschedule — the skip persists until the human moves the
        // ticket out of the dispatch state.
        this.state.claimed.delete(entry.issueId);
        return;
      }
      // State changed — clear the skip and let the retry proceed.
      logger.warn(
        { issue: issue.identifier, fromState: skipState, toState: issue.state },
        "retry: skip-map state changed — clearing entry and allowing retry",
      );
      this.dispatchSkipUntilStateChange.delete(issue.id);
    }

    // Continuations are logically a fresh first turn for the new tracker
    // state — pass attempt=null so the prompt template, audit row, and Slack
    // card don't mislabel them as retries.
    const dispatchAttempt = entry.kind === "continuation" ? null : entry.attempt;
    await this.dispatch(issue, dispatchAttempt);
  }

  /* ------------------------- cancellation ------------------- */

  private async cancelWorker(
    issueId: string,
    outcome: "stalled" | "CanceledByReconciliation",
    cleanup: boolean,
  ): Promise<void> {
    const entry = this.state.running.get(issueId);
    if (!entry) return;
    try {
      await entry.abort();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "abort threw");
    }
    if (cleanup) {
      await cleanupWorkspace({
        workspaceRoot: this.currentConfig.workspace.root,
        identifier: entry.issue.identifier,
        beforeRemoveScript: this.currentConfig.hooks.beforeRemove,
        hookTimeoutMs: this.currentConfig.hooks.timeoutMs,
      });
    }
    this.state.running.delete(issueId);
    this.lastSeenState.delete(issueId);
    this.recentRevertTimestamps.delete(issueId);
    if (outcome === "stalled") {
      this.scheduleRetry(
        issueId,
        entry.issue.identifier,
        (entry.attempt.attempt ?? 0) + 1,
        "stalled",
      );
    } else {
      this.state.claimed.delete(issueId);
    }
    await wait(0);
  }

  /**
   * Workspace keys for issues whose worker is running RIGHT NOW. Used by
   * the periodic GC + disk-pressure path to skip directories that are
   * about to be written to.
   */
  private activeWorkspaceKeys(): Set<string> {
    const keys = new Set<string>();
    for (const entry of this.state.running.values()) {
      keys.add(sanitizeIdentifier(entry.issue.identifier));
    }
    return keys;
  }

  /**
   * Workspace keys for issues currently in the dispatch pipeline (running
   * OR scheduled to retry). Broader than `activeWorkspaceKeys` — used to
   * protect dirs that are between turns.
   */
  private claimedWorkspaceKeys(): Set<string> {
    const keys = new Set<string>();
    for (const entry of this.state.running.values()) {
      keys.add(sanitizeIdentifier(entry.issue.identifier));
    }
    for (const r of this.state.retryAttempts.values()) {
      keys.add(sanitizeIdentifier(r.identifier));
    }
    return keys;
  }
}

function mapOutcome(o: "completed" | "failed" | "cancelled" | "timeout" | "stalled"): string {
  switch (o) {
    case "completed":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "cancelled":
      return "CanceledByReconciliation";
    case "timeout":
      return "TimedOut";
    case "stalled":
      return "Stalled";
  }
}

function outcomeForEmoji(label: string): string {
  switch (label) {
    case "Succeeded":
      return "✅";
    case "Failed":
      return "❌";
    case "TimedOut":
      return "⏰";
    case "Stalled":
      return "⏸️";
    default:
      return "ℹ️";
  }
}

/**
 * Exponential backoff for the Error → auto-retry loop.
 *
 * `delay = min(60_000 * 2^attempts, 86_400_000)` — capped at 24 hours.
 * The exponent itself is also clamped at 20 so `Math.pow` doesn't overflow
 * for pathological attempt counts; with the 24h time cap this is a no-op
 * in practice (the time cap dominates by attempts >= 11).
 *
 * Curve:
 *
 * | attempts | delay      |
 * |----------|------------|
 * |        1 | 2 min      |
 * |        2 | 4 min      |
 * |        3 | 8 min      |
 * |        4 | 16 min     |
 * |        5 | 32 min     |
 * |        6 | 64 min     |
 * |        7 | 128 min    |
 * |        8 | 256 min    |
 * |        9 | 512 min    |
 * |       10 | 1024 min   |
 * |       11 | 24 h (cap) |
 * |      12+ | 24 h (cap) |
 *
 * Exported for unit tests (and operators tracing why a ticket has been
 * waiting in Error for so long); kept module-scoped rather than a class
 * method because it's a pure function with no orchestrator state.
 */
export function computeErrorBackoffMs(attempts: number): number {
  // Treat non-finite / NaN inputs as 0 attempts so a corrupt audit row
  // doesn't propagate into a NaN sleep that the orchestrator would
  // silently honor as "wait forever".
  const safeAttempts = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
  const exponent = Math.min(20, safeAttempts);
  const base = 60_000 * Math.pow(2, exponent);
  return Math.min(base, 86_400_000);
}
