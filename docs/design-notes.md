# Design notes

Smaller design decisions that don't each warrant a full ADR. Larger, cross-cutting
decisions live in [`docs/adr/`](./adr/).

## Fail-fast on uncaught errors

`main.ts` does **not** swallow `uncaughtException` / `unhandledRejection`. An
uncaught error logs a fatal line and exits the process (`process.exit(1)`). Under
Cloud Run this is safe and self-healing: the platform restarts the revision, and
the single-instance lock (ADR-0011) makes the successor wait out the dead
instance's lease before claiming. Swallowing errors would instead leave the
orchestrator running in an undefined partial state.

## Reserved agent-event kinds

`agent/events.ts` declares the full spec-aligned union of agent event kinds, but
the Claude adapter emits only a subset today (`turn_completed`, `turn_failed`,
`turn_cancelled`). The remaining kinds (session lifecycle, startup failure, live
per-message breadcrumbs) are **reserved**, documented inline as such, and will be
emitted once the live event-stream wiring lands. Keeping the full union (rather
than trimming to the three emitted kinds) avoids a type re-expansion later and
signals to readers that the unemitted kinds are intentional, not dead code.

## In-process `linear_graphql` MCP tool

Per spec §10.5, agents that need direct tracker access get an in-process
`linear_graphql` MCP server (an SDK-type MCP server, not a subprocess) exposing the
tracker client's GraphQL surface. Running it in-process avoids a per-turn
subprocess cold-start. Outbound `variables` are scrubbed at this boundary
(ADR-0016).

## Adaptive-thinking effort + model validation

`agent_runtime.effort` from `WORKFLOW.md` is forwarded to Anthropic's adaptive
thinking configuration rather than hardcoded. The `model` field is validated as a
non-empty string at config-parse time — an empty `model: ""` previously slipped
through and silently fell back to an SDK default, masking misconfiguration.

## Hermetic shell execution (`bash -c`, not `bash -lc`)

Lifecycle-hook and agent shell commands run under `bash -c`, not a login shell
(`bash -lc`). A login shell sources `/etc/profile` and the user's `~/.bash_profile`
/ `~/.bashrc`, which makes command behavior depend on ambient environment that
differs between local dev and the container. `bash -c` keeps execution hermetic and
reproducible.

## Workspace storage: tmpfs, not the GCS FUSE mount

Per-issue workspaces live under `/tmp/symphony-workspaces/<ISSUE>/` (Cloud Run
tmpfs) rather than a GCS FUSE mount, because GCS FUSE doesn't support `chmod()` and
`git clone` therefore fails on it. The trade-off (a spec §9.2 divergence): tmpfs is
per-instance, so a revision rollover wipes in-progress workspaces. The `before_run`
hook re-clones on the next dispatch, but uncommitted in-flight work is lost — a
real, accepted risk window at `min=max=1`. See
[`docs/architecture/workspace-storage.md`](./architecture/workspace-storage.md).

## Lifecycle-marker centralization

The HTML-comment markers Symphony writes into Linear comments
(`<!-- symphony:event=... -->`) and the regexes that recognize them are defined once
in `lib/markers.ts`, rather than duplicated across the tracker and orchestrator. A
change to the marker format then touches a single file.
