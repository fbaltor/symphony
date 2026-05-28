import type pg from "pg";
import type { Issue } from "../types.js";
import { renderPrompt } from "../workflow/template.js";
import { findSpecialist } from "../agents/index.js";
import type { LinearTrackerClient } from "../tracker/linear.js";
import { logger } from "../observability/logger.js";

/**
 * Spec §10.2 — prompt construction. The first turn renders the full task
 * prompt from the WORKFLOW.md template. Continuation turns send only short
 * continuation guidance.
 *
 * §8 / E-10..E-15: when an issue is in a state owned by a specialist
 * (Prioritized / Technical plan / PR validation / Release), the orchestrator
 * drives the LLM with the specialist's SYSTEM_PROMPT + buildUserMessage
 * instead of the WORKFLOW.staging.md template envelope. The
 * `buildSpecialistPrompt` helper below performs the lookup and assembles the
 * final string; `runWorker` calls it first and falls back to
 * `buildFullPrompt` only when no specialist is registered for the issue's
 * state.
 */

export interface PromptComment {
  createdAt: string;
  body: string;
  author: string;
}

export async function buildFullPrompt(args: {
  template: string;
  issue: Issue;
  attempt: number | null;
  /**
   * Prior comments on the issue, oldest-first. Optional — when provided,
   * the WORKFLOW.md template can render them under a "Conversation history"
   * section so each stage's agent has the previous stage's deliverables
   * (Refinement → Requirements, Plan → RFC, etc.) without having to
   * re-discover them via the Linear MCP.
   */
  comments?: PromptComment[];
}): Promise<string> {
  return renderPrompt(args.template, {
    issue: args.issue,
    attempt: args.attempt,
    comments: args.comments ?? [],
  });
}

export function buildContinuationGuidance(issue: Issue, turnIndex: number): string {
  return [
    `Continuing work on ${issue.identifier} — ${issue.title}.`,
    `This is turn ${turnIndex + 1}. Issue is still in state "${issue.state}".`,
    "Pick up where you left off; do not re-read the original task description.",
  ].join("\n");
}

/**
 * Build a first-turn prompt for a specialist-owned state, or return null
 * when no specialist is registered for the issue's current state.
 *
 * The specialists' `buildUserMessage(ctx)` operates over a fully-populated
 * `SpecialistContext`, but at prompt-build time most fields aren't yet
 * meaningful (the worker hasn't started its session, no AbortController is
 * the LLM's, etc.). Specialists only read `issue` + `comments` (and in the
 * PR validation case a `__prValidationIteration` stash) during prompt
 * construction, so we synthesize a minimal context with stub values for the
 * unused fields. The pool + tracker are passed through verbatim so a
 * future change that needs synchronous access (e.g. metadata read) doesn't
 * have to plumb args through `runWorker`.
 *
 * Returns the rendered string `SYSTEM_PROMPT + "\n\n---\n\n" + userMessage`,
 * which `runWorker` feeds to the SDK as the first turn's prompt. The "---"
 * delimiter is purely cosmetic — the SDK collapses it into the prompt body
 * but it makes the audit logs easier to read.
 */
export async function buildSpecialistPrompt(args: {
  state: string;
  issue: Issue;
  attempt: number | null;
  comments: PromptComment[];
  pool: pg.Pool;
  tracker: LinearTrackerClient;
  /**
   * The real cloned-monorepo workspace path the agent will run in. This gets
   * inlined into the user message — e.g. Technical plan's prompt tells the
   * agent "Cloned monorepo workspace: `${workspacePath}`. You have read-only
   * access" and PR validation's prompt instructs the agent to run `gh` from
   * that directory. Passing `/tmp` (the previous default) caused the agent
   * to attempt `cd /tmp` and run `gh` outside the repo, which the tool guard
   * denies.
   *
   * Surfaced 2026-05-07 by Copilot review on PR #684.
   */
  workspacePath: string;
}): Promise<string | null> {
  const specialist = findSpecialist(args.state);
  if (!specialist) return null;

  // Synthesize a SpecialistContext from the worker-provided workspacePath.
  // The pool / tracker / abortController fields exist on the context type
  // but aren't read by buildUserMessage (only by specialist.run() later);
  // they're plumbed for type-shape parity with the run-time context.
  const ctx = {
    issue: args.issue,
    comments: args.comments,
    pool: args.pool,
    tracker: args.tracker,
    workspacePath: args.workspacePath,
    logger: {
      info: (obj: object, msg: string) => logger.info(obj, msg),
      warn: (obj: object, msg: string) => logger.warn(obj, msg),
      error: (obj: object, msg: string) => logger.error(obj, msg),
      debug: (obj: object, msg: string) => logger.debug(obj, msg),
    },
    abortController: new AbortController(),
  };

  const userMessage = specialist.buildUserMessage(ctx);
  return `${specialist.systemPrompt}\n\n---\n\n${userMessage}`;
}
