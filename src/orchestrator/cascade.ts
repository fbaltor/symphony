/**
 * Cascade dispatch — §8 / E-9, E-13, E-16 of IMPROVEMENTS.md.
 *
 * Three cascade flows fire as side effects of state changes (none of them
 * call an LLM):
 *
 *   1. **Development cascade** (E-9, E-13): when a parent ticket enters
 *      `Development`, transition every sub in `Subtask drafted` →
 *      `To implement (manual)` and post a parent comment listing them.
 *
 *   2. **Cancel cascade** (E-9): when a parent ticket enters `Canceled`,
 *      transition every non-terminal sub → `Canceled` and post a parent
 *      comment listing them. Subs already in terminal states (Done,
 *      Canceled, Duplicate) are NOT touched.
 *
 *   3. **Sub-Done watcher** (E-16): when ANY sub reaches `Done`, query its
 *      siblings; if all siblings are in terminal states (Done, Canceled,
 *      Duplicate), transition the parent → `Validation (manual)` and post
 *      a parent comment.
 *
 * The orchestrator's tick / webhook handler invokes the appropriate function
 * after detecting the triggering state change. Each function is idempotent:
 * re-firing on the same state change must not re-cascade (verified by
 * checking children's current states before transitioning).
 */

import type pg from "pg";
import { logger } from "../observability/logger.js";
import type { IssueTracker } from "../tracker/tracker.js";
import { ensureIssueMetadataRow } from "../audit/issue-metadata.js";

/**
 * Linear default terminal states. Subs in these states are NOT cascaded
 * to Canceled in the Cancel cascade, and ARE counted as "done enough" by
 * the Sub-Done watcher.
 *
 * Hard-coded because they're Linear platform-level (not per-team config).
 * The team-level config in WORKFLOW.staging.md's `terminal_states` is for
 * Symphony's poll-loop short-circuit; this list is Linear's actual
 * terminal-type semantics.
 */
const LINEAR_TERMINAL_STATES = new Set(["Done", "Canceled", "Duplicate"]);

/**
 * Sub-Done watcher's "completed" set. Subs in Canceled / Duplicate count
 * as "done enough" because the human's intent was "this sub will not
 * proceed" — the parent's Validation (manual) gate should still fire so
 * the human owner explicitly closes the parent.
 */
const SUB_COMPLETED_STATES = new Set(["Done", "Canceled", "Duplicate"]);

/**
 * The state Symphony moves drafted subs into when their parent enters
 * Development. Drafted subs are filed by the Technical plan agent and start
 * in `Subtask drafted` (an unstarted state).
 */
const DRAFTED_SUB_STATE = "Subtask drafted";
const TO_IMPLEMENT_STATE = "To implement (manual)";

/**
 * The state Symphony moves a parent into when all its subs are completed.
 */
const PARENT_VALIDATION_STATE = "Validation (manual)";

/**
 * The state Symphony moves non-terminal subs into when the parent is canceled.
 */
const CANCELED_STATE = "Canceled";

export interface CascadeContext {
  /** Issue tracker client. */
  tracker: IssueTracker;
  /** Postgres pool for issue_metadata side-effects. */
  pool: pg.Pool;
  /** Logger pre-bound with the parent issue's identifier. */
  logger: typeof logger;
}

export interface CascadeResult {
  cascadedSubIds: string[];
  cascadedSubIdentifiers: string[];
  /** Subs we observed but didn't touch (e.g., already in terminal state). */
  skippedSubIdentifiers: string[];
  /** Errors swallowed per-sub so a single Linear write outage doesn't bleed across subs. */
  errors: Array<{ subIdentifier: string; reason: string }>;
}

/**
 * Development cascade (E-9 / E-13): parent → Development triggers each sub
 * in `Subtask drafted` → `To implement (manual)`.
 *
 * Idempotent: subs already past Subtask drafted (e.g., a sub already in
 * Pull request because the human raced ahead) are skipped without error.
 */
export async function runDevelopmentCascade(
  ctx: CascadeContext,
  parent: { id: string; identifier: string },
): Promise<CascadeResult> {
  const result: CascadeResult = {
    cascadedSubIds: [],
    cascadedSubIdentifiers: [],
    skippedSubIdentifiers: [],
    errors: [],
  };

  // Distinguish "fetch errored" (Linear/API outage — caller can retry on
  // next webhook tick) from "fetch returned an empty list" (Technical plan
  // misbehaved). Surfaced 2026-05-07 by Copilot review on PR #684: emitting
  // the "no sub-issues" warning during a Linear outage produces noisy /
  // misleading operator signals.
  let fetchFailed = false;
  const children = await ctx.tracker.fetchChildIssues(parent.id).catch((err) => {
    fetchFailed = true;
    ctx.logger.error(
      { err: (err as Error).message, parent: parent.identifier },
      "fetchChildIssues failed during Development cascade — treating as transient; will retry on next webhook",
    );
    return [];
  });

  if (children.length === 0) {
    if (fetchFailed) {
      // Outage: don't claim Technical plan misbehaved. The next webhook
      // delivery (or a manual re-trigger) will re-run the cascade.
      return result;
    }
    ctx.logger.warn(
      { parent: parent.identifier },
      "Development cascade: parent has no sub-issues — Technical plan should have filed at least one",
    );
    return result;
  }

  for (const sub of children) {
    if (sub.state !== DRAFTED_SUB_STATE) {
      ctx.logger.debug(
        { sub: sub.identifier, state: sub.state },
        "Development cascade: skipping sub not in 'Subtask drafted'",
      );
      result.skippedSubIdentifiers.push(sub.identifier);
      continue;
    }
    try {
      await ctx.tracker.transitionIssueToState(sub.id, TO_IMPLEMENT_STATE);
      // Ensure a metadata row exists so when the human moves the sub
      // through Implementation → Pull request → PR validation, the
      // counters / cost tracking have a place to write.
      await ensureIssueMetadataRow(ctx.pool, {
        issueId: sub.id,
        issueIdentifier: sub.identifier,
      });
      result.cascadedSubIds.push(sub.id);
      result.cascadedSubIdentifiers.push(sub.identifier);
    } catch (err) {
      const e = err as Error;
      ctx.logger.warn(
        { sub: sub.identifier, err: e.message },
        "Development cascade: transitionIssueToState failed; continuing",
      );
      result.errors.push({ subIdentifier: sub.identifier, reason: e.message });
    }
  }

  // Post a parent comment summarizing the cascade — this is the user-visible
  // record of "here are the subs Symphony just handed off". Best-effort.
  if (result.cascadedSubIdentifiers.length > 0) {
    const body = [
      `🔁 **Symphony — Development cascade** moved ${result.cascadedSubIdentifiers.length} sub-issue${result.cascadedSubIdentifiers.length === 1 ? "" : "s"} → \`${TO_IMPLEMENT_STATE}\`:`,
      "",
      ...result.cascadedSubIdentifiers.map((id) => `- ${id}`),
      "",
      "_Pick one, open it, paste its prompt into local Claude Code, and let it run autonomously._",
    ].join("\n");
    await ctx.tracker.createComment(parent.id, body).catch((err) => {
      ctx.logger.warn(
        { err: (err as Error).message, parent: parent.identifier },
        "Development cascade: parent comment post failed",
      );
    });
  }

  ctx.logger.info(
    {
      parent: parent.identifier,
      cascaded: result.cascadedSubIdentifiers,
      skipped: result.skippedSubIdentifiers,
      errors: result.errors.length,
    },
    "Development cascade complete",
  );

  return result;
}

/**
 * Cancel cascade (E-9): parent → Canceled triggers each non-terminal sub
 * → Canceled.
 *
 * Idempotent: subs already in terminal states are skipped without error.
 */
export async function runCancelCascade(
  ctx: CascadeContext,
  parent: { id: string; identifier: string },
): Promise<CascadeResult> {
  const result: CascadeResult = {
    cascadedSubIds: [],
    cascadedSubIdentifiers: [],
    skippedSubIdentifiers: [],
    errors: [],
  };

  // Same outage-vs-empty distinction as Development cascade — skip the
  // benign-debug "no sub-issues" log on transient failure.
  let fetchFailed = false;
  const children = await ctx.tracker.fetchChildIssues(parent.id).catch((err) => {
    fetchFailed = true;
    ctx.logger.error(
      { err: (err as Error).message, parent: parent.identifier },
      "fetchChildIssues failed during Cancel cascade — treating as transient; will retry on next webhook",
    );
    return [];
  });

  if (children.length === 0) {
    if (fetchFailed) return result;
    ctx.logger.debug(
      { parent: parent.identifier },
      "Cancel cascade: parent has no sub-issues",
    );
    return result;
  }

  for (const sub of children) {
    if (LINEAR_TERMINAL_STATES.has(sub.state)) {
      ctx.logger.debug(
        { sub: sub.identifier, state: sub.state },
        "Cancel cascade: skipping sub already in terminal state",
      );
      result.skippedSubIdentifiers.push(sub.identifier);
      continue;
    }
    try {
      await ctx.tracker.transitionIssueToState(sub.id, CANCELED_STATE);
      result.cascadedSubIds.push(sub.id);
      result.cascadedSubIdentifiers.push(sub.identifier);
    } catch (err) {
      const e = err as Error;
      ctx.logger.warn(
        { sub: sub.identifier, err: e.message },
        "Cancel cascade: transitionIssueToState failed; continuing",
      );
      result.errors.push({ subIdentifier: sub.identifier, reason: e.message });
    }
  }

  if (result.cascadedSubIdentifiers.length > 0) {
    const body = [
      `❌ **Symphony — Cancel cascade** moved ${result.cascadedSubIdentifiers.length} sub-issue${result.cascadedSubIdentifiers.length === 1 ? "" : "s"} → \`${CANCELED_STATE}\` because the parent was canceled:`,
      "",
      ...result.cascadedSubIdentifiers.map((id) => `- ${id}`),
    ].join("\n");
    await ctx.tracker.createComment(parent.id, body).catch((err) => {
      ctx.logger.warn(
        { err: (err as Error).message, parent: parent.identifier },
        "Cancel cascade: parent comment post failed",
      );
    });
  }

  ctx.logger.info(
    {
      parent: parent.identifier,
      cascaded: result.cascadedSubIdentifiers,
      skipped: result.skippedSubIdentifiers,
      errors: result.errors.length,
    },
    "Cancel cascade complete",
  );

  return result;
}

export interface SubDoneWatcherResult {
  /** Whether the parent was transitioned to Validation (manual) on this run. */
  parentTransitioned: boolean;
  /** Total siblings observed (incl. the just-Done one). */
  totalSiblings: number;
  /** Siblings in terminal completion states. */
  completedSiblings: number;
  /** Reason for skipping when parentTransitioned=false. */
  skipReason: string | null;
}

/**
 * Sub-Done watcher (E-16): when any sub reaches Done, the orchestrator
 * calls this with the SUB's parent. The watcher queries all siblings:
 *   - If all siblings are in `SUB_COMPLETED_STATES` → transition parent
 *     → `Validation (manual)`, post a comment.
 *   - Otherwise → no-op, return with skipReason.
 *
 * Idempotent: re-running on a parent already in Validation (manual) or
 * past it (e.g., human moved to Done) is a no-op.
 */
export async function runSubDoneWatcher(
  ctx: CascadeContext,
  parent: { id: string; identifier: string; state: string },
): Promise<SubDoneWatcherResult> {
  // Fast-path: if the parent is already in Validation (manual), Done, or
  // a terminal state, the watcher has already fired (or is irrelevant).
  if (
    parent.state === PARENT_VALIDATION_STATE ||
    LINEAR_TERMINAL_STATES.has(parent.state)
  ) {
    return {
      parentTransitioned: false,
      totalSiblings: 0,
      completedSiblings: 0,
      skipReason: `parent already in ${parent.state}`,
    };
  }

  // Same outage-vs-empty distinction as Development/Cancel cascades — a
  // fetch failure must NOT be reported as "parent has no sub-issues",
  // which would mislead the operator and could even trigger spurious
  // parent transitions if the upstream relied on `completedSiblings ===
  // totalSiblings`. Surfaced 2026-05-07 by Copilot review on PR #684.
  let fetchFailed = false;
  const children = await ctx.tracker.fetchChildIssues(parent.id).catch((err) => {
    fetchFailed = true;
    ctx.logger.error(
      { err: (err as Error).message, parent: parent.identifier },
      "fetchChildIssues failed during Sub-Done watcher — treating as transient; will retry on next webhook",
    );
    return [];
  });

  if (children.length === 0) {
    return {
      parentTransitioned: false,
      totalSiblings: 0,
      completedSiblings: 0,
      skipReason: fetchFailed
        ? "fetchChildIssues errored (transient — retry on next webhook)"
        : "parent has no sub-issues",
    };
  }

  const completedCount = children.filter((c) => SUB_COMPLETED_STATES.has(c.state)).length;
  if (completedCount < children.length) {
    return {
      parentTransitioned: false,
      totalSiblings: children.length,
      completedSiblings: completedCount,
      skipReason: `only ${completedCount}/${children.length} subs completed`,
    };
  }

  // All subs done → transition parent.
  try {
    await ctx.tracker.transitionIssueToState(parent.id, PARENT_VALIDATION_STATE);
  } catch (err) {
    const e = err as Error;
    ctx.logger.warn(
      { parent: parent.identifier, err: e.message },
      "Sub-Done watcher: parent transition failed; will retry on next tick",
    );
    return {
      parentTransitioned: false,
      totalSiblings: children.length,
      completedSiblings: completedCount,
      skipReason: `transitionIssueToState failed: ${e.message}`,
    };
  }

  const body = [
    `🏁 **Symphony — Sub-Done watcher** all ${children.length} sub-issue${children.length === 1 ? "" : "s"} completed (Done / Canceled / Duplicate). Parent advanced → \`${PARENT_VALIDATION_STATE}\`.`,
    "",
    "_End-to-end validation is now your call: pull main, exercise the change in staging, then close this ticket._",
  ].join("\n");
  await ctx.tracker.createComment(parent.id, body).catch((err) => {
    ctx.logger.warn(
      { parent: parent.identifier, err: (err as Error).message },
      "Sub-Done watcher: parent comment post failed",
    );
  });

  ctx.logger.info(
    { parent: parent.identifier, completedCount, total: children.length },
    "Sub-Done watcher: parent → Validation (manual)",
  );

  return {
    parentTransitioned: true,
    totalSiblings: children.length,
    completedSiblings: completedCount,
    skipReason: null,
  };
}
