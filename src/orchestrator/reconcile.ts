import type pg from "pg";
import type { Issue, OrchestratorState } from "../types.js";
import { logger } from "../observability/logger.js";
import { nowMonotonicMs } from "../lib/time.js";

/**
 * Spec §8.5 reconciliation — three phases:
 *
 *   A. Stall detection: kill workers whose last event is older than
 *      stall_timeout_ms.
 *   B. Tracker state refresh: stop/clean workers whose issue moved to
 *      terminal or non-active state.
 *   C. Review-gate enforcement: revert unauthorized state moves to/from
 *      configured human-review states (RFC, Code Review, Human Review).
 *      Closes the gap where an in-flight agent calls `update_issue` to
 *      bypass a review halt — observed on AGENT-447 (Plan → Implement,
 *      skipping the RFC gate).
 */

export interface ReconcileTracker {
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;
  /**
   * Optional: only required when review-gate enforcement is enabled. The
   * reconciler calls these to revert unauthorized moves and to post the
   * accompanying ⚠️ comment on the issue's thread.
   */
  transitionIssueToState?: (
    issueId: string,
    stateName: string,
  ) => Promise<{ identifier: string; state: string }>;
  createComment?: (issueId: string, body: string) => Promise<{ id: string; url: string } | null>;
}

export interface StallHandlerArgs {
  issueId: string;
  reason: string;
}

export type StallHandler = (args: StallHandlerArgs) => Promise<void>;

export interface TerminalHandlerArgs {
  issueId: string;
  cleanup: boolean;
}

export type TerminalHandler = (args: TerminalHandlerArgs) => Promise<void>;

export async function reconcileStalledRuns(args: {
  state: OrchestratorState;
  stallTimeoutMs: number;
  onStall: StallHandler;
}): Promise<void> {
  if (args.stallTimeoutMs <= 0) return;
  // `lastEventMonotonicMs` is set via `nowMonotonicMs()` (process uptime) by
  // the worker, so we MUST compare against the same clock — not Date.now().
  const now = nowMonotonicMs();
  for (const [issueId, entry] of args.state.running) {
    const elapsed = now - entry.lastEventMonotonicMs;
    if (elapsed > args.stallTimeoutMs) {
      logger.warn(
        { issueId, identifier: entry.issue.identifier, elapsedMs: elapsed },
        "reconcile: detected stall",
      );
      await args.onStall({ issueId, reason: "stalled" });
    }
  }
}

/**
 * Decide whether `(prev → next)` is an authorized transition.
 *
 * Authorized iff the pair appears as an EDGE in `state_transitions` —
 * either forward (`stateTransitions[prev] === next`, the orchestrator's
 * own auto-advance direction) OR reverse (`stateTransitions[next] === prev`,
 * the explicit "human go-back" direction: RFC → Plan to redo a plan,
 * Code Review → Implement to revise a PR). All comparisons are
 * case-insensitive so mixed-case Linear state names ("Code Review" vs
 * "code review") match consistently.
 *
 * The reverse-edge allowance is intentional. Without it, the structural
 * rule would revert legitimate human "go back to redo" moves into the
 * upstream active state — defeating the whole point of a hybrid workflow.
 * Forward-only matching would also force operators to add asymmetric
 * config (Plan→RFC and RFC→Plan), which would silently re-enable agent
 * auto-advance on the reverse direction.
 */
function isAuthorizedTransition(
  prev: string,
  next: string,
  stateTransitions: Record<string, string>,
): boolean {
  const prevLower = prev.toLowerCase();
  const nextLower = next.toLowerCase();
  for (const [k, v] of Object.entries(stateTransitions)) {
    const kLower = k.toLowerCase();
    const vLower = v.toLowerCase();
    if (kLower === prevLower && vLower === nextLower) return true; // forward
    if (kLower === nextLower && vLower === prevLower) return true; // reverse
  }
  return false;
}

function isInList(state: string, list: string[]): boolean {
  const lower = state.toLowerCase();
  return list.some((s) => s.toLowerCase() === lower);
}

/**
 * Forward-direction lookup for state_transitions[prev] → next state name.
 * Case-insensitive on the key. Returns undefined when no edge is configured
 * (e.g. for review-gate keys themselves, which we deliberately leave out of
 * the auto-advance map).
 */
function lookupNext(prev: string, stateTransitions: Record<string, string>): string | undefined {
  const prevLower = prev.toLowerCase();
  for (const [k, v] of Object.entries(stateTransitions)) {
    if (k.toLowerCase() === prevLower) return v;
  }
  return undefined;
}

export async function reconcileTrackerStates(args: {
  state: OrchestratorState;
  tracker: ReconcileTracker;
  activeStates: string[];
  terminalStates: string[];
  onTerminal: TerminalHandler;
  onIssueRefresh?: (issue: Issue) => void;
  /**
   * Review-gate enforcement inputs. When `humanReviewStates` is non-empty
   * and `lastSeenState` is provided, the reconciler reverts unauthorized
   * moves to/from review-gate states. Pass undefined / empty to disable.
   */
  humanReviewStates?: string[];
  stateTransitions?: Record<string, string>;
  lastSeenState?: Map<string, string>;
  /**
   * A-18: per-issue revert-timestamp tracker. After REVERT_RATE_LIMIT
   * reverts inside REVERT_WINDOW_MS, the reconciler stops reverting and
   * moves the issue to `errorStates[0]` instead — escapes the busy-loop
   * where a persistent agent fights the gate-revert on every tick.
   * Map is mutated in-place by the reconciler (same lifecycle pattern
   * as `lastSeenState`); orchestrator owns the storage.
   */
  recentRevertTimestampsMs?: Map<string, number[]>;
  /**
   * A-18: list of error sink states (typically `tracker.errorStates`).
   * The reconciler uses `errorStates[0]` as the escalation target when
   * a per-issue revert burst exceeds the rate limit. Empty / undefined
   * disables the escalation (status-quo behavior — log + keep reverting).
   */
  errorStates?: string[];
  /**
   * 2026-05-07 release-cancellation conflict fix (Option B): the Release
   * specialist drives `gh pr merge --squash --delete-branch`, which
   * triggers Linear's native GitHub integration to auto-transition the
   * issue to `Done` (a terminal state). Without this hook, the reconciler
   * sees the terminal-state move on its very next tick and cancels the
   * still-running Release worker mid-flight — clobbering the worker's
   * `## Release report` write, audit-row cost capture, and graceful
   * stage-transition handoff. Two competing automations race over the
   * same transition: Linear's `merge → Done` rule vs. Symphony's own
   * `Release → Done` state_transitions edge.
   *
   * The orchestrator passes a predicate that returns `true` for issues
   * whose currently-running worker is allowed to finish out a terminal
   * transition (i.e. the Release specialist). The reconciler then
   * SKIPS the terminal-state cancellation for that single tick — by the
   * next tick the worker has finished, the audit row is written, the
   * orchestrator's auto-advance has been a no-op (issue already at the
   * target terminal state), and the worker's `state.running` entry has
   * been removed normally. If the worker hangs past `stallTimeoutMs`
   * the stall reconciler still wins — this hook only protects the
   * narrow window between merge-success and worker-cleanup.
   *
   * Pass `undefined` (or a predicate that always returns false) to
   * preserve status-quo behavior. Returning a Promise is supported so
   * the orchestrator can consult Postgres state if needed; the
   * reconciler awaits the result inline.
   */
  isProtectedTerminalIssue?: (issueId: string) => boolean | Promise<boolean>;
  /**
   * A-16 / S-D13 (Task 2): the bot's own Linear user id (from
   * `tracker.getViewerId()` at boot). When provided alongside `pool`,
   * the reconciler queries `symphony.issue_state_actor` for the issue
   * BEFORE reverting an unauthorized state move; if the last actor is
   * NOT the bot, the move was human-driven and the revert is skipped
   * (the lastSeenState is still updated so we don't try again next
   * tick). When unset (boot lookup failed, or DB unavailable), the
   * reconciler falls back to the legacy revert behavior — same as
   * before this task landed.
   */
  botUserId?: string | null;
  /**
   * A-16 / S-D13: Postgres pool for reading `symphony.issue_state_actor`.
   * Required when `botUserId` is set; otherwise ignored. Pass undefined
   * for tests that don't exercise the actor-skip path.
   */
  pool?: pg.Pool;
}): Promise<void> {
  const REVERT_WINDOW_MS = 60 * 60 * 1000;
  const REVERT_RATE_LIMIT = 3;
  const ids = [...args.state.running.keys()];
  if (ids.length === 0) return;

  let refreshed: Issue[];
  try {
    refreshed = await args.tracker.fetchIssueStatesByIds(ids);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "reconcile: tracker state refresh failed; keeping workers running",
    );
    return;
  }

  const terminalLower = args.terminalStates.map((s) => s.toLowerCase());
  const activeLower = args.activeStates.map((s) => s.toLowerCase());
  const reviewGates = args.humanReviewStates ?? [];
  const transitions = args.stateTransitions ?? {};

  for (const fresh of refreshed) {
    const entry = args.state.running.get(fresh.id);
    if (!entry) continue;

    // Phase C — review-gate enforcement. Runs BEFORE the terminal/active
    // routing so we revert FIRST, then evaluate the (possibly reverted)
    // state for normal active/terminal handling.
    if (
      reviewGates.length > 0 &&
      args.lastSeenState &&
      args.tracker.transitionIssueToState &&
      args.tracker.createComment
    ) {
      const prev = args.lastSeenState.get(fresh.id);
      const next = fresh.state;
      const isTerminalNext = terminalLower.includes(next.toLowerCase());
      // Only consider reverting when:
      //   1. We have an observed prev state (worker has had at least one tick).
      //   2. The state actually changed.
      //   3. The new state is NOT terminal — agents legitimately drive
      //      issues to Done / Canceled / Duplicate / Error and we never
      //      want to revert those.
      if (prev && prev.toLowerCase() !== next.toLowerCase() && !isTerminalNext) {
        const authorized = isAuthorizedTransition(prev, next, transitions);
        if (!authorized) {
          // A transition is gate-bypassing if any of:
          //   - prev is itself a review-gate state (agent leaving a gate
          //     without human approval, e.g. Code Review → Implement is
          //     handled by the reverse-edge in isAuthorizedTransition;
          //     anything else like Code Review → Done-via-non-config is
          //     a bypass).
          //   - next is a review-gate state but the move isn't an
          //     authorized edge (rare, mostly defensive).
          //   - the configured forward edge for prev points AT a review
          //     gate, and the agent moved elsewhere — i.e. they skipped
          //     the gate. This is the AGENT-447 case: state_transitions[Plan]
          //     = RFC, agent moved Plan → Implement, RFC was bypassed.
          const touchesGate = isInList(prev, reviewGates) || isInList(next, reviewGates);
          const configuredNext = lookupNext(prev, transitions);
          const skippedConfiguredGate = !!configuredNext && isInList(configuredNext, reviewGates);
          // A-16 / S-D13 (Task 2): if we know the bot's user id and have
          // a recorded actor for this issue, check whether the move was
          // human-driven. If yes, skip the revert path entirely — the
          // human is overriding the agent and that intent is load-bearing
          // for the 16-state pipeline (operator drags ticket back to a
          // gate to force a re-iteration). When no actor row exists or
          // the lookup fails, we fall through to the legacy revert
          // behavior — same as before this task landed.
          if (touchesGate || skippedConfiguredGate) {
            if (args.botUserId && args.pool) {
              try {
                const r = await args.pool.query<{
                  last_actor_id: string;
                  last_actor_type: string | null;
                  last_state: string;
                }>(
                  `SELECT last_actor_id, last_actor_type, last_state
                     FROM symphony.issue_state_actor
                    WHERE issue_id = $1`,
                  [fresh.id],
                );
                const row = r.rows[0];
                // Stale-row guard (Copilot review on PR #691): trust the
                // recorded actor ONLY when its `last_state` matches the
                // state the orchestrator just observed (`next`). If they
                // differ — the webhook missed a delivery, events arrived
                // out of order, or a more recent bot move came after the
                // row we have — fall back to the legacy revert behavior.
                // Skipping revert based on a stale human actor for a
                // fresh bot move would defeat the gate-enforcement we're
                // trying to preserve.
                const recordedStateMatches =
                  !!row && row.last_state.toLowerCase() === next.toLowerCase();
                if (row && recordedStateMatches && row.last_actor_id !== args.botUserId) {
                  logger.info(
                    {
                      issueId: fresh.id,
                      identifier: fresh.identifier,
                      from: prev,
                      to: next,
                      actorId: row.last_actor_id,
                      actorType: row.last_actor_type,
                      botUserId: args.botUserId,
                    },
                    "reconcile: human actor detected; skipping revert (gate move treated as operator override)",
                  );
                  // Update lastSeenState so the next tick doesn't try to
                  // revert this same move again. The orchestrator's
                  // auto-advance still respects the new state.
                  args.lastSeenState.set(fresh.id, next);
                  entry.issue.state = next;
                  continue;
                }
                if (row && !recordedStateMatches) {
                  logger.info(
                    {
                      issueId: fresh.id,
                      identifier: fresh.identifier,
                      recordedState: row.last_state,
                      observedState: next,
                    },
                    "reconcile: actor row state mismatch; treating actor as unknown and using legacy revert behavior",
                  );
                }
              } catch (err) {
                logger.warn(
                  { err: (err as Error).message, issueId: fresh.id },
                  "reconcile: actor lookup failed; falling back to legacy revert behavior",
                );
              }
            }
            const gate = isInList(next, reviewGates)
              ? next
              : isInList(prev, reviewGates)
                ? prev
                : (configuredNext as string);
            // A-18: per-issue revert rate limit. Track recent revert
            // timestamps; if too many in the window, escalate instead of
            // reverting again. Counter is in-memory; mirrors lastSeenState's
            // restart behavior (resets on rollover, which is acceptable —
            // a persistent loop will trip the limit again after reboot).
            const escalationState = args.errorStates?.[0];
            let escalating = false;
            if (args.recentRevertTimestampsMs && escalationState) {
              const now = Date.now();
              const cutoff = now - REVERT_WINDOW_MS;
              const list = (args.recentRevertTimestampsMs.get(fresh.id) ?? []).filter(
                (t) => t > cutoff,
              );
              list.push(now);
              args.recentRevertTimestampsMs.set(fresh.id, list);
              if (list.length > REVERT_RATE_LIMIT) {
                escalating = true;
              }
            }

            if (escalating && escalationState) {
              logger.warn(
                {
                  issueId: fresh.id,
                  identifier: fresh.identifier,
                  from: prev,
                  to: next,
                  gate,
                  rateLimit: REVERT_RATE_LIMIT,
                  windowMs: REVERT_WINDOW_MS,
                  errorState: escalationState,
                },
                "reconcile: revert rate limit exceeded; escalating to error state",
              );
              try {
                await args.tracker.transitionIssueToState(fresh.id, escalationState);
                args.lastSeenState.set(fresh.id, escalationState);
                fresh.state = escalationState;
                entry.issue.state = escalationState;
              } catch (err) {
                logger.warn(
                  { err: (err as Error).message, issueId: fresh.id },
                  "reconcile: escalation transitionIssueToState failed",
                );
                args.lastSeenState.set(fresh.id, next);
              }
              const escBody = `_via **Symphony** (orchestrator-driven)_\n\n🛑 Symphony escalated this issue to **${escalationState}** after ${REVERT_RATE_LIMIT}+ unauthorized state moves to/from **${gate}** within the last hour. The agent appears to be fighting the review gate; a human needs to intervene before retrying.\n\n<!-- symphony:event=review_gate_escalated gate=${gate} count=${REVERT_RATE_LIMIT} -->`;
              await args.tracker
                .createComment(fresh.id, escBody)
                .catch((err) =>
                  logger.warn(
                    { err: (err as Error).message, issueId: fresh.id },
                    "reconcile: escalation comment failed",
                  ),
                );
            } else {
              logger.warn(
                {
                  issueId: fresh.id,
                  identifier: fresh.identifier,
                  from: prev,
                  to: next,
                  gate,
                },
                "reconcile: unauthorized review-gate move; reverting",
              );
              try {
                await args.tracker.transitionIssueToState(fresh.id, prev);
                // Reflect the revert in lastSeenState so we don't immediately
                // see this as another change on the next tick.
                args.lastSeenState.set(fresh.id, prev);
                fresh.state = prev;
                entry.issue.state = prev;
              } catch (err) {
                logger.warn(
                  { err: (err as Error).message, issueId: fresh.id },
                  "reconcile: revert transitionIssueToState failed",
                );
                // If the revert failed, accept the new state as last-seen so
                // we don't busy-loop trying to revert the same move forever.
                args.lastSeenState.set(fresh.id, next);
              }
              const body = `_via **Symphony** (orchestrator-driven)_\n\n⚠️ Symphony reverted unauthorized state move from **${prev}** → **${next}**; the **${gate}** review gate is required.\n\n<!-- symphony:event=review_gate_reverted from=${prev} to=${next} gate=${gate} -->`;
              await args.tracker
                .createComment(fresh.id, body)
                .catch((err) =>
                  logger.warn(
                    { err: (err as Error).message, issueId: fresh.id },
                    "reconcile: review-gate revert comment failed",
                  ),
                );
            }
            // Continue to active/terminal routing using the (possibly
            // reverted/escalated) fresh.state.
          } else {
            args.lastSeenState.set(fresh.id, next);
          }
        } else {
          args.lastSeenState.set(fresh.id, next);
        }
      } else {
        // No prev / unchanged / terminal-next: just refresh last-seen.
        args.lastSeenState.set(fresh.id, next);
      }
    }

    const stateLower = fresh.state.toLowerCase();
    if (terminalLower.includes(stateLower)) {
      // Release-cancellation conflict guard: skip terminal cancellation
      // for one tick if the orchestrator marked this issue as having
      // a protected in-flight worker (typically Release specialist post-
      // merge). See `isProtectedTerminalIssue` doc above for the full
      // rationale. We still log so an operator can audit when the guard
      // fires — repeated firings on the same issue would indicate a
      // stuck worker that should be cleaned up by the stall reconciler.
      if (args.isProtectedTerminalIssue) {
        let protectedFromCancel = false;
        try {
          protectedFromCancel = await args.isProtectedTerminalIssue(fresh.id);
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, issueId: fresh.id, identifier: fresh.identifier },
            "reconcile: isProtectedTerminalIssue threw; falling through to cancellation (fail-safe)",
          );
          protectedFromCancel = false;
        }
        if (protectedFromCancel) {
          logger.info(
            { issueId: fresh.id, identifier: fresh.identifier, state: fresh.state },
            "reconcile: issue is terminal but worker is protected (Release post-merge); skipping cancellation",
          );
          // Refresh the in-memory issue state so the next tick sees the
          // truth (the worker itself will normally remove the entry from
          // `running` once it writes its audit row).
          entry.issue.state = fresh.state;
          continue;
        }
      }
      logger.info(
        { issueId: fresh.id, identifier: fresh.identifier, state: fresh.state },
        "reconcile: issue is terminal; stopping + cleaning",
      );
      await args.onTerminal({ issueId: fresh.id, cleanup: true });
    } else if (activeLower.includes(stateLower)) {
      // Refresh only the fields the minimal state-refresh query actually
      // populates. Replacing `entry.issue = fresh` would clobber title,
      // labels, etc. with empties from `fetchIssueStatesByIds`.
      entry.issue.state = fresh.state;
      args.onIssueRefresh?.(entry.issue);
    } else {
      logger.info(
        { issueId: fresh.id, identifier: fresh.identifier, state: fresh.state },
        "reconcile: issue is non-active; stopping without cleanup",
      );
      await args.onTerminal({ issueId: fresh.id, cleanup: false });
    }
  }
}
