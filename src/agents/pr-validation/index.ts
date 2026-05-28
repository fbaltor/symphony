/**
 * PR validation specialist module — default export is a `Specialist`.
 *
 * The orchestrator's specialist registry (`src/agents/index.ts`, future)
 * looks specialists up by `state`. When an issue enters `PR validation`,
 * the orchestrator calls `run(ctx)` and writes a single `run_audit` row
 * from the returned `SpecialistResult`.
 *
 * **`run()` is intentionally STUBBED for now.** The real `gh`-CLI-driven
 * implementation lands in Phase 2.5 (orchestrator wiring per the
 * IMPROVEMENTS.md sequencing). What lives here today is the cap-gate logic
 * + iteration-counter bump, which IS load-bearing — even on the stubbed
 * path the orchestrator must not bypass `PR_VALIDATION_ITERATION_CAP`.
 *
 * The cap gate runs BEFORE the counter bump:
 *   - If `pr_validation_iteration >= 5` already, this dispatch is the 6th
 *     attempt. Escalate to `Error (manual)` and DO NOT bump the counter
 *     further (a capped issue stays at exactly 5 — humans triage from
 *     there).
 *   - Otherwise, bump the counter via `recordSpecialistRun` (which writes
 *     `last_specialist = "pr-validation"`) and return Succeeded.
 */

import type { Specialist, SpecialistContext, SpecialistResult } from "../types.js";
import { getPromptVersion } from "../types.js";
import {
  PR_VALIDATION_ITERATION_CAP,
  isPrValidationCapped,
  recordSpecialistRun,
  setErrorState,
} from "../../audit/issue-metadata.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

const NAME = "pr-validation";
const STATE = "PR validation";

const prValidation: Specialist = {
  name: NAME,
  state: STATE,
  systemPrompt: SYSTEM_PROMPT,
  promptVersion: getPromptVersion(),
  buildUserMessage,
  async run(ctx: SpecialistContext): Promise<SpecialistResult> {
    // 1. Cap gate. The cap is a soft fence per the metadata helper (best-
    //    effort writes), so we ALSO set error_state on Postgres so the
    //    orchestrator and the human triage queue agree on what happened.
    const capped = await isPrValidationCapped(ctx.pool, ctx.issue.id);
    if (capped) {
      ctx.logger.warn(
        {
          issueId: ctx.issue.id,
          issueIdentifier: ctx.issue.identifier,
          cap: PR_VALIDATION_ITERATION_CAP,
        },
        "pr-validation: iteration cap reached; escalating to Error (manual)",
      );
      // Mark the issue's error_state so /status + Slack lifecycle events can
      // surface why the issue is stuck. setErrorState is best-effort; a
      // failure here does not block the escalation outcome below.
      await setErrorState(ctx.pool, {
        issueId: ctx.issue.id,
        issueIdentifier: ctx.issue.identifier,
        state: STATE,
      });
      return {
        outcome: "Escalated",
        costUsd: 0,
        tokens: { input: 0, output: 0, total: 0 },
        model: null,
        error: `PR validation iteration cap (${PR_VALIDATION_ITERATION_CAP}) reached`,
        nextStateOverride: "Error (manual)",
        comment: [
          `**PR validation cap reached** — ${PR_VALIDATION_ITERATION_CAP} bounces have already been recorded for this sub.`,
          "",
          "Routing to `Error (manual)` for human triage. Common root causes:",
          "  - The local Claude Code agent can't address one of the review threads (re-read the unresolved comments).",
          "  - The PR is wired to a flaky CI run (check the failing run's history for past flakes).",
          "  - The Technical plan specialist's sub-issue scope was wrong (re-plan).",
        ].join("\n"),
        extra: {
          stage: "pr-validation",
          reason: "iteration_cap_reached",
          cap: PR_VALIDATION_ITERATION_CAP,
        },
      };
    }

    // 2. Pre-build the user message so consumers can verify it doesn't throw
    //    on missing sections — not strictly necessary on the stubbed path,
    //    but makes the stub a meaningful smoke test for the orchestrator.
    //    (Discarded; the real implementation will pass it to claudeAdapter.)
    const _userMessage = buildUserMessage(ctx);
    void _userMessage;

    // 3. Counter bump. recordSpecialistRun is best-effort; a failure here
    //    leaves the counter inconsistent but is not load-bearing for
    //    correctness — the cap re-checks via isPrValidationCapped on the
    //    next dispatch.
    await recordSpecialistRun(ctx.pool, {
      issueId: ctx.issue.id,
      issueIdentifier: ctx.issue.identifier,
      specialist: NAME,
      costUsdDelta: 0,
      iterationKey: "pr_validation",
    });

    ctx.logger.info(
      {
        issueId: ctx.issue.id,
        issueIdentifier: ctx.issue.identifier,
        stage: STATE,
      },
      "pr-validation: stubbed run complete (real CI/threads check lands in Phase 2.5)",
    );

    return {
      outcome: "Succeeded",
      costUsd: 0,
      tokens: { input: 0, output: 0, total: 0 },
      model: null,
      error: null,
      // No nextStateOverride from the stub — the orchestrator falls back to
      // its `state_transitions` table. The real implementation will set
      // `Release` (clean) or `Pull request` (dirty) explicitly.
      extra: {
        stage: "pr-validation",
        stub: true,
      },
    };
  },
};

export default prValidation;
