# Upstream Symphony spec extension proposals

Two proposals worth filing as draft GitHub issues against `openai/symphony`.
Both are real-world-needed hardenings that emerged from production operation.

Drafted but NOT yet filed — review the wording and decide whether to submit,
since upstream issue filings are public and benefit from review.

To file: copy the relevant section below into a new GitHub issue at
https://github.com/openai/symphony/issues with the suggested title.

---

## Proposal 1 — `pr_required_states` deliverable check

**Suggested title:** "RFC: per-state deliverable checks (`pr_required_states`)"

**Suggested labels:** `enhancement`, `spec`, `tracker-tier`

### Problem

Symphony today doesn't distinguish "states where progress is real work
that produces a measurable artifact" from "states where progress is just
a conversation in Linear." If an agent posts a long Linear comment in a
state that's _supposed_ to require a PR (e.g. "Implementation"), the
spec accepts that as forward progress and the orchestrator advances the
ticket — even though no code was actually written.

Real-world example: the agent's plan was sound but the Implementation-stage
agent ran out of context mid-turn and posted "I'll continue next turn" as
the dispatch outcome. The ticket auto-advanced to Code Review, where a human
reviewer found no code to review.

### Proposed addition (spec §17.3 Tracker)

Add an optional `pr_required_states: string[]` field to the tracker
config. When a state appears in this list, the orchestrator's outcome
recording requires that the dispatched run produce a deliverable
matching one of:

- A new Git branch on the configured `github.repo` whose name matches the
  ticket identifier
- A new commit on an existing such branch (commit SHA recorded in the
  audit row)
- An open Pull Request referencing the issue identifier

If none of those exist after the dispatched run completes, the run is
recorded as `Succeeded` ONLY when:

- The agent explicitly declared a "no work needed" outcome (e.g. via a
  reserved comment marker), AND
- The state config also includes the state in a `pr_optional_states` list

Otherwise the run is recorded as `Failed` with reason
`pr_required_no_deliverable`.

### Why this belongs in the spec

Every Symphony deployment that has both "thinking states" (Plan,
Refinement) AND "writing states" (Implement, PR Assembly) faces this
asymmetry. Today each fork solves it via custom checks — the right place
is in the spec so the upstream `Tracker` interface knows what
"deliverable" means.

### Reference implementation

A working version lives in `src/orchestrator/` behind a per-state config
flag. Happy to upstream as a proof of concept if the proposal lands.

---

## Proposal 2 — Reconciler `humanReviewStates` revert pattern

**Suggested title:** "RFC: reconciler `humanReviewStates` revert handling"

**Suggested labels:** `enhancement`, `spec`, `reconciler-tier`

### Problem

The current spec's reconciler (§9.5) treats every active state as
"agent owns the ticket — orchestrator may dispatch." But real-world
workflows have states that mean "the agent has finished a phase, a HUMAN
must review next." If the orchestrator dispatches into one of those
states, the agent re-does work the human is mid-review on, or worse,
the agent and human conflict-edit the same Linear comment thread.

### Proposed addition (spec §9.5 Reconciler)

Add an optional `humanReviewStates: string[]` field to the tracker
config. When a state appears in this list:

1. The orchestrator does NOT dispatch into it (the agent waits for a
   human transition out of the state).
2. If the orchestrator detects an in-flight run was created via auto-
   dispatch and the LIVE state is now in `humanReviewStates`, it issues
   a `cancelled-by-reconciliation` outcome and reverts any work-in-
   progress branch state.
3. The state remains visible in the polling loop for active-states
   filtering (so other reconciler logic still sees it), but
   `isEligibleForDispatch()` returns `false`.

### Why this belongs in the spec

Every Symphony deployment that mixes agent autonomy with human review
gates needs this distinction. Today the spec's `activeStates` is a
single concept that conflates "states the orchestrator polls" with
"states the orchestrator may dispatch into." Splitting these makes
the reconciler interface honest.

### Reference implementation

A working version lives in `src/orchestrator/reconcile.ts` (see the
`humanReviewStates` config field + `recentRevertTimestampsMs` caching).
Happy to upstream as a proof of concept if the proposal lands.

---

## After filing

When these proposals are filed (or a decision is made not to file them),
note the upstream issue URL and outcome here.
