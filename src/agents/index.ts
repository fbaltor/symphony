/**
 * Specialist registry for the 16-state pipeline (see docs/adr/0010).
 *
 * Aggregates the four specialist modules and exposes a state→specialist
 * lookup. Lookup is case-insensitive on state name because Linear's API
 * occasionally returns mixed casing ("PR validation" / "PR Validation")
 * when the team picker auto-suggests a state — the orchestrator's
 * dispatcher always normalises before consulting this registry.
 *
 * The orchestrator uses `findSpecialist(issue.state)` at the very start of
 * `runWorker` to decide whether to drive the LLM with a specialist's
 * SYSTEM_PROMPT + buildUserMessage, or to fall back to the legacy
 * WORKFLOW.md template (`buildFullPrompt`). When the lookup
 * returns null, dispatch proceeds via the legacy template — so adding a
 * specialist is purely additive: existing states keep working, the new
 * state gets its dedicated agent.
 */
import prioritized from "./prioritized/index.js";
import technicalPlan from "./technical-plan/index.js";
import prValidation from "./pr-validation/index.js";
import release from "./release/index.js";
import type { Specialist } from "./types.js";

/**
 * The full set of specialists Symphony ships. Order is informational
 * only — `findSpecialist` does an `Array.find` with case-insensitive
 * match, so the iteration order doesn't affect correctness.
 */
export const SPECIALISTS: readonly Specialist[] = [
  prioritized,
  technicalPlan,
  prValidation,
  release,
];

/**
 * Resolve a Linear state name to the specialist that owns it, or null
 * when no specialist is registered for that state. Case-insensitive
 * comparison handles Linear's occasional mixed-case state names.
 */
export function findSpecialist(stateName: string): Specialist | null {
  const lower = stateName.toLowerCase();
  return SPECIALISTS.find((s) => s.state.toLowerCase() === lower) ?? null;
}
