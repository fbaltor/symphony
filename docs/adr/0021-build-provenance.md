# ADR-0021: Build provenance — `version + gitSha` everywhere

## Status

Accepted.

## Context

The most common on-call question after a deploy is "is the fix I just shipped
actually live?" Answering it by log-diving is slow and error-prone, especially
under the single-instance handoff (ADR-0011) where an old revision may linger
briefly. The running binary's identity needs to be visible at every surface an
operator or auditor already looks at.

## Decision

Surface a canonical build identifier — `symphony/<version>+<sha>` — at every
operational touchpoint:

- the `/health` response (probe + ad-hoc `curl`),
- the `symphony started` boot banner (first line on a deploy),
- the Slack lifecycle-card footer,
- the GitHub `User-Agent` and the Anthropic SDK client-app env (so external audit
  logs carry the binary's identity).

`version` comes from `package.json`. The SHA is resolved by priority, cached after
first read:

1. `SYMPHONY_BUILD_SHA` — set at image-build / deploy time (canonical in prod).
2. `K_REVISION` — Cloud Run's per-revision id; the trailing segment is surfaced as
   a `rev-<id>` fallback when the build arg wasn't wired.
3. `git rev-parse --short HEAD` — local dev only; the runtime image has no `.git`,
   so this never fires in production.
4. `"unknown"` — explicit final fallback, so a misconfigured deploy is *visible* in
   `/health` rather than silently masking the SHA.
