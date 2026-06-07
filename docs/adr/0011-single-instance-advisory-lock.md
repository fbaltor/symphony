# ADR-0011: Single-instance enforcement via Postgres advisory lock + cooperative handoff

## Status

Accepted.

## Context

The Symphony spec assumes a single authoritative orchestrator drives a team's
pipeline. Running two orchestrators against the same Linear team double-dispatches
agents, races on state transitions, and corrupts the retry queue.

Symphony deploys to Cloud Run with `min=max=1`, but a **rolling revision rollout
briefly runs two instances**: Cloud Run starts the new revision and only sends
`SIGTERM` to the old one once the new one reports healthy. That creates a deadlock
risk if "healthy" depends on holding an exclusive resource — the new revision
can't become healthy without the lock, and the old revision won't release it until
it's told to shut down.

A naive mutex (e.g. a boolean row) doesn't survive a crashed holder: if the
process holding it dies without cleanup, the lock is stuck forever.

## Decision

Coordinate single-instance ownership through three cooperating mechanisms backed
by Postgres:

### 1. Session-scoped advisory lock

`pg_try_advisory_lock(LOCK_KEY)` provides in-band mutual exclusion. The lock is
tied to the database session, so if the holder's connection drops (crash, OOM,
network partition) Postgres releases it automatically — no stuck-lock recovery
code needed.

### 2. Heartbeat lease

A `symphony.instance_lock` row tracks the active `instance_id` and
`heartbeat_at`. The holder refreshes the heartbeat every **5s**; a new instance
waits for the existing heartbeat to age past the **15s lease** before claiming,
up to a **30s** acquire window. This bounds how long a genuinely-dead instance can
keep a successor waiting.

### 3. Cooperative handoff

When a new instance finds the lock held by a *still-healthy* (recently
heartbeating) instance, waiting alone would deadlock against Cloud Run's
"old stays until new is healthy" policy. Instead the new instance writes a request
row to `symphony.instance_lock_handoff`. The holder's heartbeat tick polls that
table; on seeing a fresh request (< 60s old) from a *different* instance, it fires
an `onHandoffRequested()` callback that triggers the same graceful-shutdown path
as `SIGTERM`. Shutdown releases the advisory lock early and the new revision
proceeds.

The 60s recency bound prevents a stale request row from a long-dead revision from
nudging the live holder to step down.

This is a declared deviation from the spec, which does not specify a singleton
mechanism. It is safe for rolling deploys without operator intervention (the
pre-handoff fallback was a manual `pg_terminate_backend` on every deploy).
