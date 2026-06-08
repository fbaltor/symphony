# Architecture & current status

A consolidated view of how Symphony is built and **what it can do today**. For
the per-decision depth, follow the ADR links (`docs/adr/`). For commands and the
day-to-day workflow, see [`operating.md`](operating.md). The module map + ASCII
topology live in the [README](../README.md#architecture).

---

## 1. What Symphony is

A single-instance, long-running Node daemon that turns a **Linear board into the
control surface** for an autonomous engineering pipeline. It implements the
[OpenAI Symphony Service Spec](upstream-spec.md), extended with a 16-state
pipeline (ADR [0010](adr/0010-16-state-pipeline.md)). You steer entirely from
Linear — drag a card, write a comment; Symphony dispatches AI specialists, runs
the coding agent, enforces gates, and records everything.

Two execution models share the same machinery:
- **Coordinator (spec default):** the human pastes each sub-issue's prompt into
  local Claude Code.
- **Closed-loop (Path A):** Symphony dispatches implementation itself — writes
  the code and opens the PR. Opt in via `tracker.agent_dispatched_states`
  (README deviation #13).

---

## 2. The core loop

```
poll Linear (30s)  ──▶  for each eligible issue:
  reconcile (revert unauthorized agent moves; honor human moves)
  detectAndFireCascades  (parent → Development fans out drafted subs)
  classifyTickAction(issue):
    ├─ dispatch        → run a turn  (specialist OR generic WORKFLOW envelope)
    ├─ transition_only → auto-advance, no turn  (e.g. Ready to deploy → PR validation)
    └─ cascade_only    → visited only for the cascade  (e.g. Development)
  on a dispatched turn:
    AgentRunner (Claude adapter) → MCP tools, canUseTool guard, cost caps
    on success → auto-advance via state_transitions (gated by pr_required_states)
    write run_audit row
```

Webhooks (`POST /webhook/linear`, HMAC-verified) drive the same cascades in
real time when configured; otherwise the 30s poll is the only trigger.

**Routing predicates** (`src/orchestrator/dispatch.ts`, unit-tested):
- `classifyTickAction` — a no-specialist state runs the generic template **only**
  if it's listed in `agent_dispatched_states` (the closed-loop carve-out);
  otherwise it's cascade-only or transition-only and no turn runs.
- `isFreshTransition` — fires a cascade when a parent is freshly observed in the
  trigger state, **including** arriving from a non-active human gate
  (`prev` undefined) — the fix for "Plan review → Development" cascades.

---

## 3. Pipeline & specialists

16 states across Discovery → Planning → Cascade → Implementation → Validation →
Shipping (see the README table). Two kinds of work run on a state:

- **Specialist states** — a registered module with its own system prompt
  (`src/agents/`): `prioritized` ("Prioritized"), `technical-plan`
  ("Technical plan"), `pr-validation` ("PR validation"), `release` ("Release").
  `findSpecialist(state)` maps a Linear state → module.
- **Agent-dispatched states** — no specialist; run the generic `WORKFLOW.md`
  template envelope (the implementation turn, "To implement").

**Cascades** (`src/orchestrator/cascade.ts`) move *sub-issues* in bulk, not via an
LLM turn: Development (drafted subs → To implement), Cancel (parent canceled →
cancel subs), Sub-Done watcher (all subs Done → parent → Validation).

---

## 4. Key seams (pluggable interfaces)

The spec's ports + Symphony's own are interfaces with swappable implementations,
selected by one composition root `buildDeps(cfg)` (`src/deps.ts`) keyed on
`tracker.kind`:

| Interface | Real | Test/dev |
|---|---|---|
| `IssueTracker` | Linear GraphQL | `MemoryTracker` |
| `AgentRunner` | Claude adapter (`claude`) | `FakeAgentRunner` (`fake`, scripted, zero-LLM) |
| `DeliverableSource` | GitHub (branch/PR detection) | `MemoryDeliverableSource` |
| `*Store` (metadata/audit/budget) | Postgres | in-memory |
| `InstanceLock` | `pg_try_advisory_lock` | simulated + injectable `Clock` |

`tracker.kind: memory` + `agentRuntime.runtime: fake` runs the **whole pipeline
in one process** with no Linear/Postgres/GitHub/LLM
(`tests/integration/e2e-memory-flow.test.ts`).

---

## 5. Safety & control (all load-bearing)

- **`canUseTool` guard** (ADR [0017](adr/0017-capability-matrix-and-can-use-tool.md)) — denies dangerous bash (sudo/curl/wget/nc/ssh/rm-rf-root/forkbomb), confines Edit/Write to the per-issue workspace, blocks edits to Symphony's own source, and enforces `write_cwds_by_state`.
- **Cost caps** (ADR [0012](adr/0012-cost-guardrails.md)) — daily / per-issue / per-state, mid-turn abort. On the OAuth subscription these fire on the SDK's *estimated* cost — runaway breakers, not billing.
- **Reconciler** (ADR [0020](adr/0020-reconciler-unauthorized-move-revert.md)) — reverts unauthorized agent state moves into human-review gates; human moves always win.
- **Deliverable gate** (ADR [0019](adr/0019-deliverable-gate.md)) — `pr_required_states` blocks a "success" from advancing unless a real branch/PR exists.
- **Kill-switch** (ADR [0018](adr/0018-operator-kill-switch.md)) — `POST /admin/kill-switch?op=engage` halts dispatch + drains.
- **Single instance** (ADR [0011](adr/0011-single-instance-advisory-lock.md)) — pg advisory lock + heartbeat/lease; deploy `--max-instances=1`.
- **Webhook HMAC** (ADR [0015](adr/0015-webhook-ingress-security.md)) + **secret redaction** (ADR [0016](adr/0016-outbound-write-secret-redaction.md)).
- The **PR is the human review gate** — the closed loop ends at an open PR; you review/merge.

---

## 6. Auth & persistence

- **Claude:** Claude Code subscription via `CLAUDE_CODE_OAUTH_TOKEN` (no API key),
  resolved from env by `@anthropic-ai/claude-agent-sdk`. Model + effort from
  `agent_runtime` (currently Opus 4.8 / `high`).
- **GitHub:** `resolveGitHubToken` — a GitHub App installation token, else a
  `GITHUB_TOKEN` PAT — used for the clone hook, the GitHub MCP bearer, and PR
  detection.
- **Postgres tables:** `run_audit`, `budget_state`, `issue_metadata`,
  `instance_lock` (+ `_handoff`), `kill_switch`, `review_gate_state`,
  `slack_thread`, `running_runs`, `issue_state_actor`, `webhook_dedup`.
- **Observability:** pino structured logs; `GET /health|/status|/cost|/usage`
  (open) + token-gated `/admin/*`; optional Slack thread cards.

---

## 7. Current status — what works today

Proven end-to-end (2026-06-07, on `fbaltor/project-cars`):

| Capability | Status |
|---|---|
| Prioritized question loop (5 clarifying Qs) | ✅ proven |
| Technical plan decomposition (clones repo, grounds in code, files subs) | ✅ proven |
| **Closed-loop implementation** (To implement → clone → code → push → PR → "Pull request") | ✅ proven (PR #1) |
| Development cascade from a human gate (`isFreshTransition`) | ✅ fixed + unit-tested |
| OAuth-subscription auth (Opus 4.8) | ✅ |
| GitHub PAT-or-App auth + token-in-URL clone | ✅ |
| Cost caps + `canUseTool` + reconciler + kill-switch | ✅ |
| `/usage` token+cost rollup | ✅ |
| Test suite | ✅ 545 passing |

### Not yet wired / unproven (see [`2026-06-07-closed-loop-remaining-work.md`](2026-06-07-closed-loop-remaining-work.md))

| Gap | Impact |
|---|---|
| **Linear webhooks** (`LINEAR_WEBHOOK_SECRET` unset) | Poll-only; the **Sub-Done watcher** (parent → Validation) and **Cancel cascade** can't see transitions through non-active states → dormant. A parent won't auto-close after its sub PRs merge. |
| **Back half** (PR validation → Release → Done) | The `pr-validation` + `release` specialists exist but aren't in `active_states`; the path is unproven in this deployment. |
| **First-turn completion** | An implementation turn occasionally writes code but stops before commit/push (Opus 4.8 is deliberate). Mitigated by the template's hard commit→push→PR checklist; unverified. |
| **Per-state effort/model** | Global only; no `*_by_state` knob (would mirror `agent_dispatched_states`). |
| **Guardrail caps** | Placeholder values, not tuned to real Opus-`high` spend. |
