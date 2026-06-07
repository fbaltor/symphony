# ADR-0015: Webhook ingress — layered verification and delivery dedup

## Status

Accepted.

## Context

Symphony's baseline is a 30s poll loop against Linear. Polling is simple and
naturally idempotent but adds up to 30s of latency to every state transition.
Linear webhooks deliver transitions in real time, but exposing a public POST
endpoint opens an attack surface (forged payloads, replay, oversized bodies) and a
correctness hazard (Linear retries deliveries, so the same event can arrive more
than once).

## Decision

Add a webhook receiver that runs **alongside** the poll loop (the poll loop stays
as a safety net — webhooks are additive, not a replacement) and routes verified
events through the same cascade primitives the poll loop already uses, so behavior
is identical on both paths.

Every delivery passes a top-down gauntlet, cheapest checks first:

1. **Method gate** — only `POST`.
2. **Signature header presence + length cap** (≤ 64 hex chars) — reject malformed
   headers before any crypto.
3. **Body size cap** (256 KB) — counted as bytes are read; oversized bodies are
   rejected `413` before parsing.
4. **HMAC-SHA256 verification** of the raw body against `LINEAR_WEBHOOK_SECRET`,
   compared with `crypto.timingSafeEqual` (constant-time).
5. **Freshness window** — reject if the body's `webhookTimestamp` drifts more than
   ±60s, bounding replay.
6. **Delivery dedup** — `INSERT` the `webhookId` into `symphony.webhook_dedup`. A
   primary-key collision means Linear is replaying; respond `200` (idempotent)
   without re-firing the cascade.
7. **Routing** — map the verified event's type + transition to a cascade.

Because the cascade functions query Linear's current truth before acting, they are
themselves idempotent: over-firing is at worst wasted work, never a correctness
bug. That lets the receiver be permissive about ambiguous transitions (Linear's
update payload exposes only old/new state *IDs*, not names) without risk.

This is a declared deviation from the spec, which specifies polling only.
