/**
 * Technical plan specialist — module entry point.
 *
 * The orchestrator's specialist registry imports the default
 * export and dispatches it whenever an issue enters the Technical plan
 * Linear state.
 *
 * The actual LLM-driven decomposition (read parent sections, ground sub-issues
 * in real files, file children via Linear `issueCreate`, post the parent
 * summary comment) lives in a future commit. This module currently:
 *
 *   - Exposes the static SYSTEM_PROMPT + buildUserMessage so test, audit, and
 *     prompt-version tooling can introspect the agent's contract.
 *   - Stubs `run()` to bump the `plan_iteration` counter via
 *     recordSpecialistRun (so re-plan accounting is correct from day one)
 *     and return a Succeeded result with zero cost / zero tokens. The
 *     orchestrator's audit row still records the turn, just with empty
 *     deliverables.
 */

import { getPromptVersion, type Specialist, type SpecialistContext, type SpecialistResult } from "../types.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

const technicalPlanSpecialist: Specialist = {
  name: "technical-plan",
  state: "Technical plan",
  systemPrompt: SYSTEM_PROMPT,
  promptVersion: getPromptVersion(),
  buildUserMessage,
  async run(ctx: SpecialistContext): Promise<SpecialistResult> {
    // Bump plan_iteration even on the stub turn so re-plan accounting is
    // correct from day one. recordSpecialistRun is best-effort and swallows
    // its own errors.
    await ctx.store.recordSpecialistRun({
      issueId: ctx.issue.id,
      issueIdentifier: ctx.issue.identifier,
      specialist: "technical-plan",
      costUsdDelta: 0,
      iterationKey: "plan",
    });

    ctx.logger.info(
      { issueId: ctx.issue.id, identifier: ctx.issue.identifier },
      "technical-plan: stub run (no LLM call yet)",
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

export default technicalPlanSpecialist;
export { SYSTEM_PROMPT, buildUserMessage };
