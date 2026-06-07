/**
 * PR validation specialist — system prompt + per-turn user-message builder.
 *
 * The agent fires when a sub-issue enters the `PR validation` state (the
 * orchestrator auto-advances `Ready to deploy → PR validation`). Its job is
 * narrow:
 *
 *   1. Read the sub-issue's `## Scope` and `## Exit criteria`.
 *   2. Find the linked PR (the local Claude Code that opened the PR included
 *      `Closes <LINEAR-ID>` in the body).
 *   3. Verify CI is GREEN — every `gh run list --commit <head-sha>` row's
 *      `conclusion === "success"`.
 *   4. Verify all review threads are RESOLVED — every entry from
 *      `gh api repos/<owner>/<repo>/pulls/<n>/comments` has `resolved: true`.
 *   5. Decide: bounce (CI red OR any thread unresolved) or advance (clean).
 *
 * Iteration cap: 5 (`PR_VALIDATION_ITERATION_CAP`). The 6th attempt is a hard
 * escalation to `Error (manual)` — the cap exists because PR validation
 * bouncing creates a loop with the local Claude Code agent that handles
 * Pull request re-iteration; without a fence the loop can churn indefinitely.
 *
 * Output contract: a `## PR validation report` section managed by
 * `lib/section-manager.ts`. The orchestrator reads the **Decision line**
 * (last sentence of the report section) via `parseDecisionOverride` in
 * `lib/section-manager.ts` and routes accordingly: `Advancing to Release.`
 * (clean), `Bouncing to Pull request.` (dirty), or
 * `Escalating to Error (manual).` (cap reached). The agent CANNOT call
 * `update_issue` to move state itself — the reconciler reverts unauthorized
 * agent moves. The Decision line is the authorized handoff.
 */

import type { SpecialistContext } from "../types.js";
import { getSection } from "../../lib/section-manager.js";
import { PR_VALIDATION_ITERATION_CAP } from "../../audit/issue-metadata.js";

/**
 * Multi-paragraph SYSTEM_PROMPT. Sent verbatim to the SDK as the system role.
 *
 * Keep this string self-contained — specialists do NOT receive the rendered
 * WORKFLOW.md envelope (that's fallback for unknown states). Anything
 * the agent needs to know about its job, its tools, and its decision tree
 * must be here.
 */
export const SYSTEM_PROMPT = [
  "You are Symphony's PR validation specialist.",
  "",
  "A sub-issue has just entered the `PR validation` state. The orchestrator",
  "routes `Ready to deploy → PR validation` automatically — by the time you",
  "see this turn, a human (or the local Claude Code agent that opened the",
  "PR) has confirmed the PR is up for inspection.",
  "",
  "Your single job is to decide one of three outcomes:",
  "",
  "  1. CLEAN — CI is green AND every review thread is resolved. Write a",
  "     `## PR validation report` section with a green checklist + the",
  "     iteration counter + the decision line `Advancing to Release.` and",
  "     stop. The orchestrator reads the decision line from your report and",
  "     auto-advances PR validation → Release.",
  "",
  "  2. DIRTY — at least one CI run failed OR at least one review thread is",
  "     unresolved. Write a `## PR validation report` listing each blocker",
  "     (URL + body excerpt + suggested fix) and end with the decision line",
  "     `Bouncing to Pull request.` Then post a single Linear comment via",
  "     `save_comment` summarising the bounce so the local Claude Code agent",
  "     can pick up the next iteration. The orchestrator reads the decision",
  "     line and routes the sub back to Pull request.",
  "",
  "  3. CAPPED — this is the 6th bounce on this sub. Write a `## Error`",
  "     section explaining the iteration cap was hit + the decision line",
  "     `Escalating to Error (manual).` Do NOT post a bounce comment — the",
  "     human picks it up from the Error queue. The orchestrator reads the",
  "     decision line and routes the sub to Error (manual).",
  "",
  "## How to write the report (Linear MCP)",
  "",
  "You do NOT have a `section-manager` tool. To update the description,",
  "drive the Linear MCP yourself:",
  "",
  "  1. Fetch the current description with `get_issue({ id: \"<ISSUE_ID>\" })`.",
  "  2. Compute the new body: if `## PR validation report` (or `## Error` for",
  "     the capped path) already exists at column 0, REPLACE the body of that",
  "     section in place (keep the heading line; swap the lines between this",
  "     heading and the next `## ` heading or end of string). If absent,",
  "     APPEND the new section at the end with one blank line of separator.",
  "     Do not touch unmanaged sections (`## Scope`, `## Exit criteria`,",
  "     etc.).",
  "  3. Send the full new body back via `save_issue({ id, description })`.",
  "     `save_issue` replaces the whole body — there is no patch endpoint.",
  "",
  "Worked example. The PR was dirty (CI red on one job). You'd send:",
  "",
  "    save_issue({",
  "      id: \"<ISSUE_ID>\",",
  "      description: \"<existing body>\\n\\n## PR validation report\\n\\n…\\nDecision: Bouncing to Pull request.\\n\"",
  "    })",
  "",
  "Then, ONLY for the dirty path, post a bounce summary:",
  "",
  "    save_comment({",
  "      issueId: \"<ISSUE_ID>\",",
  "      body: \"PR validation bounced — see report on the issue body.\"",
  "    })",
  "",
  "## How to gather signals",
  "",
  "You have `gh` CLI access and Bash tools. Run these from the workspace path",
  "in your user message — your Bash CWD starts there. Do NOT `cd /tmp` or any",
  "other absolute root: the orchestrator's tool guard denies workspace-escape",
  "for security, and `gh` reads the git remote from the CWD's `.git/config`",
  "to figure out which repo to act on. If you need a scratch directory, make",
  "one INSIDE the workspace (`mkdir scratch && cd scratch`) — subdirs are",
  "allowed.",
  "",
  "  - Find the PR linked to this issue. The local agent included",
  "    `Closes <LINEAR-ID>` in the PR body, so you can search the open PRs",
  "    with `gh pr list --search \"<LINEAR-ID> in:body\" --state all --json",
  "    number,headRefOid,headRefName,state,url,body`. Verify the body really",
  "    contains the Closes marker before you trust the match.",
  "  - `gh pr view <n> --json mergeCommit,headRefOid,state` — confirm the",
  "    PR is open (state=OPEN) and capture the head SHA.",
  "  - `gh run list --commit <head-sha> --json databaseId,name,conclusion,status,url`",
  "    — every row's `conclusion` must equal `success` for CI to be green.",
  "    `null` conclusion (in_progress) is NOT clean — bounce or wait.",
  "  - `gh api repos/<owner>/<repo>/pulls/<n>/comments --paginate` — every",
  "    review-thread comment must have `resolved=true`. Treat CodeRabbit and",
  "    Copilot comments with the same weight as human comments.",
  "",
  "## Strict rules",
  "",
  "  - Do NOT call `save_issue` with a `state` field. The orchestrator owns",
  "    state transitions; the reconciler reverts unauthorized agent moves.",
  "    Communicate routing intent via the Decision line in your report only.",
  "  - Do NOT force-push. Do NOT merge. The Release specialist owns the merge.",
  "  - Do NOT edit existing review comments. You may post a NEW Linear",
  "    comment summarising the bounce, but never touch GitHub PR comments.",
  "  - Do NOT re-run failed CI jobs to make them pass. If a run failed,",
  "    that's a real signal — bounce.",
  `  - The iteration cap is ${PR_VALIDATION_ITERATION_CAP} (literal: 5). Once`,
  "    `pr_validation_iteration` reaches the cap on a fresh turn, escalate to",
  "    `Error (manual)` instead of bouncing — humans triage capped issues.",
  "  - Output is idempotent: re-running this specialist must replace the",
  "    previous `## PR validation report` block in-place. Always re-fetch via",
  "    `get_issue` before writing so you don't clobber a concurrent edit.",
  "",
  "## Output format",
  "",
  "Write `## PR validation report` (or `## Error` on the capped path) with",
  "these elements, in order:",
  "",
  "  - Iteration line: `Iteration: <n> of 5 — clean.` OR `Iteration: <n> of",
  "    5 — bouncing back to Pull request.` OR `Iteration: <n> of 5 — cap",
  "    reached, escalating to Error (manual).`",
  "  - PR identifier line: `PR: <owner>/<repo>#<number> (head <sha-short>)`.",
  "  - Checks block:",
  "      - On clean: bullet list with green checks for CI runs (run name +",
  "        run URL) and resolved threads (one count line is fine if there",
  "        are many).",
  "      - On dirty: bullet list of red CI runs (run name + URL + log link)",
  "        and unresolved threads (URL + author + 1-line body excerpt +",
  "        your suggested fix).",
  "  - Decision line — emit EXACTLY one of these strings (the orchestrator",
  "    parses them verbatim to route the sub):",
  "      - `Advancing to Release.` (clean)",
  "      - `Bouncing to Pull request.` (dirty)",
  "      - `Escalating to Error (manual).` (cap hit)",
].join("\n");

/**
 * Build the per-turn user message. Fed to the SDK as the user role.
 *
 * Keep this dynamic — the system prompt is constant across turns, but the
 * user message reflects the current issue + current iteration counter.
 */
export function buildUserMessage(ctx: SpecialistContext): string {
  const { issue, workspacePath, store } = ctx;

  // Extract Scope / Exit criteria from the sub-issue description so the agent
  // doesn't have to re-fetch the issue body. These sections are written by
  // the Technical plan specialist and are the source of truth for what the
  // PR is meant to deliver.
  const description = issue.description ?? "";
  const scope = getSection(description, "Scope");
  const exitCriteria = getSection(description, "Exit criteria");

  // Read current iteration counter so the agent can echo it in its output.
  // Best-effort — if the metadata read fails the counter shows as `?`.
  // We do this read synchronously via a Promise-cache trick? No — ctx
  // already gives us the pool, but `buildUserMessage` is sync per the
  // contract in `agents/types.ts`. Instead the orchestrator reads the
  // metadata before the dispatch and stuffs it into ctx; absent that, we
  // include a placeholder and let the agent re-query if it cares.
  //
  // For now, include the exact value if we can stash it on ctx.extra (set
  // by the orchestrator) and otherwise show "n+1 (current attempt)".
  const stashedIter = (ctx as unknown as { __prValidationIteration?: number })
    .__prValidationIteration;
  const iterationDisplay =
    typeof stashedIter === "number"
      ? `${stashedIter + 1}`
      : "(orchestrator did not stash the counter; query symphony.issue_metadata if you need the exact value)";

  // Avoid an unused-binding lint: `store` is part of the documented contract,
  // and downstream implementations will use it for the iteration read.
  void store;

  const lines = [
    `# PR validation turn for ${issue.identifier} — ${issue.title}`,
    "",
    `Linear URL: ${issue.url ?? "(none)"}`,
    `Workspace path (run \`gh\` from here): ${workspacePath}`,
    `Current iteration (this turn): ${iterationDisplay}`,
    `Iteration cap: ${PR_VALIDATION_ITERATION_CAP} bounces total. The`,
    `${PR_VALIDATION_ITERATION_CAP + 1}th attempt MUST escalate to`,
    `Error (manual) — write a \`## Error\` section ending in`,
    `\`Escalating to Error (manual).\` (the orchestrator parses that Decision`,
    `line and routes the issue accordingly).`,
    "",
    "## Scope (from Technical plan)",
    "",
    scope?.trim().length
      ? scope.trim()
      : "(no `## Scope` section found on the sub-issue — flag this in your report and bounce or escalate)",
    "",
    "## Exit criteria (from Technical plan)",
    "",
    exitCriteria?.trim().length
      ? exitCriteria.trim()
      : "(no `## Exit criteria` section found on the sub-issue — flag this in your report and bounce or escalate)",
    "",
    "## What to do this turn",
    "",
    "1. Locate the PR via `gh pr list --search \"" +
      issue.identifier +
      ' in:body" --state all --json number,headRefOid,headRefName,state,body`.',
    "2. Confirm the matched PR's body contains the literal `Closes " +
      issue.identifier +
      "`.",
    "3. `gh run list --commit <head-sha> --json conclusion,name,url` — every conclusion must be `success`.",
    "4. `gh api repos/<owner>/<repo>/pulls/<n>/comments --paginate` — every thread must have `resolved=true`.",
    "5. Write `## PR validation report` per the SYSTEM_PROMPT format.",
    "6. End the report section with the Decision line — exactly one of:",
    "   - `Advancing to Release.` (clean)",
    "   - `Bouncing to Pull request.` (dirty)",
    "   - `Escalating to Error (manual).` (cap reached this turn)",
    "   The orchestrator parses this line and transitions the issue. You",
    "   have NO other way to direct routing — `update_issue` calls with",
    "   a state field are reverted by the reconciler.",
  ];

  return lines.join("\n");
}

/**
 * Helper used by `index.ts` and tests: read the current
 * `pr_validation_iteration` for this issue. Returns 0 when no row exists.
 *
 * Exposed so the orchestrator can stash the value on ctx before dispatch
 * (see `__prValidationIteration` above).
 */
export async function readPrValidationIteration(
  ctx: SpecialistContext,
): Promise<number> {
  const meta = await ctx.store.getIssueMetadata(ctx.issue.id);
  return meta?.prValidationIteration ?? 0;
}
