/**
 * Release specialist module for the 16-state pipeline (see docs/adr/0010).
 *
 * Exports a default `Specialist` object that the orchestrator's specialist
 * registry resolves by state name ("Release"). For now, `run()` is stubbed:
 * it records cost (zero) + last_specialist via `recordSpecialistRun` with
 * `iterationKey: null` so issue_metadata stays consistent, then returns a
 * Succeeded result without a state override. The default state_transitions
 * mapping (Release → Done) takes over from there.
 *
 * The full `run()` implementation will:
 *   1. Build the user message via buildUserMessage(ctx).
 *   2. Drive the LLM through claudeAdapter.
 *   3. Parse the response, extract the merge outcome.
 *   4. Write `## Release report` (green) or `## Error` (red) into the
 *      sub-issue's description via section-manager.
 *   5. On red main: call setErrorState(pool, { state: "Release" }) and
 *      return SpecialistResult with `nextStateOverride: "Error (manual)"`.
 *   6. Always call `recordSpecialistRun(..., iterationKey: null)` — Release
 *      is terminal and does NOT bump any per-stage iteration counter.
 */

import {
  getPromptVersion,
  type Specialist,
  type SpecialistContext,
  type SpecialistResult,
} from "../types.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

export const RELEASE_SPECIALIST_NAME = "release";
export const RELEASE_STATE = "Release";

/**
 * Stubbed `run()`: records the bookkeeping side-effects so audit + cost
 * accounting stay consistent on a real-flow turn, but performs no LLM work.
 *
 * Returns Succeeded with all-zero counters and no `nextStateOverride`. The
 * orchestrator falls back to `state_transitions["Release"] = "Done"` and
 * advances the issue. When the full implementation lands, the LLM-driven
 * decision branch (green vs red main) will set `nextStateOverride` only on
 * the red path.
 */
async function runStub(ctx: SpecialistContext): Promise<SpecialistResult> {
  const { issue, store, logger } = ctx;

  await store.recordSpecialistRun({
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    specialist: RELEASE_SPECIALIST_NAME,
    costUsdDelta: 0,
    // Release is terminal-ish; never bumps a per-stage iteration counter.
    iterationKey: null,
  });

  logger.info(
    { issueId: issue.id, identifier: issue.identifier },
    "release specialist stub invoked — no LLM call",
  );

  return {
    outcome: "Succeeded",
    costUsd: 0,
    tokens: { input: 0, output: 0, total: 0 },
    model: null,
    error: null,
  };
}

const specialist: Specialist = {
  name: RELEASE_SPECIALIST_NAME,
  state: RELEASE_STATE,
  systemPrompt: SYSTEM_PROMPT,
  promptVersion: getPromptVersion(),
  buildUserMessage,
  run: runStub,
};

export default specialist;
