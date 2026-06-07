# ADR-0019: Deliverable gate — refuse to advance on no-op agent output

## Status

Accepted.

## Context

An agent can report `outcome=Succeeded` without actually producing the deliverable
the state requires. The canonical case: an implementation turn finishes cleanly but
never pushes a branch or opens a PR, because the agent convinced itself the work was
already done. If the orchestrator trusts the outcome and auto-advances, a ticket
sails toward "done" with nothing shipped — and worse, it can loop: each re-dispatch
costs real money for the agent to re-discover "nothing to do."

Two complications:

- Some tickets legitimately have **no PR** — behavioural probes whose deliverable is
  a Linear comment, not code.
- If the escalation target (an `Error` state) doesn't exist on a team, the
  escalating transition fails silently and any in-memory counter resets, re-opening
  the dispatch loop.

## Decision

### Deliverable check + counter

After a `Succeeded` turn in a PR-producing state, verify a branch/PR exists for the
issue. Track consecutive misses in a per-issue counter (reset on a passing check or
a non-`Succeeded` outcome). After `tracker.noPrRetryLimit` (default **3**)
consecutive misses, move the issue to `Error` for human triage instead of
advancing.

### `no-pr-required` opt-out

An operator can place `<!-- symphony:no-pr-required -->` anywhere in the issue body
to short-circuit the PR check for probe tickets. The match is case-insensitive,
whitespace-tolerant, and substring-based so it survives Linear's markdown
round-tripping and can sit in any section. It follows the same HTML-comment marker
convention the orchestrator already uses for lifecycle events.

### Escalation skip-map

After escalating an issue to `Error`, record the issue plus its dispatch state. The
tick loop checks this map before dispatching: if the issue's current state still
matches the recorded one, dispatch is skipped (the human hasn't intervened yet).
When the human moves it out of (or back into) that state, the recorded state no
longer matches and dispatch resumes. The map is in-memory; a restart allows exactly
one more attempt, an acceptable trade-off given how rare rollovers are.

This is a declared deviation from the spec — a real-world hardening every
implementation hits once agents can converge on no-op outputs. Worth upstreaming as
a §18.2 extension.
