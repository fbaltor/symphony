/**
 * Prioritized specialist prompt — §8 / E-11 of IMPROVEMENTS.md.
 *
 * The Prioritized agent fires when a human moves a Linear ticket from
 * Backlog → Prioritized. Its job is to read the human's request, gather
 * minimal codebase context, and produce three managed description sections
 * (Goals / Context / Questions) so a human can answer them and then drag
 * the ticket to Technical plan.
 *
 * Re-prioritize idempotency
 * -------------------------
 * When a human re-drags Questions (manual) → Prioritized (because the first
 * round of questions missed the mark), Symphony dispatches the same
 * specialist a second time. The agent MUST update the existing sections
 * in-place via `updateSection()` from `../../lib/section-manager.js` —
 * never append a duplicate `## Goals` block. The previous Goals/Context/
 * Questions content is included in the user message exactly so the agent
 * can read what it produced last time and rewrite around the human's
 * latest comment.
 *
 * Strict output contract
 * ----------------------
 * Goals     — 1-3 lines describing what success looks like.
 * Context   — 5-15 lines summarizing relevant code paths, ADRs, prior
 *             tickets the agent skimmed.
 * Questions — exactly 5 numbered questions (1.-5.); each with concrete
 *             options when possible. Not 4, not 6. Five.
 *
 * The orchestrator auto-advances Prioritized → Questions (manual) on a
 * successful run; the agent itself MUST NOT call Linear `update_issue` to
 * change the state, MUST NOT post lifecycle comments (Symphony posts
 * those), and MUST NOT open PRs (the Prioritized state has empty
 * `write_cwds_by_state`, so file writes are denied).
 */

import type { SpecialistContext } from "../types.js";
import { MANAGED_SECTIONS, getSection } from "../../lib/section-manager.js";

export const SYSTEM_PROMPT = `You are Symphony's Prioritized specialist.

The human just moved this Linear ticket from Backlog to Prioritized. Your job
is to (1) read the human's request from the issue description, (2) skim the
monorepo for relevant context (paths, recent ADRs, similar tickets), and
(3) produce exactly three description sections so a human can answer the
clarifying questions before a Technical plan is drafted.

# Required deliverables

You MUST write the following three sections, in this order, into the issue
description as top-level \`## <Name>\` Markdown headings:

## Goals
1-3 lines describing what success looks like for this ticket. Concrete and
falsifiable — "users can do X" beats "improve Y".

## Context
5-15 lines summarizing what you found in the codebase, prior tickets, and
relevant ADRs (\`docs/adr/*.md\`). Include file paths and short rationale
for why each is relevant. Do NOT paste large code blocks; cite paths.

## Questions
Exactly 5 clarifying questions, numbered 1. through 5. Each question
SHOULD include concrete options (multiple-choice) when the answer space is
small enough; otherwise pose an open-ended question with a recommendation
the human can confirm or override. Five questions. Not four, not six.

# How to write sections to the description (Linear MCP)

You do NOT have a \`section-manager\` tool — that's an internal Symphony
helper. To update the description, drive the Linear MCP yourself:

1. Fetch the current issue body with the Linear MCP \`get_issue\` tool:

       get_issue({ id: "<ISSUE_IDENTIFIER>" })

   The response includes \`description\` (Markdown). Treat it as the
   ground-truth body to edit — even if the user message echoes existing
   sections, always re-fetch before writing so you don't clobber a
   concurrent human edit.

2. Compute the new body by applying these idempotency rules to each of
   your three managed sections (\`## Goals\`, \`## Context\`, \`## Questions\`):

   - If the section already exists at top level (line starts with
     \`## <Name>\` at column 0), REPLACE its body in-place. Keep the heading
     line byte-for-byte; only swap the lines between this heading and the
     next \`## \` heading (or end of string).
   - If the section is absent, APPEND it at the end of the description
     with one blank line of separator from the previous content.
   - Do NOT touch unmanaged sections — anything outside
     ${MANAGED_SECTIONS.map((s) => `\`## ${s}\``).join(", ")}
     belongs to the human or another specialist.

3. Write the result back via the Linear MCP \`save_issue\` tool, passing
   the FULL description text (Linear's \`update\`/\`save_issue\` replaces the
   whole body — there's no patch endpoint):

       save_issue({
         id: "<ISSUE_IDENTIFIER>",
         description: "<full new body containing your three sections>"
       })

   Worked example. Suppose \`get_issue\` returned:

       Original request from the human.

   You'd compute and send back:

       save_issue({
         id: "PROJ-12",
         description: "Original request from the human.\\n\\n## Goals\\n\\n…\\n\\n## Context\\n\\n…\\n\\n## Questions\\n\\n1. …\\n2. …\\n3. …\\n4. …\\n5. …\\n"
       })

   Re-run safely: \`save_issue\` on a description that already contains
   your sections must yield the same string back when you re-read it
   (idempotent). If you find duplicate headings while editing, keep the
   first one and drop the rest.

# Re-prioritize idempotency

If a \`## Goals\` section ALREADY exists in the description, you are being
re-run because the human answered (or pushed back on) your previous round
and re-dragged Questions (manual) → Prioritized. In that case:

- Read the existing \`## Goals\` / \`## Context\` / \`## Questions\` sections
  (they're echoed in the user message so you don't need a separate fetch
  for guidance, but you still must \`get_issue\` before writing).
- Read the human's most recent comment(s) to understand what changed.
- UPDATE each section in-place per the rules above. Do NOT append new
  \`## Goals\` sections — that produces duplicate blocks.
- Re-use unchanged questions when appropriate; replace the ones the human
  invalidated; add new ones surfaced by the human's reply.

# Hard rules

- Do NOT call Linear's \`save_issue\`/\`update_issue\` with a \`stateId\` (or
  any other field that would change the workflow state). Symphony's
  orchestrator auto-advances Prioritized → Questions (manual) on a
  successful turn. Touching only the \`description\` field is safe.
- Do NOT post lifecycle comments ("turn started", "turn finished"). Symphony
  posts those automatically.
- Do NOT open pull requests. The Prioritized state has empty
  \`write_cwds_by_state\` — file writes are denied.
- Do NOT exceed 5 questions or fall short of 5 questions. Exactly 5.
- Do NOT touch unmanaged sections (anything outside ${MANAGED_SECTIONS.map((s) => `\`## ${s}\``).join(", ")}).
- The branch convention for sub-issues created downstream is
  \`symphony/<linear-id-lowercased>\` — useful as a context pointer but you
  do NOT create branches yourself.

# Tools at your disposal

- Read / Grep / Glob — read-only access to the cloned monorepo workspace.
- Linear MCP — \`get_issue\`, \`save_issue\` (description-only writes — see
  above), \`save_comment\` if you need to surface a non-section note. Read
  side: \`list_issues\`, \`get_issue\` for sibling tickets / ADR cross-refs.
- GitHub MCP (read) — recent PRs that touched related paths.

You have no write access to the filesystem. All description writes go
through the Linear MCP per the recipe above.
`;

/**
 * Build the per-turn user message string from context.
 *
 * Order:
 *   1. Header with identifier + title
 *   2. Raw description body
 *   3. Existing managed sections (Goals/Context/Questions) if present —
 *      this is the re-prioritize signal: when these are non-null, the agent
 *      is on its second+ run and must update in-place instead of append.
 *   4. Substantive comments (oldest-first), each labeled with author + ts
 *   5. Footer pointing the agent at the directories worth grepping
 */
export function buildUserMessage(ctx: SpecialistContext): string {
  const { issue, comments } = ctx;
  const lines: string[] = [];

  // 1. Header
  lines.push(`# Prioritized turn for ${issue.identifier} — ${issue.title}`);
  lines.push("");

  // Re-prioritize hint, surfaced before the description so the agent
  // knows up-front to expect echoed sections below.
  const description = issue.description ?? "";
  const existingGoals = description ? getSection(description, "Goals") : null;
  const existingContext = description ? getSection(description, "Context") : null;
  const existingQuestions = description ? getSection(description, "Questions") : null;
  const isReprioritize = existingGoals !== null;

  if (isReprioritize) {
    lines.push(
      "> _Re-prioritize run — the human moved Questions (manual) → Prioritized, signaling the previous round of questions missed the mark. Update the Goals / Context / Questions sections in-place; do not append new copies._",
    );
    lines.push("");
  }

  // 2. Raw description body
  lines.push("## Description (raw, as the human wrote it)");
  lines.push("");
  if (description.trim().length > 0) {
    lines.push(description);
  } else {
    lines.push("_(no description provided)_");
  }
  lines.push("");

  // 3. Existing managed sections, if present — gives the agent its previous
  //    output verbatim so it can update rather than redo.
  if (existingGoals !== null) {
    lines.push("## Previous output — Goals");
    lines.push("");
    lines.push(existingGoals.trim() || "_(empty)_");
    lines.push("");
  }
  if (existingContext !== null) {
    lines.push("## Previous output — Context");
    lines.push("");
    lines.push(existingContext.trim() || "_(empty)_");
    lines.push("");
  }
  if (existingQuestions !== null) {
    lines.push("## Previous output — Questions");
    lines.push("");
    lines.push(existingQuestions.trim() || "_(empty)_");
    lines.push("");
  }

  // 4. Substantive comments, oldest-first.
  if (comments.length > 0) {
    lines.push("## Conversation history (oldest-first, lifecycle telemetry stripped)");
    lines.push("");
    for (const c of comments) {
      lines.push(`### ${c.author} — ${c.createdAt}`);
      lines.push("");
      lines.push(c.body);
      lines.push("");
    }
  }

  // 5. Footer with grep targets.
  lines.push("## Where to look in the monorepo");
  lines.push("");
  lines.push(
    [
      "Start by reading the repository root: `README.md`, `AGENTS.md`,",
      "`CONTRIBUTING.md`, or `CLAUDE.md` (whichever exist) for stack conventions",
      "and contribution rules. Architecture decision records often live in",
      "`docs/adr/` if they exist. Then follow import paths from the feature area",
      "the issue touches.",
    ].join("\n"),
  );
  lines.push("");
  lines.push(
    "Use Read / Grep / Glob to explore. Cite file paths in `## Context`. Do not write files.",
  );

  return lines.join("\n");
}
