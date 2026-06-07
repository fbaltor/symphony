# ADR-0020: Reconciler — revert unauthorized agent moves, preserve human intent

## Status

Accepted.

## Context

The pipeline has human-review gates (e.g. a plan must pass an RFC review before
implementation). An agent holding `update_issue` can move a ticket straight past a
gate, defeating the review. The spec's state model has no concept of an
unauthorized transition, so nothing reverts it.

But not every "unexpected" move is unauthorized: an **operator** legitimately drags
a ticket backward into a gate to force a re-iteration, and that intent is
load-bearing for the pipeline. A reconciler that reverts *every* off-path move would
fight the human on every tick.

## Decision

On each tick, for every running worker, the reconciler compares the issue's fresh
state against its last-seen state and reverts gate-bypassing moves — *before* normal
active/terminal routing — subject to these rules:

### What counts as a bypass

A changed, non-terminal, non-authorized transition where any of: the previous state
was itself a gate; the new state is a gate via a non-authorized edge; or the
configured forward edge from the previous state pointed *at* a gate and the agent
moved elsewhere (the classic "skipped the gate" case). Terminal moves
(Done/Canceled/Duplicate/Error) are never reverted — agents drive those
legitimately.

### Human vs. agent (actor distinction)

When the bot's own Linear user id is known (looked up at boot) and a Postgres pool
is available, the reconciler reads `symphony.issue_state_actor` for the issue before
reverting. If the last actor was **not** the bot, the move was human-driven and the
revert is skipped (last-seen state is still updated so it doesn't retry next tick).
If no actor row exists or the lookup fails, it falls back to the legacy
always-revert behavior.

### Anti-thrash + persistence

A per-issue revert counter escalates to an `Error` state after more than 3 reverts
in an hour, so a persistent agent can't busy-loop fighting the gate. Last-seen state
is persisted (`symphony.review_gate_state`) so reverts work across orchestrator
restarts. A protected-terminal hook lets the reconciler skip cancelling a worker for
the one tick where an authorized automation (the Release specialist's squash-merge)
drives a legitimate terminal transition via Linear's native GitHub integration.

This is a declared deviation from the spec. Worth upstreaming as a §18.2 extension.
