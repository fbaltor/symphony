---
# Symphony WORKFLOW.md — 16-state pipeline example
#
# Copy this file to WORKFLOW.md (or set SYMPHONY_WORKFLOW_PATH to point at it)
# and fill in the values marked <REQUIRED>.
#
# Quick-start: the minimum required fields are tracker.api_key, tracker.team_id
# (or tracker.project_slug), github.owner, github.repo, and
# agent_runtime.model. Everything else has safe defaults.

tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  # Required: your Linear personal API key (lin_api_...).
  # Use $LINEAR_API_KEY to pull from the environment.
  api_key: $LINEAR_API_KEY

  # Either team_id OR project_slug is required.
  # team_id: your Linear team's UUID (e.g. "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
  # project_slug: your Linear project key (e.g. "MYTEAM")
  team_id: <REQUIRED>

  # States Symphony will dispatch on. Issues in these states get a specialist
  # or a full-prompt LLM turn when the poll loop fires.
  #
  # 16-state pipeline (uncomment to use):
  active_states:
    - "Prioritized"
    - "Technical plan"
    - "Development"        # cascade only — no LLM call, transitions sub-issues
    - "PR validation"
    - "Release"

  # Terminal states — Symphony stops caring about these issues permanently.
  terminal_states:
    - "Done"
    - "Canceled"
    - "Cancelled"

  # Human-review gate states — the reconciler reverts unauthorized agent moves
  # to or from these states. Human moves are always honored.
  human_review_states:
    - "Questions (manual)"
    - "Plan review (manual)"
    - "To implement (manual)"
    - "Implementation (manual)"
    - "Pull request"
    - "Validation (manual)"
    - "Error (manual)"

  # State-advancement map: after a successful turn in state A, Symphony
  # automatically moves the issue to state B. Omitting a state means
  # "leave it alone" (useful for human-review states).
  state_transitions:
    "Prioritized": "Questions (manual)"
    "Technical plan": "Plan review (manual)"
    "Development": "Development"         # stays; cascade handles subs
    "Ready to deploy": "PR validation"
    "PR validation": "Release"           # orchestrator also reads Decision line
    "Release": "Done"                    # orchestrator also reads Decision line

  # Auto-retry: states where Symphony parks issues after a failed run and
  # retries them with exponential backoff (1 min → 2 → 4 → ... capped 24h).
  error_states:
    - "Error"

  # How many times Symphony auto-retries before posting "needs human review".
  max_error_retries: 5

  # States where the deliverable IS a merged PR. Symphony blocks auto-advance
  # if no matching branch exists in GitHub.
  pr_required_states:
    - "PR validation"
    - "Release"

  # Announce dispatch/outcome in Linear comments (disable in dev environments
  # to avoid spamming tickets during testing).
  announce_dispatch: true
  announce_outcome: true

codex:
  # Shell command that starts the local agent worker.
  # For the Claude runtime this is ignored — use agent_runtime below.
  command: codex app-server

slack:
  enabled: true
  # Required when enabled: your Slack channel ID (e.g. "C0123456789").
  # Use $SLACK_CHANNEL_ID to pull from the environment.
  channel_id: $SLACK_CHANNEL_ID

agent_runtime:
  runtime: claude
  # Required: which Claude model to use for non-specialist states.
  # Specialist agents (Prioritized, Technical plan, PR validation, Release)
  # use this model unless overridden.
  model: claude-opus-4-7
  # Optional: Anthropic adaptive-thinking effort level.
  # Omit to use the SDK's default (medium).
  # effort: high

github:
  # Required: the GitHub org/user and repo name for deliverable checks.
  owner: <REQUIRED>
  repo: <REQUIRED>
  # Branch prefix used by Technical plan when instructing the sub-issue
  # implementation agent. Default: "symphony". Override if your team uses
  # a different prefix (e.g. "feat", "bot", your org name).
  # branch_prefix: symphony

workspace:
  # Local directory where Symphony clones repos for each issue.
  # On Cloud Run this should be /tmp/symphony-workspaces (ephemeral tmpfs).
  root: /tmp/symphony-workspaces
  # How often (ms) to GC stale workspace directories.
  gc_interval_ms: 600000     # 10 minutes
  # Minimum age (ms) of a workspace before GC will remove it.
  gc_max_age_ms: 3600000     # 1 hour

polling:
  interval_ms: 30000         # poll every 30 seconds
  error_retry_interval_ms: 300000  # check error-state retries every 5 minutes

guardrails:
  # Kill-switch: total spend today across all tickets.
  daily_cap_usd: 100
  # Per-ticket cumulative cap across all specialist runs.
  per_issue_cap_usd: 30
  # Optional: per-state caps (map of state name → max USD per turn).
  per_state_cap_usd:
    Prioritized: 5
    "Technical plan": 10
    "PR validation": 5
    Release: 3

agent:
  max_concurrent_agents: 3
  max_turns: 20
  # Per-state concurrency overrides (optional).
  max_concurrent_agents_by_state:
    "PR validation": 2
    Release: 1
  # Per-state write-scope discipline (optional). Maps a state to the list of
  # workspace sub-paths the agent is allowed to write. An empty list denies
  # all file writes (Linear MCP only). Omitting a state defaults to
  # "anywhere in the workspace".
  #
  # Example: specialists that only write to Linear (no file edits needed):
  write_cwds_by_state:
    "Prioritized": []
    "Technical plan": []
    "PR validation": []
    Release: []

hooks:
  # Shell commands run at key lifecycle events. Relative paths are resolved
  # from the workspace root. Leave null to skip.
  #
  # before_run: scripts/setup-workspace.sh  # clone + install
  # after_run: scripts/cleanup.sh           # push artifacts
  after_create: null
  before_run: null
  after_run: null
  before_remove: null
  timeout_ms: 60000
---

# Symphony workflow prompt template
#
# This section is the Liquid template that Symphony renders for each issue
# dispatched to a non-specialist state. For specialist-owned states
# (Prioritized, Technical plan, PR validation, Release), Symphony uses the
# specialist's own SYSTEM_PROMPT instead and ignores this template.
#
# Available variables:
#   {{ issue.identifier }}  — Linear issue ID (e.g. "PROJ-42")
#   {{ issue.title }}       — issue title
#   {{ issue.description }} — issue body (Markdown)
#   {{ issue.state }}       — current state name
#   {{ issue.url }}         — Linear URL
#   {{ attempt }}           — turn number (0-indexed)
#   {{ comments }}          — array of { author, createdAt, body }
#
# This template is used for any active state NOT owned by a specialist.
# Edit it to match your project's conventions.

You are working on Linear issue {{ issue.identifier }}: {{ issue.title }}.

Current state: {{ issue.state }}
Linear URL: {{ issue.url }}
Turn: {{ attempt }}

## Task description

{{ issue.description }}

{% if comments.size > 0 %}
## Conversation history

{% for comment in comments %}
### {{ comment.author }} — {{ comment.createdAt }}

{{ comment.body }}

{% endfor %}
{% endif %}

## Your task

Complete the work described above. Follow the project's AGENTS.md conventions.
When done, post a summary comment on the Linear issue describing what you did.
