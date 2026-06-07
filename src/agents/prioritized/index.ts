/**
 * Prioritized specialist module for the 16-state pipeline (see docs/adr/0010).
 *
 * Phase 2.5 will land the LLM-driven body of `run()`. For now, the run() is
 * a stub that bumps the `validation_iteration` counter via
 * `recordSpecialistRun()` and returns a Succeeded result with zero cost,
 * so the orchestrator's specialist registry has a real Specialist to
 * dispatch and the unit tests can verify wiring (prompt shape, user-message
 * assembly, counter increment).
 *
 * The full Phase 2.5 implementation will:
 *   1. Build the user message via `buildUserMessage(ctx)`
 *   2. Drive the Claude Agent SDK with SYSTEM_PROMPT + the user message
 *   3. Parse the model's response (managed-section markdown blocks)
 *   4. Write the deliverables via `updateSection()` so re-prioritize runs
 *      update the existing Goals/Context/Questions in-place
 *   5. Record cost / token usage via `recordSpecialistRun(..., "validation")`
 *
 * The orchestrator handles auto-advance Prioritized → Questions (manual)
 * after a Succeeded turn — the specialist itself MUST NOT call
 * `tracker.update_issue` to change the state.
 */

import {
  type Specialist,
  type SpecialistContext,
  type SpecialistResult,
  getPromptVersion,
} from "../types.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

/**
 * Slug used in audit + logs. Kebab-case to match the other specialists
 * (technical-plan, pr-validation, release).
 */
export const NAME = "prioritized" as const;

/**
 * Linear state this specialist owns. Must match WORKFLOW.md
 * `tracker.active_states` and the `state_transitions` map's source state.
 */
export const STATE = "Prioritized" as const;

const prioritized: Specialist = {
  name: NAME,
  state: STATE,
  systemPrompt: SYSTEM_PROMPT,
  promptVersion: getPromptVersion(),
  buildUserMessage,
  /**
   * Phase 2 stub — bumps `validation_iteration` and returns Succeeded so
   * the orchestrator's downstream auto-advance (Prioritized → Questions
   * (manual)) fires correctly during the wiring tests. Phase 2.5 replaces
   * this body with the real LLM-driven implementation.
   */
  async run(ctx: SpecialistContext): Promise<SpecialistResult> {
    await ctx.store.recordSpecialistRun({
      issueId: ctx.issue.id,
      issueIdentifier: ctx.issue.identifier,
      specialist: NAME,
      costUsdDelta: 0,
      iterationKey: "validation",
    });

    ctx.logger.info(
      { issueId: ctx.issue.id, identifier: ctx.issue.identifier, state: STATE },
      "prioritized specialist stub completed (Phase 2.5 will replace with real LLM call)",
    );

    return {
      outcome: "Succeeded",
      costUsd: 0,
      tokens: { input: 0, output: 0, total: 0 },
      model: null,
      error: null,
    };
  },
};

export default prioritized;
