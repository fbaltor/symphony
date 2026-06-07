# ADR-0017: Per-state capability matrix + `canUseTool` defense-in-depth

## Status

Accepted.

## Context

Symphony runs the Claude Agent SDK with `permissionMode: "bypassPermissions"`
because there is no human in the loop to answer the SDK's interactive permission
prompts. That removes the SDK's per-call gate entirely — an autonomous agent could
run `rm -rf` on the orchestrator's parent directory, open a reverse shell, or
write outside its assigned workspace.

Different pipeline states also warrant different write scopes: a planning/analysis
state should not write files at all, while an implementation state needs to write
within the per-issue workspace.

## Decision

### `canUseTool` allowlist hook

Wire a `canUseTool` callback into every `query()` call. Per the SDK contract it
fires as the *last* guard, after `permissionMode` has already decided to allow the
call, so it reinstates a baseline allowlist:

- **Bash** — deny commands matching dangerous patterns: `sudo`, `cd /` (workspace
  escape), `curl` / `wget` / `nc` / `ssh` (network egress / remote shell),
  `rm -rf /`, and the classic fork bomb. Patterns are kept as a flat, individually
  tunable list.
- **Edit / Write / MultiEdit** — reject any `file_path` resolving outside the
  per-issue workspace (spec §9.5 invariant 1).
- **Read / Grep / Glob / MCP tools** — allowed unmodified.

### Per-state write-scope (`write_cwds_by_state`)

The callback is built per session with an optional `writeCwds` allowlist sourced
from `WORKFLOW.md`'s `write_cwds_by_state`:

- `undefined` → default rule (anywhere inside the workspace).
- `[]` (explicit empty) → **no file writes at all** — for analysis/plan-only
  states.
- non-empty → writes restricted to those workspace subdirectories.

### Self-edit lock

Even for paths inside the workspace, deny writes into Symphony's own source tree
when present (monorepo layout) so an in-flight agent can't modify the orchestrator
that is running it. In standalone deployments the workspace is the user's repo, so
this guard is a no-op.

This is "best-effort security" — a determined agent can still find an egress path
(e.g. write Python that opens a socket) — but it closes the common accidental-
damage and scope-creep cases the spec's permission model assumes a human would
catch.
