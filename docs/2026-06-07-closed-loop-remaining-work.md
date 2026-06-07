# Closed-loop autonomous implementation — remaining work

Status after the M3 milestone (autonomous `To implement → PR`, proven end-to-end
on `fbaltor/project-cars` PR #1). See README deviation #13 for the feature.

## Done

- **Path A dispatch** — `agent_dispatched_states` carve-out: a no-specialist
  state ("To implement") reaches `dispatch()` and runs the generic WORKFLOW
  template. (`classifyTickAction` in `src/orchestrator/dispatch.ts`.)
- **Clone hook** — `scripts/setup-workspace.sh`, token-in-URL auth (github.com
  git-over-HTTPS wants Basic, not Bearer); idempotent, non-destructive fetch.
- **GitHub auth** — `resolveGitHubToken`: GH App token, else `GITHUB_TOKEN` PAT;
  wired into the clone hook, GitHub MCP bearer, and PR-detection deliverable
  source.
- **Sub advance without the Linear GitHub integration** — `To implement →
  Pull request` via `state_transitions`, gated on `pr_required_states`.
- **Development cascade from a human gate** — `isFreshTransition` fix (fires when
  `prev` is undefined, i.e. parent came from a non-active gate). Commit
  `6e099ac`.
- **Usage rollup** — `GET /usage` (5h/24h/7d, per model). One Opus-`xhigh`
  implementation turn measured ~27k output tokens / ~$15 est.

## Remaining

1. **Linear webhooks (root unblocker).** `LINEAR_WEBHOOK_SECRET` is unset, so
   `/webhook/linear` returns 503 and Symphony runs purely on the poll loop. The
   poll loop cannot see transitions through non-active states, which leaves:
   - **Sub-Done watcher** — parent → "Validation (manual)" once all subs are
     Done. Needs webhooks (P2.6). Without it, a parent never auto-closes even
     after every sub PR merges.
   - **Cancel cascade** — parent → Canceled fan-out.
   To enable: register a Linear webhook at a reachable URL (a tunnel locally),
   set `LINEAR_WEBHOOK_SECRET`. The handler (`handleLinearWebhook`) already
   exists.

2. **Back half of the pipeline (PR validation → Release → Done).** The
   `pr-validation` and `release` specialists exist but are not in
   `active_states`, and the path is unproven in this deployment. Activating it
   also interacts with #1 (a merged PR won't auto-advance without the Linear
   integration or webhooks).

3. **First-turn completion.** Turn 1 of an implementation sometimes writes code
   but stops before commit/push (Opus 4.8 is more deliberate). Mitigated by the
   hard commit→push→PR checklist in `WORKFLOW.example.md` "Your task" (and the
   project's `WORKFLOW.md`), but unverified — confirm the next implementation
   lands in one turn.

4. **Guardrail caps are placeholders.** `daily 100 / per-issue 30 / To implement
   25` — runaway breakers on estimated cost, not tuned to real Opus-`high`
   spend.

5. **Per-state effort / model (deferred).** Effort + model are global. If you
   want `xhigh` only for "To implement" (and cheaper for the lighter states),
   add `*_by_state` plumbing (config field + thread through the adapter), mirror
   of `agent_dispatched_states`.
