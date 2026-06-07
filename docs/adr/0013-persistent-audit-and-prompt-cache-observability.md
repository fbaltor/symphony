# ADR-0013: Persistent audit trail + prompt-cache observability

## Status

Accepted.

## Context

The spec requires only structured logs. Logs are ephemeral and awkward to query:
answering "what did this issue cost across all its turns?", "which prompt version
drove that turn?", or "what's our prompt-cache hit rate?" by scraping log lines is
fragile. Symphony's cost guardrails (ADR-0012) also need a durable per-issue cost
history that survives orchestrator restarts.

Anthropic's prompt caching materially changes per-turn economics — a cached input
token is billed at a fraction of a fresh one — but only if you can *measure* the
cache hit rate to know whether the stable-prefix discipline is actually working.

## Decision

### 1. One audit row per attempt

Every agent turn writes a `symphony.run_audit` row (issue, state, outcome, cost,
tokens, timing, prompt version). This is the source of truth for the `/cost`
endpoint, the per-issue cumulative cap, and post-hoc analysis. Rows are written in
the worker's `finally` block so a crashed or aborted turn is still recorded.

### 2. Prompt-cache token columns

`run_audit` records the cache-fee token subsets Anthropic returns —
`cache_creation_input_tokens` (tokens written into the cache, billed at a premium)
and `cache_read_input_tokens` (tokens served from cache, billed at a discount) —
alongside the standard input/output counts. These flow from the Claude adapter
through the orchestrator into the audit row and onto the Slack lifecycle card, so
cache hit-rate is observable per turn. Columns default to `0` so rows written
before caching was wired (or by a runtime that doesn't report them) round-trip
cleanly.

### 3. Prompt-version provenance

Each row carries the `prompt_version` (the build SHA, see ADR-0021/ADR-0022) so a
given turn's behavior can be traced back to the exact prompt text that drove it.

This is a declared deviation from the spec (which mandates only logs). The audit
table is additive — losing it degrades observability and the cumulative cap but
does not break dispatch.
