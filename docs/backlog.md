# Backlog

Tracker-agnostic deferred work. Canonical source of truth — sync to whatever
issue tracker you use when ready. Items are grouped by category; labels are
informal tags for filtering.

Format per item:
```
- [ ] Title
  - _Why:_ ...
  - _Labels:_ ...
  - _File(s):_ ...
```

---

## Architecture

- [ ] Thread `github.branch_prefix` config into specialist prompts
  - _Why:_ Technical-plan and prioritized prompts hardcode `symphony/<id>` as
    the branch convention. Users who set a custom `github.branch_prefix` in
    WORKFLOW.md get inconsistent guidance — the runtime uses their prefix but
    the agent prompt still says `symphony/`. Fix: pass `branchPrefix` through
    `SpecialistContext` and inject it into the prompts at render time.
  - _Labels:_ architecture, ux
  - _File(s):_ `src/workflow/config.ts`, `src/agents/technical-plan/prompt.ts`,
    `src/agents/prioritized/prompt.ts`

- [ ] Complete the `IssueTracker` abstraction for specialists
  - _Why:_ `SpecialistContext.tracker` is `LinearTrackerClient`, not the
    `IssueTracker` interface, because specialists call Linear-specific methods
    (`createIssue`, `archiveIssue`, `resolveLabelIds`, `getTeamId`,
    `updateIssueDescription`) that have no generic equivalent yet. A second
    tracker implementation (GitHub Issues, Jira, etc.) would require either
    extending the interface or splitting specialist logic into tracker-specific
    adapters.
  - _Labels:_ architecture, tracker-agnostic
  - _File(s):_ `src/tracker/tracker.ts`, `src/agents/*/index.ts`

- [ ] Make `SYMPHONY_SELF_PATH_FRAGMENT` configurable
  - _Why:_ Currently hardcoded to `sep+independent+sep+symphony+sep` — a
    monorepo path that is a no-op in standalone deployments (the workspace
    being cloned is the user's repo, not a repo containing Symphony's source).
    Should be configurable via `agent.self_path_fragment` in WORKFLOW.md, or
    at minimum documented clearly as a monorepo-only guard.
  - _Labels:_ architecture, configuration
  - _File(s):_ `src/agent/can-use-tool.ts`

- [ ] Create `docs/TEST_TICKETS.md`
  - _Why:_ `src/orchestrator/sub-tickets.ts` references this file for the
    `[TEST]` / `[PROBE]` issue title prefix convention (marks issues that
    should suppress the `deliverable_missing` guard). The file was deleted
    during extraction. Either recreate it with the convention documented, or
    inline the explanation in `sub-tickets.ts` and remove the reference.
  - _Labels:_ docs, cleanup
  - _File(s):_ `src/orchestrator/sub-tickets.ts:186`

---

## Cleanup

- [ ] Rename `CEREBRO_LIFECYCLE_MARKER_PREFIX` → `LEGACY_LIFECYCLE_MARKER_PREFIX`
  - _Why:_ The constant name leaks the predecessor system's name into the
    public API. The constant VALUE (`<!-- cerebro:specialist=`) must stay the
    same for backwards compatibility with existing Linear comment history —
    only the identifier changes.
  - _Labels:_ cleanup, naming
  - _File(s):_ `src/lib/markers.ts:17` (export), all import sites

- [ ] Strip or replace `B-X` internal ticket refs from source comments
  - _Why:_ 32 instances of `B-2`, `B-6`, `B-8`, `B-9`, `B-12`, `B-13`,
    `B-14`, `B-15` remain in source comments. External contributors cannot
    look these up. Replace with inline explanations or remove.
  - _Labels:_ cleanup
  - _File(s):_ `src/orchestrator/orchestrator.ts`, `src/observability/slack.ts`,
    `src/agent/runner.ts`, `src/agent/claude-adapter.ts`, `src/workflow/config.ts`,
    `src/audit/writer.ts`, `src/lib/github.ts`, `src/lib/github-auth.ts`,
    `src/main.ts`

- [ ] Document or inline `AGENT-520` references in `instance-lock.ts`
  - _Why:_ 8 references to `AGENT-520` in comments explaining the cooperative
    handoff protocol. External contributors can't look up the ticket. Either
    add a brief protocol summary at the top of the file or replace each
    reference with the inline explanation.
  - _Labels:_ cleanup, docs
  - _File(s):_ `src/singleton/instance-lock.ts`

- [ ] Clean up `src/lib/markers.ts` legacy comment
  - _Why:_ Line 33 says "Mirrored across cerebro-v2 and the new symphony
    schema (see IMPROVEMENTS.md §8.2)" — both the predecessor system reference
    and the IMPROVEMENTS.md cross-reference are stale.
  - _Labels:_ cleanup
  - _File(s):_ `src/lib/markers.ts:33`

---

## Docs

- [ ] Write `docs/getting-started.md`
  - _Why:_ `docs/deploying.md` covers infrastructure but not the Linear
    configuration side: creating a team, setting up the 16 states, configuring
    `gitAutomationStateCreate` for PR/merge transitions, first WORKFLOW.md
    from the example. A new operator needs all of this before `docker compose up`
    produces anything meaningful.
  - _Labels:_ docs, onboarding

- [ ] Write `CONTRIBUTING.md`
  - _Why:_ No contribution guide exists. Minimum needed: dev setup
    (`npm install`, `npm run dev`, Postgres), test conventions (Vitest,
    `COVERAGE-DEBT` marker contract), PR expectations (draft PRs, specialist
    prompt changes need test updates).
  - _Labels:_ docs, onboarding

---

## Testing

- [ ] End-to-end smoke test against a real stack
  - _Why:_ All tests are unit/conformance. No test exercises the full path:
    WORKFLOW.md → Linear webhook → orchestrator dispatch → Claude agent turn →
    Linear state transition. Required before declaring the extraction stable
    enough for external users.
  - _Labels:_ testing, validation
  - _Scope:_ real Linear workspace + Anthropic key + GitHub repo + local
    Docker Compose (`docker compose up --build`)
