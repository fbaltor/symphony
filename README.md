# @symphony/core

[![Node](https://img.shields.io/badge/node-22-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Long-running Node.js daemon implementing the [OpenAI Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md), extended with a **16-state Linear pipeline** that decomposes feature work into reviewable sub-issues with copy-pasteable prompts for local Claude Code agents.

Polls a Linear team, dispatches per-state specialist agents (Prioritized, Technical plan, PR validation, Release), and cascades parent/child state transitions.

## How it works

Symphony turns your Linear board into an autonomous engineering pipeline:

1. A human moves a ticket to **Prioritized** — Symphony asks 5 clarifying questions.
2. The human answers in comments — Symphony decomposes the ticket into sub-issues with full implementation prompts.
3. The human reviews the plan and moves subs to **To implement (manual)**.
4. The human pastes each sub's prompt into **local Claude Code** — the agent writes code, runs tests, opens a PR.
5. The human confirms the PR is ready — Symphony validates CI, resolves review threads, squash-merges, and marks the sub Done.

The heavy lifting (running tests, opening PRs, iterating on bot reviews) happens in the human's local toolchain — Symphony handles the coordination, routing, and gating.

## 16-state pipeline

| Phase | States | Owner |
| --- | --- | --- |
| Discovery | Backlog → **Prioritized** → Questions (manual) | agent + human |
| Planning | **Technical plan** → Plan review (manual) | agent + human |
| Cascade | **Development** → Subtask drafted / To implement (manual) | cascade |
| Implementation | Implementation (manual) → Pull request | human (local Claude Code) |
| Validation | Ready to deploy → **PR validation** | agent |
| Shipping | **Release** → Done | agent |
| Parent close | Validation (manual) → Done | cascade + human |
| Failure sink | Error (manual) | human triages, re-drags |

**Bold** states dispatch a specialist agent. See [`docs/adr/0010-16-state-pipeline.md`](docs/adr/0010-16-state-pipeline.md) for the full design rationale.

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│  Symphony daemon (max=1 instance)                            │
│                                                              │
│  ┌──────────────┐    ┌───────────────────┐    ┌──────────┐  │
│  │ workflow/    │◄──►│ orchestrator/     │◄───┤ webhook/ │  │
│  │ loader+watch │    │  poll tick        │    │ HMAC+    │  │
│  └──────────────┘    │  retry queue      │    │ dedup+   │  │
│                      │  reconciliation   │    │ cascade  │  │
│  ┌──────────────┐    │  cascade/         │    └──────────┘  │
│  │ tracker/     │◄──►│   (Dev/Cancel/    │                  │
│  │ Linear GQL   │    │    Sub-Done)      │                  │
│  └──────────────┘    └────────┬──────────┘                  │
│                               ▼                             │
│  ┌──────────────┐    ┌───────────────────┐                  │
│  │ agents/      │    │ workspace/        │  /tmp/           │
│  │ prioritized  │    │ ensure dir        │  symphony-       │
│  │ technical-   │    │ run hooks         │  workspaces/     │
│  │  plan        │    └────────┬──────────┘  ├── PROJ-1/     │
│  │ pr-          │             ▼             └── PROJ-2/     │
│  │  validation  │    ┌───────────────────┐                  │
│  │ release      │◄──►│ agent/            │                  │
│  └──────────────┘    │  Claude adapter   │                  │
│                      │  MCP servers      │                  │
│  ┌──────────────┐    └───────────────────┘                  │
│  │ guardrails/  │                                           │
│  │ cost caps    │    ┌───────────────────┐    ┌──────────┐  │
│  └──────────────┘    │ singleton/        │    │ observ./ │  │
│                      │  pg advisory lock │    │ pino+    │  │
│  ┌──────────────┐    └───────────────────┘    │ slack    │  │
│  │ audit/       │                             └──────────┘  │
│  │ run_audit    │                                           │
│  │ issue_meta   │                                           │
│  │ webhook_ddp  │                                           │
│  └──────────────┘                                           │
└──────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   Linear GraphQL       Linear webhook        Postgres
   (30s poll)           (HMAC, real-time)     (audit, budget,
                                               lock, dedup,
                                               issue_metadata)
```

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/main.ts` | CLI entry; argv parse; daemon bootstrap |
| `src/orchestrator/` | Poll tick, retry queue, reconciliation ([spec §7](docs/upstream-spec.md#7-orchestration-state-machine), [§8](docs/upstream-spec.md#8-polling-scheduling-and-reconciliation)) |
| `src/orchestrator/cascade.ts` | Development, Cancel, Sub-Done cascade modules |
| `src/agents/` | Per-state specialist modules — `prioritized/`, `technical-plan/`, `pr-validation/`, `release/` |
| `src/agents/index.ts` | Specialist registry — maps Linear state to specialist module |
| `src/webhook/` | Linear webhook receiver (HMAC + dedup + cascade routing) |
| `src/workflow/` | WORKFLOW.md loader, typed config, fs watch + reload ([spec §5](docs/upstream-spec.md#5-workflow-specification-repository-contract), [§6](docs/upstream-spec.md#6-configuration-specification)) |
| `src/tracker/` | Linear GraphQL client, payload normalization ([spec §11](docs/upstream-spec.md#11-issue-tracker-integration-contract-linear-compatible)) |
| `src/tracker/tracker.ts` | `IssueTracker` interface — pluggable tracker abstraction |
| `src/workspace/` | Per-issue directory management, lifecycle hooks ([spec §9](docs/upstream-spec.md#9-workspace-management-and-safety)) |
| `src/agent/` | `AgentRunner` interface + Claude adapter; prompt builder; MCP config ([spec §10](docs/upstream-spec.md#10-agent-runner-protocol-coding-agent-integration)) |
| `src/guardrails/` | Cost-cap middleware |
| `src/audit/` | Postgres audit writer + schema (`run_audit`, `issue_metadata`, `webhook_dedup`) |
| `src/observability/` | Pino structured logger + Slack thread-card observer |
| `src/singleton/` | `pg_try_advisory_lock` instance lock |
| `src/lib/` | Shared utilities — `section-manager.ts`, `build-info.ts`, `redact.ts`, helpers |
| `WORKFLOW.example.md` | Annotated 16-state config template |
| `AGENTS.md` | Rules for AI agents working on this codebase + Symphony-driven prompt recognition |
| `docker/Dockerfile` | Multi-stage build |
| `scripts/` | `dev.sh`, `migrate.sh` |
| `tests/` | Unit + conformance ([spec §17](docs/upstream-spec.md#17-test-and-validation-matrix)) + integration |

## Getting started

### Prerequisites

- Node.js 22+
- pnpm (or npm)
- Postgres database (see `src/audit/schema.sql`)
- Linear account with API key
- Anthropic API key

### Install

```bash
git clone https://github.com/fbaltor/symphony.git
cd symphony
npm install
cp .env.example .env
# Fill in LINEAR_API_KEY, ANTHROPIC_API_KEY, DATABASE_URL
```

### Configure

```bash
cp WORKFLOW.example.md WORKFLOW.md
# Edit WORKFLOW.md — fill in tracker.api_key, tracker.team_id,
# github.owner, github.repo, and agent_runtime.model at minimum
```

### Migrate and run

```bash
npm run migrate          # apply src/audit/schema.sql to your Postgres
npm run dev              # starts the daemon via tsx watch
```

The daemon polls your Linear team every 30 seconds. Edit `WORKFLOW.md` while the daemon runs — config reloads live without restart.

## Test

```bash
npm test                 # all tests
npm run test:unit        # unit only
npm run test:conformance # spec §17 conformance suite
npm run test:integration # real Linear (skipped without credentials)
```

## Operator HTTP endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness probe — `{status:"ok"}` once bootstrapped |
| `GET /status` | admin token | In-memory snapshot: running issues, retry queue, resolved config |
| `GET /cost` | admin token | Spend rollup: today/month, top-20 issues, cap headroom |
| `POST /admin/reload` | admin token | Re-read WORKFLOW.md and re-run reconciliation (no redeploy needed) |
| `POST /admin/kill-switch` | admin token | `?op=engage\|clear\|status` — halt dispatch + drain workers |
| `POST /webhooks/linear` | HMAC | Linear webhook receiver |

Set `SYMPHONY_ADMIN_TOKEN` to authenticate the admin routes. Set `LINEAR_WEBHOOK_SECRET` for the webhook receiver.

## Deploying

Symphony runs as a single-instance long-running process. It uses a Postgres advisory lock to ensure only one instance dispatches at a time during rolling deploys.

**Important:** always deploy with `--max-instances=1` (or equivalent) on container platforms. Two concurrent instances will both attempt to claim the singleton lock.

See [`docs/deploying.md`](docs/deploying.md) for Docker Compose and Cloud Run quickstart guides.

## Deviations from the OpenAI Symphony spec

1. **Single-instance Postgres advisory lock.** The spec assumes a single authoritative orchestrator. Symphony adds `pg_try_advisory_lock` + 5s heartbeat / 15s lease for safe rolling deploys.
2. **Cost guardrails.** Symphony enforces a daily $ cap, per-issue $ cap, and per-state $ cap via `AgentRunner` middleware, persisted in `symphony.budget_state`.
3. **Persistent audit.** In addition to structured logs, Symphony writes a row per agent run to `symphony.run_audit`.
4. **Slack thread observer.** Posts threaded ticket cards to a configured Slack channel on state transitions. Disabled when `SLACK_BOT_TOKEN` or `slack.channel_id` are missing.
5. **`exactOptionalPropertyTypes` off.** TypeScript config keeps it disabled because the spec's normalized Issue model has many `field | null` shapes that interact poorly with strict optional semantics.
6. **Team-id filter.** Symphony accepts both `team_id` and `project_slug` and prefers `team_id` when set. This lets Symphony work against Linear teams that don't use projects.
7. **16-state pipeline.** The spec assumes a flat state machine. Symphony layers a 16-state pipeline with parent/child decomposition, per-state specialist agents, and cascade routing. See [`docs/adr/0010-16-state-pipeline.md`](docs/adr/0010-16-state-pipeline.md).
8. **Postgres-backed per-issue metadata.** Linear's GraphQL API doesn't expose user-defined per-issue custom fields. Symphony backs the 7 iteration/cost counters with `symphony.issue_metadata`.
9. **HMAC webhook defense.** The webhook receiver validates `Linear-Signature` + ±60s freshness + DeliveryId dedupe.
10. **Cooperative Linear GitHub auto-state.** Sub-issues move "Implementation (manual)" → "Pull request" on PR push and → "Done" on PR merge via Linear's native GitHub integration. Requires per-team `gitAutomationStateCreate` setup.
11. **Claude coding agent instead of Codex.** The spec targets the Codex app-server (§3.3, §10) and names the agent runtime config the `codex` block (§5.3.6). Symphony ships a Claude adapter (`src/agent/claude-adapter.ts`) behind the spec's `AgentRunner` interface ([§10](docs/upstream-spec.md#10-agent-runner-protocol-coding-agent-integration)); `agentRuntime.runtime` is locked to the `"claude"` literal and no Codex adapter exists. The audit/token model is agent-neutral (`input_tokens` / `output_tokens`, not the spec's `codex_*`). The `codex` config block is still accepted in `WORKFLOW.md`: the orchestrator consumes its `turn_timeout_ms` / `stall_timeout_ms`, while Codex-specific fields (`command`, `approval_policy`, sandbox modes) are inert under the Claude runtime.

## License

MIT — see [LICENSE](LICENSE).
