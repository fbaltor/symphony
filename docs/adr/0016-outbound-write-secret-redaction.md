# ADR-0016: Outbound-write secret redaction

## Status

Accepted.

## Context

The orchestrator and the agents both write free text to Linear — lifecycle
comments, issue descriptions, error reports — and that text can contain whatever
the agent surfaced: error messages, command output, file contents. A careless or
adversarial agent could echo a `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`, GitHub PAT,
or PEM private key into a Linear comment, where it is visible to every member of
the workspace and outside Symphony's audit boundary.

There are two write paths: orchestrator-emitted posts, and agent-driven posts that
go through the in-process `linear_graphql` MCP tool (where the secret would sit
inside arbitrarily-nested GraphQL `variables`).

## Decision

Scrub known-shape secrets from **all** outbound free text *before* it reaches
Linear.

- `redactSecrets(text)` runs an ordered list of provider key-shape regexes
  (Anthropic, Slack, GitHub classic/fine-grained/OAuth, Linear, GitLab, AWS,
  Google, Notion, Sentry, PEM private keys, and a last-resort generic JWT match).
  More-specific patterns run before broader ones. Each match becomes
  `[redacted:<kind>]` so a downstream observer can see *which* class of secret
  leaked without seeing the value. The function is idempotent — the placeholder
  matches no pattern.
- `redactStringsRecursive(value)` walks nested JSON-shaped values and applies the
  same redaction to every string, cycle-safe via a `WeakSet`. This covers the
  agent-side `linear_graphql` MCP boundary, where the orchestrator's per-string
  redactor would otherwise not reach.

Coverage is explicitly **best-effort**: key formats drift and new providers appear,
so a regex miss is possible. It is a real-world hardening layer, not a guarantee.
The audit trail still records the (post-redaction) attempt, leaving room for a
future canary-leak detector to scan audit rows for residue.
