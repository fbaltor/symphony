# ADR-0022: Prompts in code with build-traceable provenance

## Status

Accepted.

## Context

The Symphony spec calls for specialist prompts to live "in code" rather than in
external config or a database. Symphony's pipeline (ADR-0010) dispatches per-state
specialist agents, each with its own system prompt. For a system that bills per
turn and whose behavior is entirely prompt-driven, an operator must be able to trace
*which exact prompt text* produced a given turn's outcome — otherwise a behavior
regression after a prompt edit is undebuggable.

## Decision

### Prompts as source

Each specialist owns a `SYSTEM_PROMPT` string and a `buildUserMessage(ctx)` builder
defined in its module under `src/agents/<specialist>/`. Prompts ship as source, so
they are versioned, diffable, code-reviewed, and unit-testable alongside the logic
that uses them. Specialists own their *full* prompt; the `WORKFLOW.md` Liquid
envelope is a fallback only, used for states with no dedicated specialist.

### Provenance

Because prompts are source, the running build's SHA (ADR-0021) uniquely identifies
the prompt text in effect. Every audit row (ADR-0013) records that SHA as
`prompt_version`, so any turn can be traced back to the exact prompt revision that
drove it. (A future per-prompt content hash could tighten this further; the build
SHA is the pragmatic version key today.)

This follows the spec's prompts-in-code guidance; the provenance wiring is a
Symphony addition that the persistent audit trail makes cheap.
