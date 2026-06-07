# AGENTS.md — rulebook for work inside the Symphony repository

**Every rule in this file is a hard rule.** Before your first tool call on any new task in this repo, re-read the relevant sections and confirm which rules apply.

## What Symphony is

Symphony is an autonomous orchestrator implementing the **16-state pipeline** — Backlog → Prioritized → Questions (manual) → Technical plan → Plan review (manual) → Development → Subtask drafted → To implement (manual) → Implementation (manual) → Pull request → Ready to deploy → PR validation → Release → Done (plus Error and Validation manual states) — by dispatching per-state specialist agents (Prioritized, Technical plan, PR validation, Release) plus three cascade modules (Development cascade, Cancel cascade, Sub-Done watcher).

The canonical references:

- [`docs/adr/`](docs/adr/) — architecture decisions: the 16-state pipeline (`0010`), single-instance lock, cost caps, audit/cache, Slack, webhook ingress, redaction, capability matrix, kill-switch, deliverable gate, reconciler, build provenance, prompts-in-code (`0011`–`0022`).
- [`docs/design-notes.md`](docs/design-notes.md) — smaller design decisions not warranting a full ADR.
- [`WORKFLOW.example.md`](WORKFLOW.example.md) — annotated 16-state config template.
- [`README.md`](README.md) — service overview, layout, deviations from the OpenAI Symphony spec.

## Self-edit lock

Symphony cannot edit itself from inside its own pipeline. The bash-guard denies `Edit`/`Write`/`MultiEdit` on paths inside the Symphony workspace. If a Symphony specialist agent needs to fix a Symphony bug, it surfaces a model-visible message redirecting to a separate ticket + manual PR.

This applies to autonomous Symphony specialist runs only. Local Claude Code instances are not subject to the self-edit lock.

## Recognition rule for Symphony-driven prompts

A Linear sub-issue prompt is Symphony-driven if and only if its body contains all four of these `##` headings:

- `## Scope`
- `## Branch`
- `## PR title + body`
- `## Exit criteria`

When you (a local Claude Code) detect this, you operate **autonomously**:

1. Skip the `## Scope definition` AskUserQuestion gate. The prompt's `## Scope` IS the answer.
2. Task file lives at `tasks/symphony-<linear-id>-<slug>.md`, pre-filled from the prompt.
3. Use the `## Branch` value — typically `symphony/<linear-id-lowercased>`. Do NOT use a default branch naming convention.
4. Implement per `## Implementation steps`.
5. Run all `## Tests to pass`. Iterate up to 3 times locally on failure.
6. Open the PR with EXACT `## PR title` + body. Body MUST include `Closes <LINEAR-ID>`.
7. Wait 5 minutes for automated review bots (CodeRabbit, Copilot, etc.).
8. Read all unresolved review threads via `gh api repos/<owner>/<repo>/pulls/<n>/comments`.
9. For each thread: agree → fix + reply with commit SHA + RESOLVE; disagree → reply with reasoning + RESOLVE.
10. Push fix-up commits, watch CI, iterate up to 3 cycles.
11. Stop when (a) all CI green, (b) all threads RESOLVED, (c) no more changes.

What you do NOT do:

- **Do not move the Linear ticket.** Linear's GitHub auto-state moves the sub from "Implementation (manual)" → "Pull request" on push, then → "Done" on merge.
- **Do not post lifecycle comments** ("starting work", "turn 2"). Symphony posts those.
- **Do not invoke `AskUserQuestion`** for clarifications. Use `## Goals` and `## Scope` as your spec.
- **Do not deviate from the branch convention.** PR validation looks for `symphony/<linear-id-lowercased>` exactly.

If a Symphony prompt is missing one of the four signal headings, treat it as NOT Symphony-driven and follow the default `## Scope definition` flow.

## Branch + PR conventions

- **Branch**: `symphony/<linear-id-lowercased>` (e.g., `symphony/proj-42`). The prefix matches `github.branch_prefix` in your `WORKFLOW.md`; the default is `symphony`.
- **Commit message**: `[<LINEAR-ID>] <imperative>` for the main commit. Housekeeping commits (no issue) use conventional-commit style (`chore:`, `fix:`, `feat:`).
- **PR title**: EXACT value from `## PR title + body`. Do not paraphrase, shorten, or "improve" it.
- **PR body**: EXACT value from `## PR title + body`. Must include `Closes <LINEAR-ID>` so Linear's GitHub integration moves the issue.

## Bot review loop hygiene

- Automated review bots (CodeRabbit, Copilot, etc.) re-flag the same patterns on every push regardless of resolution. If you've already addressed a comment, **reply once with the commit SHA that landed the fix and move on** — do not chase the same comment across iterations.
- Use `gh api -X POST repos/<owner>/<repo>/pulls/<pr>/comments/<comment-id>/replies -f body='...'` to thread the reply directly under the original.
- 3-iteration cap: after 3 push-watch-iterate cycles, stop. The PR is either ready or blocked on a real disagreement that needs human resolution.

## Cost discipline

- **`dailyCapUsd`** — total spend today across all tickets. Set in `WORKFLOW.md`. Bump via `/admin/reload` after editing the file; do not redeploy for a cap bump.
- **`perIssueCapUsd`** — total cumulative spend on a single issue across all specialists + re-runs.
- **`perStateCapUsd`** — per-specialist cap. Each specialist's mid-turn streaming abort fires when its cap is breached.

When adding a new specialist or bumping a model: update the per-state cap in `WORKFLOW.md` to reflect the new expected cost. Don't ship without a $/ticket projection.

## Model defaults

- **Opus 4.7 for every specialist** with `thinking: { type: "adaptive", effort: <low|medium|high|max> }`. Never use `budget_tokens` — older API; 400s on Opus 4.7+.
- **Streaming + prompt caching** on every API call. `cache_control: { type: "ephemeral" }` on the stable prefix. Verify `usage.cache_read_input_tokens > 0` after the first call.
- **Stable prefix rule**: `tools → system → messages`. Volatile content (issue ID, timestamp, current state) goes AFTER the last `cache_control` breakpoint.

## Pipeline invariants

These must hold across every change to the state router, any specialist, or any cascade module:

1. **Backlog is dormant.** No agent runs until a human moves a ticket to Prioritized.
2. **Manual gates are sacred.** The reconciler reverts unauthorized agent moves to/from Questions (manual), Plan review (manual), To implement (manual), Implementation (manual), Pull request, Validation (manual), Error (manual). Human moves are always honored.
3. **Cascade is parent-driven.** Sub-issues only move via the parent's Development cascade (subs → To implement) or Cancel cascade (parent → Canceled cancels non-terminal subs) or Sub-Done watcher (all subs Done → parent → Validation (manual)).
4. **`Closes <LINEAR-ID>` is load-bearing.** Linear's native GitHub integration uses it to correlate the PR with the issue. Removing it from a sub's PR body breaks the auto-state move from Implementation (manual) → Pull request.
5. **The reconciler is the safety net.** If a webhook is missed (HMAC mismatch, ingress lockdown, dedup bug), the 30s poll-tick picks up state changes within 30s. Webhooks are an optimization, not a hard dependency.
6. **Specialists are stateless.** Per-issue counters live in `symphony.issue_metadata` (Postgres). Specialists read + write via `src/audit/issue-metadata.ts` accessor; they do not maintain in-memory state across runs.

## Deployment

- Always deploy with `--max-instances=1` (or equivalent): the cooperative singleton-handoff design assumes one instance at a time.
- Schema migrations must be backward-compatible because a deployment rollback does NOT roll back schema.
- See [`docs/deploying.md`](docs/deploying.md) for Docker Compose and Cloud Run quickstart guides.

## Doc updates

When you change pipeline behavior:

- Update `WORKFLOW.example.md` if the 16-state config shape changed.
- Update [`docs/adr/0010-16-state-pipeline.md`](docs/adr/0010-16-state-pipeline.md) if you're making an architectural decision.
- Update [`README.md`](README.md) if the high-level pipeline shape or service entry points changed.
