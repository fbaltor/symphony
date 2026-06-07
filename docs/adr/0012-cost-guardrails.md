# ADR-0012: Cost guardrails — daily, per-issue, and per-state caps with mid-stream abort

## Status

Accepted.

## Context

The Symphony spec defines no cost limits. Symphony dispatches autonomous coding
agents that bill per token on capable (expensive) models, with no human in the
loop to notice a runaway. Several failure modes burn money silently:

- A misconfigured prompt loops an agent on the same turn.
- A single feature ticket fans out into many sub-issues, each its own agent run.
- One state (e.g. implementation) is far more expensive than the lightweight
  triage/planning states, so a flat per-run cap is either too loose for cheap
  states or too tight for expensive ones.

## Decision

Enforce three independent USD caps, all configured in `WORKFLOW.md` and all
optional (unset = no cap):

### 1. Daily cap

A rolling daily spend ceiling across all issues, tracked in
`symphony.budget_state`. When exceeded, dispatch is refused until the window
rolls over. Protects against a systemic runaway.

### 2. Per-issue cumulative cap

The sum of all recorded cost for a single issue across every turn it has taken.
Read at dispatch time from the audit history so it survives orchestrator
restarts. Protects against one ticket consuming an unbounded share of budget
through repeated re-dispatch.

### 3. Per-state turn cap

A cap keyed by (lowercased) Linear state name, so expensive states can be funded
generously while cheap states stay tight. Looked up against the issue's **live**
state at the moment of the turn, which handles mid-run state changes correctly.

### Mid-stream abort

The caps are not only checked before a turn. The Claude adapter watches the
running `total_cost_usd` the SDK surfaces during a turn and **aborts mid-stream**
the moment the live cost crosses the applicable per-issue or per-state cap, rather
than letting an already-over-budget turn run to completion. A cap-driven abort
takes precedence over the generic turn-failure path so the audit row records the
real reason.

These are declared deviations from the spec. The caps are intentionally
fail-closed (an over-budget dispatch is refused, not best-effort throttled).
