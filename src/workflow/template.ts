import { Liquid } from "liquidjs";
import type { Issue } from "../types.js";

/**
 * Spec §5.4 — strict prompt rendering.
 *
 *  - Unknown variables MUST fail rendering.
 *  - Unknown filters MUST fail rendering.
 *  - Input variables: `issue` (full normalized record) + `attempt` (null on
 *    first attempt, integer ≥1 on retry).
 */

export type TemplateErrorCode = "template_parse_error" | "template_render_error";

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;
  constructor(code: TemplateErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "TemplateError";
  }
}

export interface TemplateInput {
  issue: Issue;
  attempt: number | null;
  /**
   * Optional Linear comment history (oldest-first) for the active issue.
   * The WORKFLOW.md template can render `{% if comments and comments.size > 0 %}`
   * to give the agent prior-stage context (Refinement's Requirements,
   * Plan's RFC, etc.).
   */
  comments?: Array<{ createdAt: string; body: string; author: string }>;
}

const engine = new Liquid({
  strictFilters: true,
  strictVariables: true,
  greedy: false,
  cache: false,
});

export async function renderPrompt(template: string, input: TemplateInput): Promise<string> {
  let parsed;
  try {
    parsed = engine.parse(template);
  } catch (err) {
    throw new TemplateError("template_parse_error", (err as Error).message);
  }
  try {
    return await engine.render(parsed, {
      issue: input.issue as unknown as Record<string, unknown>,
      attempt: input.attempt,
      comments: input.comments ?? [],
    });
  } catch (err) {
    throw new TemplateError("template_render_error", (err as Error).message);
  }
}

// Continuation prompts (spec §10.2) live in `agent/prompt.ts` — see
// `buildContinuationGuidance`. The orchestrator uses that helper directly.
