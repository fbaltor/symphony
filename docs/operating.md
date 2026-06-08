# Operating Symphony

A direct, command-first guide to running Symphony and driving feature work
through the Linear pipeline. For *what the system can do today* and how it's
built, see [`architecture-and-status.md`](architecture-and-status.md). For the
deeper deploy targets (Cloud Run, GitHub App), see [`deploying.md`](deploying.md).

---

## 1. What you need

- **Postgres** (audit, budget, lock, dedup). Docker Compose ships one.
- **Linear** API key + a team set up with the pipeline states (below).
- **Claude auth** — one of:
  - **Claude Code subscription (OAuth)** — recommended; $0 billed, drawn from your
    plan's rolling rate limits. `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`.
  - **Anthropic API key** — `ANTHROPIC_API_KEY` (per-token billing).
- **GitHub token** (only for the closed-loop implementation model) — a GitHub App
  or a fine-grained `GITHUB_TOKEN` PAT with Contents:RW + Pull requests:RW.

---

## 2. Auth — Claude Code subscription (OAuth)

```bash
claude setup-token            # prints a CLAUDE_CODE_OAUTH_TOKEN
```

In `.env`:

```
LINEAR_API_KEY=lin_...
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
ANTHROPIC_API_KEY=                 # leave BLANK on the OAuth path
GITHUB_TOKEN=github_pat_...        # only for closed-loop implementation
```

Gotchas on the OAuth-only path:

- The `"ANTHROPIC_API_KEY not set"` boot log is an **expected warning** — ignore it.
- **Do not use `scripts/dev.sh`** — it hard-fails on a missing `ANTHROPIC_API_KEY`
  (`scripts/dev.sh:18`). Use `docker compose` or `npm run dev` instead.
- Verify auth in isolation before the full loop: a 3-line `query()` against
  `@anthropic-ai/claude-agent-sdk` with the OAuth token in env should answer.

---

## 3. Run it (Docker Compose — the default)

```bash
docker compose up -d --build      # Postgres schema auto-applies; .env forwarded
docker compose logs -f symphony   # watch
curl -s localhost:8080/health     # {"status":"ok",...} once booted
docker compose down               # stop (named volumes persist)
```

Local (no Docker): `npm run migrate` then `npm run dev` (tsx watch, hot-reloads src).

**Editing config while running:**
- `WORKFLOW.md` is read at boot. Apply changes with `docker compose restart symphony`
  (or `POST /admin/reload`). The fs-watch hot-reload is unreliable over bind mounts.
- `scripts/setup-workspace.sh` (the clone hook) is mounted as a **directory**
  (`./scripts:/app/scripts`), so edits go live with no rebuild. A **single-file**
  mount would pin the old inode — don't switch it back.
- Source (`src/*.ts`) changes need `docker compose up -d --build` (recompiles `dist/`).

---

## 4. Configure the pipeline (`WORKFLOW.md`)

Copy `WORKFLOW.example.md` → `WORKFLOW.md`. Key knobs for the **current** setup:

```yaml
tracker:
  active_states: ["Prioritized", "Technical plan", "Development", "To implement"]
  agent_dispatched_states: ["To implement"]   # closed-loop: no-specialist state runs a turn
  state_transitions:
    "Prioritized": "Questions (manual)"
    "Technical plan": "Plan review (manual)"
    "To implement": "Pull request"             # we drive this (Linear GitHub integration off)
  pr_required_states: ["To implement"]         # only advance once a real branch/PR exists

agent_runtime:
  model: claude-opus-4-8
  effort: high          # low|medium|high|xhigh|max — xhigh ≈ $15/impl turn est

hooks:
  before_run: /app/scripts/setup-workspace.sh  # CONTAINER path; clones the repo per attempt
```

To run the **coordinator (manual-paste)** model instead of closed-loop, leave
`agent_dispatched_states` empty — the implementation state then becomes a human gate.

---

## 5. The day-to-day workflow (drive a feature)

All steps are **Linear actions** (drag a card, write a comment). Symphony reacts
within one poll (~30s).

| # | You do (in Linear) | Symphony does | Lands in |
|---|---|---|---|
| 1 | File an issue; put the **feature request in the body**; drag → **Prioritized** | Writes `## Goals / Context / Questions` (exactly 5) into the issue body | **Questions (manual)** |
| 2 | **Answer the 5 questions in comments**; drag → **Technical plan** | Clones the repo (`before_run`), reads it, decomposes into sub-issues | **Plan review (manual)** (subs in **Subtask drafted**) |
| 3 | Review the plan; drag the **parent → Development** | Cascade fans every drafted sub → **To implement** | subs → **To implement** |
| 4 | *(nothing — closed-loop)* | Per sub: Opus agent clones, writes code + tests, pushes `symphony/<id>`, opens a PR via the GitHub MCP, advances the sub | sub → **Pull request** |
| 5 | **Review + merge each PR** (the human gate) | — | (back-half PR-validation/Release: not yet wired — see status doc) |

Notes:
- Step 1's 5 questions land in the issue **body** (not a comment).
- Re-dragging back a stage re-runs it (idempotent).
- **Sub dependencies:** if sub B uses sub A's code, **merge A's PR first** so B
  clones a `main` that has it.
- `max_concurrent_agents: 1` → subs implement sequentially.

---

## 6. Commands & endpoints cheat-sheet

```bash
# lifecycle
docker compose up -d --build
docker compose logs -f symphony
docker compose restart symphony          # reload WORKFLOW.md
docker compose down

# observability (OPEN — no auth)
curl -s localhost:8080/health
curl -s localhost:8080/status  | python3 -m json.tool   # running issues, retry queue, config
curl -s localhost:8080/cost    | python3 -m json.tool   # $ rollup: today/month, top issues, caps
curl -s localhost:8080/usage   | python3 -m json.tool   # token+est-cost rollup 5h/24h/7d per model

# admin (need SYMPHONY_ADMIN_TOKEN; Authorization: Bearer <token>)
curl -X POST -H "Authorization: Bearer $TOK" "localhost:8080/admin/kill-switch?op=engage"   # halt dispatch, drain
curl -X POST -H "Authorization: Bearer $TOK" "localhost:8080/admin/kill-switch?op=clear"
curl -X POST -H "Authorization: Bearer $TOK"  localhost:8080/admin/reload                    # re-read WORKFLOW.md

# usage straight from Postgres (rolling 5h window — the sub's rate-limit cadence)
docker compose exec -T postgres psql -U symphony -d symphony -c \
  "SELECT model, count(*) turns, sum(output_tokens) out_tok, round(sum(cost_usd),2) usd
   FROM run_audit WHERE started_at > now() - interval '5 hours' GROUP BY model;"
```

Cost note: the CC subscription limit is a **rolling-window rate limit** (≈5h +
weekly, model-weighted — Opus heaviest), **not a $ balance**. `cost_usd` is the
SDK's *estimate*; watch `output_tokens`. One Opus-`xhigh` implementation turn ≈
27k output tokens / ~$15 est.

---

## 7. Troubleshooting

| Symptom (log / behavior) | Cause + fix |
|---|---|
| `ANTHROPIC_API_KEY not set` (warn) | Expected on the OAuth path. Ignore. |
| `mcp.github.skipped — no GH App and no GITHUB_TOKEN PAT` | No GitHub auth → agent can't push/PR. Set `GITHUB_TOKEN` (or GH App) in `.env`, `docker compose up -d` (recreate to load `.env`). |
| `before_run hook failed` / `could not read Username for github.com` | Clone auth. The hook uses token-in-URL (github.com git-over-HTTPS rejects `Authorization: Bearer`). Ensure `GITHUB_TOKEN` is set + reaching the container (`docker compose exec symphony printenv GITHUB_TOKEN`). |
| `deliverable check failed: no branch / PR found` | The implementation turn ended without a pushed PR. It retries (work preserved by the non-destructive `before_run`); the hard commit→push→PR checklist in the template reduces this. |
| `reconcile: detected stall` cancels a healthy turn | The turn exceeded `codex.stall_timeout_ms` (gap-between-events). Default 300s is too short for real turns — set it to 600000. |
| Dragging parent → Development does nothing | The cascade fires on a *fresh* observation; needs the `isFreshTransition` fix — confirm the running image is on latest `main`. The poll loop also can't see transitions through non-active states without webhooks for the Sub-Done/Cancel cascades. |
| Config change not taking effect | `WORKFLOW.md` → `docker compose restart` or `/admin/reload`. `src/*.ts` → `up -d --build`. |
