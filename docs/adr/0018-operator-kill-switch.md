# ADR-0018: Operator kill-switch

## Status

Accepted.

## Context

When something goes wrong in production — a cost runaway, a bad WORKFLOW.md, a
misbehaving agent — an operator needs to halt new dispatches *immediately*, without
waiting for a redeploy (which, under the single-instance lock of ADR-0011, also
incurs a handoff). They also need that halt to survive an orchestrator restart, and
they should not have to abandon work already in flight.

## Decision

A single-row `symphony` kill-switch table holds the dispatch halt state, flipped
through a token-gated admin HTTP route:

- `GET|POST /admin/kill-switch?op=engage|clear|status` (default `status`).
- Gated by `SYMPHONY_ADMIN_TOKEN` (Bearer). If the token is unset the whole
  `/admin/*` surface returns `503` (disabled); a missing/mismatched token returns
  `401`. `engage` and `clear` require `POST`.
- `engage` accepts optional `reason=` and `by=` query params, persisted for the
  audit trail.

When engaged, the orchestrator's dispatch loop logs and **skips new dispatches**;
**in-flight workers drain to completion** — the kill-switch halts *new* work only,
so it never clobbers a turn mid-flight. Because the state lives in Postgres it
survives restarts and applies to whichever instance holds the lock.

This is a declared deviation from the spec. It is fail-safe: if the admin token is
unconfigured the control plane is simply unavailable, never open.
