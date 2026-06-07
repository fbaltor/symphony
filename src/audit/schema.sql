-- Symphony — audit, budget, and instance-lock tables.
-- Apply via `pnpm migrate` (scripts/migrate.sh).
-- All objects live under the `symphony` schema for isolation.

CREATE SCHEMA IF NOT EXISTS symphony;

-- One row per agent run attempt. Successful, failed, timed-out, stalled,
-- and reconciliation-cancelled attempts all produce a row.
CREATE TABLE IF NOT EXISTS symphony.run_audit (
    id              BIGSERIAL PRIMARY KEY,
    issue_id        TEXT        NOT NULL,
    issue_identifier TEXT       NOT NULL,
    attempt         INTEGER,
    session_id      TEXT,
    started_at      TIMESTAMPTZ NOT NULL,
    finished_at     TIMESTAMPTZ NOT NULL,
    outcome         TEXT        NOT NULL,
    runtime         TEXT        NOT NULL,
    model           TEXT,
    input_tokens    INTEGER     NOT NULL DEFAULT 0,
    output_tokens   INTEGER     NOT NULL DEFAULT 0,
    total_tokens    INTEGER     NOT NULL DEFAULT 0,
    cost_usd        NUMERIC(10, 4) NOT NULL DEFAULT 0,
    error           TEXT,
    extra           JSONB
);

CREATE INDEX IF NOT EXISTS run_audit_issue_idx ON symphony.run_audit (issue_id, started_at DESC);
CREATE INDEX IF NOT EXISTS run_audit_started_idx ON symphony.run_audit (started_at DESC);

-- per-run prompt provenance. Records the build's gitSha for runs
-- before per-stage prompt.ts modules land; once those modules
-- exist, this becomes the per-prompt content hash so a regression to a
-- specific stage's prompt file is post-hoc analyzable. Nullable so
-- pre-migration rows survive.
ALTER TABLE symphony.run_audit ADD COLUMN IF NOT EXISTS prompt_version TEXT;

-- Anthropic prompt-cache token tracking. Both
-- columns are subsets of what would have been input_tokens had caching
-- been disabled — `cache_creation_input_tokens` is what Anthropic billed
-- at the cache-write fee (1.25× standard for the 5-min ephemeral TTL),
-- `cache_read_input_tokens` is what was served from cache (~10% of the
-- standard input-token rate). Cache hit rate is computed per-run as
--   cache_read_input_tokens
--   / (cache_read_input_tokens + cache_creation_input_tokens + input_tokens)
-- and surfaced in the Slack succeeded card. Columns are NOT NULL with
-- DEFAULT 0 so pre-migration rows survive the ALTER intact (Postgres
-- backfills the default into existing rows; new inserts that don't
-- specify these columns also pick up 0).
ALTER TABLE symphony.run_audit ADD COLUMN IF NOT EXISTS cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE symphony.run_audit ADD COLUMN IF NOT EXISTS cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;

-- Per-issue last-state-change actor (see docs/adr/0020). The webhook
-- receiver writes one row per issue on every Issue.update event with the
-- actor id + type from Linear's payload. The reconciler reads it before
-- reverting an unauthorized state move — if the last actor is NOT
-- Symphony's bot user (LinearTrackerClient.fetchViewerId at boot), the
-- move is treated as human-driven and the revert is skipped. Without
-- this row the reconciler falls back to the pre-Task-2 behavior (always
-- revert when an unauthorized move touches a review gate).
--
-- One row per issue (PRIMARY KEY on issue_id). Updates are upserts; we
-- don't keep history because the reconciler only needs the LATEST actor
-- to make its skip-or-revert decision. If a forensic actor history is
-- needed later, the audit trail lives in `symphony.run_audit` (per-run)
-- and Linear's own activity log (per-event).
CREATE TABLE IF NOT EXISTS symphony.issue_state_actor (
    issue_id          TEXT        PRIMARY KEY,
    issue_identifier  TEXT        NOT NULL,
    last_actor_id     TEXT        NOT NULL,
    -- Linear webhook actor.type values: "user" (human / API-key personal
    -- access), "application" (OAuth installed app), "webhook" (built-in
    -- automation), or null when actor was missing in payload. We store
    -- the literal string so future queries can distinguish them without
    -- a migration.
    last_actor_type   TEXT,
    last_state        TEXT        NOT NULL,
    last_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issue_state_actor_changed_idx
  ON symphony.issue_state_actor (last_changed_at DESC);

-- Persistent counters for the cost-cap middleware. One row per UTC day; one
-- row per (issue, day) for the per-issue cap.
CREATE TABLE IF NOT EXISTS symphony.budget_state (
    scope_kind   TEXT        NOT NULL,  -- 'daily' or 'issue'
    scope_key    TEXT        NOT NULL,  -- ISO date (daily) or issue_id (issue)
    day_utc      DATE        NOT NULL,
    cost_usd     NUMERIC(10, 4) NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_kind, scope_key, day_utc)
);

-- Single-orchestrator advisory lock: one row that the active instance
-- heartbeats. Spec §14.3 says state is intentionally in-memory; this row
-- exists only to coordinate which Cloud Run revision is "the" orchestrator
-- during rollouts.
CREATE TABLE IF NOT EXISTS symphony.instance_lock (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    instance_id     TEXT        NOT NULL,
    acquired_at     TIMESTAMPTZ NOT NULL,
    heartbeat_at    TIMESTAMPTZ NOT NULL,
    CHECK (id = 1)
);

-- kill-switch — single-row table that halts dispatch when
-- engaged. Operators flip it via POST /admin/kill-switch
-- (`op=engage|clear`). The orchestrator checks it on every poll tick
-- before claiming candidates; in-flight workers are NOT aborted (they
-- drain naturally so audit + Linear writes complete).
CREATE TABLE IF NOT EXISTS symphony.kill_switch (
    id            INTEGER PRIMARY KEY DEFAULT 1,
    engaged       BOOLEAN NOT NULL DEFAULT false,
    reason        TEXT,
    engaged_at    TIMESTAMPTZ,
    engaged_by    TEXT,
    CHECK (id = 1)
);
INSERT INTO symphony.kill_switch (id, engaged) VALUES (1, false)
  ON CONFLICT (id) DO NOTHING;

-- Per-issue last-seen Linear state for the reconciler's review-gate
-- enforcement. Previously this map lived in-memory on the
-- Orchestrator and reset on restart; the first reconciler tick after a
-- Cloud Run rollover would have no `prev` to compare against, opening a
-- ~30s window where an unauthorized agent state move went unreverted.
-- Persisting it here closes that window.
CREATE TABLE IF NOT EXISTS symphony.review_gate_state (
    issue_id        TEXT        PRIMARY KEY,
    last_seen_state TEXT        NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Slack thread root per (issue, channel). Previously the
-- thread_ts map lived in-memory and reset on every Symphony restart, so
-- the same Linear issue's lifecycle posts split across multiple Slack
-- threads on revision rollover. Persisting the root ts here keeps the
-- thread coherent across restarts.
CREATE TABLE IF NOT EXISTS symphony.slack_thread (
    issue_id    TEXT        NOT NULL,
    channel_id  TEXT        NOT NULL,
    thread_ts   TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (issue_id, channel_id)
);

-- Task 2 (2026-05-06): in-flight run tracking for orphan reconciliation.
--
--  (2026-05-06) demonstrated a real cost-truth gap: 6 Implement
-- dispatches OOM-killed before any audit row could be written, leaving
-- ~$5–$15 of real Anthropic spend invisible to `/cost` and the audit
-- table. The cost-cap module's `budget_state` carried partial cost
-- snapshots, but `run_audit` showed ZERO rows for those attempts.
--
-- This table fixes the gap. Each worker INSERTs a row on dispatch and
-- DELETEs on success/fail/abort (in `runWorker`'s finally block — runs
-- even if the SDK throws). On orchestrator boot, the reaper scans for
-- rows whose `instance_id` doesn't match the current heartbeat AND is
-- older than the heartbeat lease (15s) — those are workers from a
-- crashed previous instance. The reaper writes a synthetic
-- `outcome=Killed` audit row with cost_usd=0 + an extra.killed flag so
-- dashboards can label them "uncosted, killed by container".
--
-- Single-instance invariant: only one orchestrator instance writes here
-- at a time (enforced by `instance_lock`), so race-free row management.
CREATE TABLE IF NOT EXISTS symphony.running_runs (
    issue_id          TEXT        NOT NULL,
    issue_identifier  TEXT        NOT NULL,
    instance_id       TEXT        NOT NULL,
    attempt           INTEGER,
    session_id        TEXT,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (issue_id, instance_id)
);
CREATE INDEX IF NOT EXISTS running_runs_instance_idx
  ON symphony.running_runs (instance_id);
CREATE INDEX IF NOT EXISTS running_runs_started_idx
  ON symphony.running_runs (started_at);

-- cooperative singleton-lock handoff during Cloud Run rollouts.
--
-- Cloud Run only sends SIGTERM to the old revision AFTER the new one
-- passes its startup probe — but the new revision can't pass the probe
-- because the old revision is still healthy and holding the
-- session-scoped pg_try_advisory_lock. Classic deadlock; pre-
-- mitigated by manually `pg_terminate_backend`'ing the old revision's
-- PG session via cloud-sql-proxy on every deploy.
--
-- Cooperative handoff protocol:
--
--   1. New revision boots, can't claim the lock (existing instance is
--      heartbeating fresh).
--   2. New revision INSERTs a row here with its own instance_id +
--      `requested_at = now()`.
--   3. Old revision's heartbeat tick polls this table. If a row exists
--      whose `requesting_instance_id != self.instance_id` AND
--      `requested_at` is recent (< 60s old), the old revision invokes
--      its own `gracefulStop` — same path as if SIGTERM had fired.
--   4. The early-release-on-shutdown path then runs, freeing the
--      advisory lock and the heartbeat row.
--   5. New revision's wait loop breaks on stale heartbeat, claims the
--      advisory lock, deletes the handoff row.
--
-- Single row (id=1) — same shape as `instance_lock`. Stale rows are
-- self-clearing (the new revision deletes its own row on successful
-- claim) so this table is essentially a transient signal, not a log.
CREATE TABLE IF NOT EXISTS symphony.instance_lock_handoff (
    id                       INTEGER PRIMARY KEY DEFAULT 1,
    requesting_instance_id   TEXT        NOT NULL,
    requested_at             TIMESTAMPTZ NOT NULL,
    CHECK (id = 1)
);

-- Per-issue metadata for the 16-state workflow.
--
-- The §8 spec called for 7 Linear-native custom fields (symphony_validation_iteration,
-- symphony_questions_answered, symphony_plan_iteration, symphony_pr_validation_iteration,
-- symphony_error_state, symphony_cost_usd, symphony_last_specialist). VE-2 verification
-- on 2026-05-06 confirmed Linear's GraphQL API does NOT expose user-defined per-issue
-- custom fields — `customFieldCreate` etc. don't exist in the schema (only `customViewCreate`
-- for views). Linear's per-issue custom-field feature is paid + UI-configured only.
--
-- Design decision: back the 7 fields
-- with this Postgres table instead. Each row is keyed on Linear's internal `issueId`
-- UUID. The specialist agents echo iteration counts inline in their owned description
-- blocks (e.g., `## PR validation report` opens with "Iteration: 3 of 5") to keep
-- the values visible to humans in the Linear UI.
CREATE TABLE IF NOT EXISTS symphony.issue_metadata (
    issue_id                 TEXT        PRIMARY KEY,
    issue_identifier         TEXT        NOT NULL,
    -- count of Prioritized re-runs (Question (manual) → Prioritized loop)
    validation_iteration     INTEGER     NOT NULL DEFAULT 0,
    -- flips true when human first moves Questions (manual) → Technical plan
    questions_answered       BOOLEAN     NOT NULL DEFAULT FALSE,
    -- count of Technical plan re-runs (Plan review (manual) → Technical plan loop)
    plan_iteration           INTEGER     NOT NULL DEFAULT 0,
    -- count of PR validation bounces (capped at 5 → Error (manual))
    pr_validation_iteration  INTEGER     NOT NULL DEFAULT 0,
    -- name of the stage that escalated to Error (manual), null if not escalated
    error_state              TEXT,
    -- cumulative spend across all specialist runs for this issue
    cost_usd                 NUMERIC(10, 4) NOT NULL DEFAULT 0,
    -- name of the most recent specialist that ran (for /status + dashboards)
    last_specialist          TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issue_metadata_identifier_idx
  ON symphony.issue_metadata (issue_identifier);
CREATE INDEX IF NOT EXISTS issue_metadata_error_idx
  ON symphony.issue_metadata (error_state)
  WHERE error_state IS NOT NULL;

-- Linear webhook dedup table.
--
-- Symphony's `POST /webhook/linear` receiver inserts each Linear delivery's
-- `webhookId` here under a unique constraint, then routes to the cascade
-- pipeline. On replay (Linear may retry the same webhookId on a 5xx), the
-- INSERT collides with the PK and the receiver short-circuits with a 200,
-- so the cascade fires AT MOST ONCE per delivery — same property the poll
-- loop already provides via Linear's "current state" reads, but webhooks
-- need explicit dedup because they're event-driven, not state-driven.
--
-- Single writer (the orchestrator's HTTP handler) so no row-level locking
-- needed; the PK constraint is the only synchronization primitive.
--
-- Retention: in-process cleanup runs hourly via `pruneWebhookDedup` in
-- `src/webhook/linear-receiver.ts`, scheduled from `main.ts` after the
-- orchestrator starts. The job deletes rows where `received_at < now() -
-- interval '24 hours'` (Linear retries failed deliveries for up to 24h
-- on 5xx, so 24h is the minimum safe window). No `pg_cron` dependency
-- required.
CREATE TABLE IF NOT EXISTS symphony.webhook_dedup (
    delivery_id  TEXT        PRIMARY KEY,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type   TEXT        NOT NULL,
    outcome      TEXT        NOT NULL  -- 'fired', 'duplicate', 'unhandled'
);
CREATE INDEX IF NOT EXISTS webhook_dedup_received_idx
  ON symphony.webhook_dedup (received_at);
