# ADR-0010: 16-state Linear pipeline with prompt-in-code specialists

## Status

Accepted.

## Context

An earlier 8-state pipeline conflated several concerns into single states:

- "Plan" did context-gathering, question-asking, AND technical decomposition in one turn — burning $5–10 per ticket on a single Opus run that often produced unfocused prompts.
- "Implement" expected the agent to write code AND open a PR AND self-review. The agent shipped from inside the service container, which lacked the developer's local toolchain.
- "Code review (manual)" relied on a single human checking what the agent did — automated reviews from bots (CodeRabbit, Copilot) were ignored.

Four root causes:

1. The agent did the wrong work because it had no structured context-gathering phase.
2. The PR shipped from a container that lacked the human's local toolchain.
3. Bot review threads landed on the PR but no specialist was assigned to read them and respond.
4. The pipeline had no parent/child decomposition primitive, so a single feature ticket couldn't be split into reviewable pieces.

The 16-state schema was designed to fix all four by separating concerns into distinct, individually-dispatchable states.

## Decision

### 1. Lock the 16-state pipeline as the canonical Symphony pipeline

| #   | State                       | Owner               | Action / next step                                                                                                                                    |
| --- | --------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Backlog**                 | nobody              | landing for new tickets                                                                                                                               |
| 2   | **Prioritized**             | **agent**           | reads MCPs + GitHub repo; writes `## Goals` / `## Context` / `## Questions` (5 by default) into description; → Questions (manual)                     |
| 3   | **Questions (manual)**      | human               | answers Qs in comments; → Technical plan                                                                                                              |
| 4   | **Technical plan**          | **agent**           | creates / updates / archives sub-issues (re-plan diff); each sub gets full prompt template in description; → Plan review (manual)                     |
| 5   | **Plan review (manual)**    | human               | reviews parent + subs; if changes → Technical plan; if green → Development                                                                            |
| 6   | **Subtask drafted**         | nobody (parking)    | sub-issues sit here when created by Technical plan agent; wait for parent's Development cascade                                                       |
| 7   | **Development**             | **agent (cascade)** | parent-only entry; cascades all `Subtask drafted` subs → To implement (manual); parent waits in Development                                           |
| 8   | **To implement (manual)**   | human               | per sub-issue: human picks one, → Implementation (manual)                                                                                             |
| 9   | **Implementation (manual)** | human               | human pastes the sub's prompt into local Claude Code; PR opened auto-links via Linear native GitHub integration; sub auto-→ Pull request              |
| 10  | **Pull request**            | human               | human verifies PR is good, → Ready to deploy                                                                                                          |
| 11  | **Ready to deploy**         | **agent**           | re-routing state; orchestrator immediately moves → PR validation                                                                                      |
| 12  | **PR validation**           | **agent**           | reads PR + diff; checks ALL threads RESOLVED + CI green; if issues → Pull request with comment; if good → Release                                     |
| 13  | **Release**                 | **agent**           | re-checks CI green on PR head; squash-merges; watches post-merge CI on `main`; if green → Done; if main-CI red → Error (manual)                       |
| 14  | **Validation (manual)**     | human               | parent-only entry; auto-arrives when ALL subs reach Done; human end-to-end checks the feature; → Done                                                 |
| 15  | **Done**                    | terminal            | sub-issues end here directly; parent reaches here from Validation (manual)                                                                            |
| 16  | **Error (manual)**          | parking             | any agent failure parks here with `## Error` description section + Slack alert; human triages, comments, re-drags into the appropriate state to retry |

`Canceled` and `Duplicate` are Linear's built-in default states used as human-initiated abort sinks.

### 2. Back per-issue state with Postgres `symphony.issue_metadata`

Linear's GraphQL API does not expose user-defined per-issue custom fields via the public API. Decision: back the 7 iteration/cost/state fields with a Postgres table `symphony.issue_metadata`, primary-keyed on `issue_id`:

```sql
CREATE TABLE symphony.issue_metadata (
    issue_id                 TEXT        PRIMARY KEY,
    issue_identifier         TEXT        NOT NULL,
    validation_iteration     INTEGER     NOT NULL DEFAULT 0,
    questions_answered       BOOLEAN     NOT NULL DEFAULT FALSE,
    plan_iteration           INTEGER     NOT NULL DEFAULT 0,
    pr_validation_iteration  INTEGER     NOT NULL DEFAULT 0,
    error_state              TEXT,
    cost_usd                 NUMERIC(10, 4) NOT NULL DEFAULT 0,
    last_specialist          TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

These values are not human-visible in Linear. Each specialist echoes its iteration counter inline in the description block it owns (e.g., `## PR validation report` opens with `Iteration: 3 of 5`). The Release agent embeds final cost on success.

The accessor module is `src/audit/issue-metadata.ts`.

### 3. Prompt-in-code per specialist (NOT WORKFLOW.md Liquid templates)

Each of the four LLM-driven states gets a self-contained module under `src/agents/<state-slug>/`:

```
src/agents/
├── prioritized/
│   ├── prompt.ts          # SYSTEM_PROMPT + buildUserMessage(...)
│   └── index.ts           # specialist registry entry
├── technical-plan/
├── pr-validation/
└── release/
src/agents/index.ts        # specialist registry (exports all four)
```

Each module exports `SYSTEM_PROMPT`, `buildUserMessage(args)`, and a `prompt_version` (the build-time git SHA). The orchestrator's `buildSpecialistPrompt(state, ...)` routes the live state to the corresponding specialist module.

Git-versioned prompts integrate cleanly with `prompt_version` in `symphony.run_audit` for cost-attribution and A/B-comparison. `WORKFLOW.example.md` becomes the canonical state-machine + tracker config only.

### 4. Auto-advance + parseDecisionOverride wiring

Symphony's `state_transitions` map auto-advances on `outcome=Succeeded`. For the two specialists that can branch (PR validation: bounce-or-release; Release: success-or-Error), the specialist writes a Decision line into the issue description. The orchestrator's `parseDecisionOverride` reads it and overrides the static `state_transitions` value:

- PR validation writes `Bouncing to Pull request.` if any thread is unresolved or any CI run is non-success.
- Release writes `Escalating to Error (manual).` if post-merge `main` CI goes red.

`parseDecisionOverride` is wired in `src/lib/section-manager.ts` and called in `orchestrator.ts` after each `runTurn` completion.

### 5. Cooperative Linear GitHub auto-state config

Linear's native GitHub integration is per-team. The 16-state pipeline relies on:

- **`start` event → "Pull request"**: when the GitHub App detects a push to a branch matching `<linear-id>`, Linear moves the linked sub from "Implementation (manual)" → "Pull request". Wire via `gitAutomationStateCreate` for your team.
- **`merge` event → "Done"**: when the PR merges, Linear moves the sub → "Done". Same wiring.

Symphony writes `Closes <LINEAR-ID>` into the PR body so Linear's GitHub App can correlate the PR with the issue. This is documented in `AGENTS.md` "Symphony-driven prompts" rule.

### 6. Public ingress + HMAC as primary defense

HMAC-SHA256 + ±60s freshness window + DeliveryId dedupe is the standard primary defense for webhook receivers.

The HMAC verifier in `src/webhook/linear-receiver.ts` validates `Linear-Signature` against `LINEAR_WEBHOOK_SECRET` before any side effects, with DeliveryId dedupe via `symphony.webhook_dedup` (24h TTL row cleanup). Admin routes (`/admin/reload`, `/admin/kill-switch`) are gated by `SYMPHONY_ADMIN_TOKEN`.

### 7. Cooperative singleton-lock-handoff via `--max-instances=1`

The pipeline assumes a single running instance. The cooperative-handoff logic in `src/singleton/instance-lock.ts` (15s lease, 5s heartbeat) handles the case where a deployment rolls a revision and the new instance must wait for the old instance's lease to expire.

Always deploy with `--max-instances=1` (or equivalent). Without it, two instances briefly running simultaneously will both attempt to claim the singleton lock.

## Consequences

### Positive
- Specialist concerns are separated: each is individually testable and cap-able.
- Per-state cost caps work cleanly because each state maps to a single specialist with a known prompt shape.
- Bot-review threads (CodeRabbit, Copilot) are first-class — PR validation reads them and either bounces or advances.
- The local Claude Code Implementation phase moves heavy lifting out of the service container and into the human's local toolchain.
- Postgres-backed `symphony.issue_metadata` is faster to query than parsing description blocks on every poll tick.

### Negative
- More moving parts: 16 states + 4 specialist modules + 3 cascade modules + section-manager + parseDecisionOverride + webhook receiver.
- The pipeline assumes a human is reachable for the manual gates. Async overnight cycles park at manual gates indefinitely. Mitigation: the Slack lifecycle observer posts on every state transition.
- `symphony.issue_metadata` values are invisible in the Linear UI. Mitigated by in-description iteration-counter echoes.
- The HMAC defense depends on `LINEAR_WEBHOOK_SECRET` rotation discipline.
- The cooperative auto-state config requires per-team setup on Linear.

## Related

- `WORKFLOW.example.md` — canonical 16-state config template.
- `AGENTS.md` — "Symphony-driven prompts" recognition rule for local Claude Code agents.
- `src/agents/` — the four specialist modules.
- `src/orchestrator/cascade.ts` — Development, Cancel, and Sub-Done cascade logic.
