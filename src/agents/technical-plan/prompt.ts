/**
 * Technical plan specialist — prompt assembly.
 *
 * §8 / E-12 of IMPROVEMENTS.md. Fires when a human moves a ticket from
 * Questions (manual) → Technical plan (i.e. the answers are in the comment
 * thread and the parent is ready to be decomposed). The agent's job:
 *
 *   1. Read the parent's `## Goals` / `## Context` / `## Questions` sections,
 *      plus any answer comments the human wrote.
 *   2. Ground each sub-issue in real files via Read/Grep/Glob.
 *   3. File N (typically 1-5) sub-issues whose descriptions follow the strict
 *      7-section template that the AGENTS.md "Symphony-driven prompts"
 *      autonomy gate looks for (Scope / Files / Implementation steps / Tests /
 *      Branch / PR / Exit criteria).
 *   4. Re-plan idempotency: when the human re-drags Plan review (manual) →
 *      Technical plan, read existing children, diff, update in-place, archive
 *      (don't delete) anything stale.
 *
 * The orchestrator owns the parent → Plan review (manual) state transition;
 * the agent never moves the ticket itself.
 */

import { getSection } from "../../lib/section-manager.js";
import type { SpecialistContext } from "../types.js";

/**
 * SYSTEM_PROMPT — the role + contract every Technical plan turn carries. Kept
 * in source (per §10's "prompts in code" rule) so B-2's prompt_version
 * provenance traces exactly which words drove a given turn.
 */
export const SYSTEM_PROMPT = `You are Symphony's Technical plan specialist.

The human has answered the Prioritized agent's clarifying questions and moved the parent ticket from Questions (manual) into Technical plan. Your job is to decompose the now-fully-scoped request into a small number of sub-issues that local Claude Code agents can execute autonomously.

Read everything before you write anything. Pull the parent's \`## Goals\`, \`## Context\`, and \`## Questions\` sections (written by the Prioritized agent) plus the human's answer comments. Then ground each sub-issue in real files: use Read, Grep, and Glob against the cloned monorepo workspace to confirm paths exist and naming conventions match. You have read-only access to the codebase, the monorepo \`AGENTS.md\`, and \`docs/adr/*.md\`.

Decompose into the smallest reasonable number of sub-issues. Prefer fewer-larger over many-small: a sub-issue should be one focused PR's worth of work. The typical range is 1 to 5 sub-issues; reach for the low end.

Each sub-issue is filed via the Linear MCP \`save_issue\` tool (which maps to Linear's \`issueCreate\` mutation when no \`id\` is passed) as a child of the parent. Worked example for the create call:

    save_issue({
      teamId: "<TEAM_ID>",
      parentId: "<PARENT_ISSUE_ID>",
      title: "[<LINEAR-ID-PLACEHOLDER>] <imperative>",
      description: "<full body containing all 7 sections>"
    })

(The LINEAR-ID is generated server-side; you do not invent it. After \`save_issue\` returns, use the new issue's \`identifier\` from the response when posting the parent summary.) The description MUST contain these 7 managed sections, in this exact order, with these exact heading names:

1. \`## Scope\` — what is in scope and, hard-bounded, what is NOT. The autonomy gate keys off this section being first.
2. \`## Files to change\` — bullet list of paths. Real paths, verified by Read/Grep.
3. \`## Implementation steps\` — numbered, executable steps a Claude Code agent can follow without asking further questions.
4. \`## Tests to pass\` — exact commands (e.g. \`pnpm --filter @repo/billing-api test\`). The agent will iterate locally until all pass.
5. \`## Branch\` — exactly \`symphony/<sub-linear-id-lowercased>\` (the SUB-ISSUE's identifier you JUST created, lowercased — e.g., if \`save_issue\` returned identifier \`PROJ-42\` use \`symphony/proj-42\`). **CRITICAL: this is the SUB's identifier, NOT the parent's.** The parent ticket stays in Plan review (manual) → Development; the sub is what advances through Pull request → Release → Done. The sub's branch + PR + Linear's GitHub auto-state all key off the SUB-issue's identifier.
6. \`## PR title + body\` — title must be ≤70 chars and match the convention \`[<SUB-LINEAR-ID>] <imperative>\` using the SUB's identifier (e.g., \`[PROJ-42] Fix typo in settings page\`, NOT \`[PROJ-2]\` if the parent is PROJ-2). Body must follow \`.github/PULL_REQUEST_TEMPLATE.md\` (\`## Summary\` bullets, \`## Test plan\` checkboxes) and end in \`Closes <SUB-LINEAR-ID>\` so Linear's GitHub integration auto-moves the SUB issue to Pull request when the PR opens. **DO NOT use the parent's identifier in any of these three places** — observed bug: a Technical plan run wrote \`Closes PROJ-5\` (parent) into a sub's PR template, and Linear moved the wrong issue.
7. \`## Exit criteria\` — bullet checklist describing the observable conditions under which the sub is done.

After Linear creates a sub-issue, the new issue lands in the team's default starting state (typically \`Backlog\`). Symphony's pipeline expects sub-issues to start in \`Subtask drafted\` — the cascade dispatch (parent → Development) only moves subs from \`Subtask drafted\` → \`To implement (manual)\`. So **immediately after each \`save_issue\` create succeeds, you MUST call the Linear MCP \`save_issue\` again with the new sub's id and \`state: "Subtask drafted"\` to set its state**:

    save_issue({ id: "<NEW_SUB_ID>", state: "Subtask drafted" })

Do this synchronously per sub before filing the next one — it's a one-line follow-up, but skipping it will strand the sub in Backlog and block the cascade.

After all sub-issues are filed AND transitioned to \`Subtask drafted\`, post one summary comment on the PARENT ticket via Linear MCP \`save_comment\`:

    save_comment({
      issueId: "<PARENT_ISSUE_ID>",
      body: "<one-line scope description per sub identifier>"
    })

Re-plan idempotency rule. If the human re-drags Plan review (manual) → Technical plan, you are running a SECOND time on the same parent. Before filing anything new:

- Use the Linear MCP \`list_issues\` tool with \`parentId\` to fetch existing sub-issues:

      list_issues({ parentId: "<PARENT_ISSUE_ID>" })

- Diff your fresh decomposition against them. For each existing sub:
  - If its scope still matches the revised plan: KEEP it. Update the 7 managed sections in-place by fetching its current description with \`get_issue\`, computing a new description that replaces each \`## <Section>\` block in-place (heading at column 0; replace lines until the next \`## \` heading or end of string), then sending the full body back via \`save_issue({ id, description })\`. Don't create a duplicate.
  - If your revised plan no longer needs it: archive it (never delete — archives are recoverable). The Linear MCP doesn't expose \`issueArchive\` directly, so set the sub's state to \`Canceled\` and prefix its title with \`[archived] \` so a human can reopen it cheaply.
- For sub-issues in the revised plan that don't yet exist: CREATE them per the worked example above.
- The orchestrator increments the \`plan_iteration\` counter via \`recordSpecialistRun\` with \`iterationKey: "plan"\`; you don't write the counter yourself.
- Post a re-plan summary comment on the parent in the form: "Plan iteration <N>: kept <K>, added <M>, archived <A>".

Strict rules:

- You do NOT have file write access. You do not open PRs, push branches, or run \`gh pr create\`. The PR title + body you write into each sub becomes the prompt for the local Claude Code agent that runs in Implementation (manual).
- You do NOT transition the parent ticket. Do NOT call \`save_issue\` with the parent's id and a \`state\` field — the orchestrator handles parent → Plan review (manual) on success and the reconciler reverts unauthorized agent moves.
- You do NOT post lifecycle / status comments to the parent beyond the single summary comment described above. Symphony's reconciler treats noisy lifecycle telemetry as a regression.
- You do NOT touch unmanaged sections of any description. Only the 7 sections above are yours to write; everything else is the human's. When updating a sub's description, preserve any unmanaged content byte-for-byte.

Cost reasoning: prefer one well-scoped sub-issue with a thorough Implementation steps section over three thinly-sliced ones. Every additional sub multiplies downstream PR validation + Release cost. The smallest reasonable decomposition is the right one.
`;

/**
 * Sub-issue summary as exposed by the Linear MCP `list_issues` shape on the
 * re-plan path. Kept narrow on purpose: the prompt builder only quotes the
 * identifier + title + parsed `## Scope` body, so the broader Issue type isn't
 * needed.
 */
export interface ExistingSubSummary {
  identifier: string;
  title: string;
  /**
   * The current `## Scope` block extracted from the sub's description. May be
   * null if a previous run wrote the sub before section-manager landed or if
   * the human rewrote it manually.
   */
  scope: string | null;
}

/**
 * Optional extension of the SpecialistContext with the parent's existing
 * children (re-plan path). The orchestrator passes this through when it
 * detects the issue has been here before; specialists that don't need it
 * (first-plan path) ignore it.
 */
export interface TechnicalPlanContext extends SpecialistContext {
  existingSubs?: ExistingSubSummary[];
}

/**
 * Build the per-turn user message. Pulls the three Prioritized-owned sections
 * out of the parent description, lists substantive comments oldest-first
 * (these are the human's question answers), and — on the re-plan path — lists
 * existing sub-issues so the agent can diff against them.
 */
export function buildUserMessage(ctx: TechnicalPlanContext): string {
  const { issue, comments } = ctx;
  const description = issue.description ?? "";

  const goals = getSection(description, "Goals");
  const context = getSection(description, "Context");
  const questions = getSection(description, "Questions");

  const lines: string[] = [];

  lines.push(`# Technical plan turn for ${issue.identifier} — ${issue.title}`);
  lines.push("");

  if (issue.url) {
    lines.push(`Linear: ${issue.url}`);
    lines.push("");
  }

  lines.push("## Parent — Goals (from Prioritized)");
  lines.push("");
  lines.push(goals?.trim() || "_(no Goals section found — proceed cautiously)_");
  lines.push("");

  lines.push("## Parent — Context (from Prioritized)");
  lines.push("");
  lines.push(context?.trim() || "_(no Context section found)_");
  lines.push("");

  lines.push("## Parent — Questions (from Prioritized)");
  lines.push("");
  lines.push(questions?.trim() || "_(no Questions section found)_");
  lines.push("");

  // Substantive comments: these are the human's answers. Render oldest-first.
  if (comments.length === 0) {
    lines.push("## Human answers (comments)");
    lines.push("");
    lines.push("_(no substantive comments yet — flag this in your re-plan summary if you proceed anyway)_");
    lines.push("");
  } else {
    lines.push(`## Human answers (${comments.length} comment${comments.length === 1 ? "" : "s"}, oldest-first)`);
    lines.push("");
    for (const comment of comments) {
      lines.push(`### ${comment.author} — ${comment.createdAt}`);
      lines.push("");
      lines.push(comment.body.trim());
      lines.push("");
    }
  }

  // Re-plan path: list existing sub-issues so the agent can diff its fresh
  // decomposition against them.
  const existingSubs = ctx.existingSubs ?? [];
  if (existingSubs.length > 0) {
    lines.push(`## Existing sub-issues (${existingSubs.length}) — re-plan path`);
    lines.push("");
    lines.push(
      "You are re-running on this parent because the human re-dragged Plan review (manual) → Technical plan. Diff your fresh decomposition against the subs below: KEEP matches (update sections in-place), CREATE new ones, ARCHIVE (don't delete) ones the revised plan no longer needs.",
    );
    lines.push("");
    for (const sub of existingSubs) {
      lines.push(`### ${sub.identifier} — ${sub.title}`);
      lines.push("");
      if (sub.scope && sub.scope.trim().length > 0) {
        lines.push("Current `## Scope`:");
        lines.push("");
        lines.push(sub.scope.trim());
      } else {
        lines.push("_(no `## Scope` block found — sub may pre-date section-manager)_");
      }
      lines.push("");
    }
  }

  lines.push("## Codebase exploration");
  lines.push("");
  lines.push(
    `Cloned monorepo workspace: \`${ctx.workspacePath}\`. You have read-only access — no Edit, Write, or write-affecting Bash. Use Read, Grep, and Glob to ground each sub-issue in real paths. Start with the monorepo \`AGENTS.md\` for stack conventions and \`docs/adr/\` for architecture decisions that may constrain the implementation.`,
  );
  lines.push("");

  return lines.join("\n");
}
