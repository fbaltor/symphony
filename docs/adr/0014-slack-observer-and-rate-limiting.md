# ADR-0014: Slack thread observer with rate limiting and thread persistence

## Status

Accepted.

## Context

Operators want real-time visibility into what the orchestrator is doing —
dispatches, outcomes, costs, rejections — without tailing logs. The spec treats
observability as logs only.

A naive "post to Slack on every event" observer has two problems:

1. A flapping issue (rapidly cycling states) or a misconfiguration that rejects
   dispatch every tick (ticks are ~5–15s) would spam the channel into uselessness
   and could hit Slack's own rate limits.
2. Lifecycle posts for one issue should thread together, but the thread root
   (`threadTs`) must survive an orchestrator restart or every restart starts a new
   thread.

## Decision

A passive `SlackObserver` subscribes to orchestrator events and posts lifecycle
cards. It is strictly an observer — it never influences dispatch.

### Rate limiting

Two layers, both fail-open (a dropped post is logged, never blocks the
orchestrator):

- **Per-issue minimum gap** — back-to-back posts for the same issue within a 5s
  window are dropped.
- **Global token bucket** — a 20-token bucket refilled to capacity every 60s caps
  the channel-wide post rate.

Rejection alerts (cost-cap exceeded, kill-switch engaged, etc.) additionally use a
per-`(kind, reason)` dampening window so a sustained misconfiguration produces one
alert per window instead of one per tick.

### Thread persistence

The thread root timestamp is persisted (per issue/channel) in Postgres so
lifecycle cards for an issue keep threading across orchestrator restarts.

### Auth-failure handling

If Slack auth fails, the observer disables itself for the rest of the process
rather than retrying on every event. (Known limitation: recovering a rotated token
currently requires a restart.)

This is a declared deviation from the spec. The observer is optional; disabling it
has no effect on the pipeline.
