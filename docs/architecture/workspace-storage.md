# Workspace storage — `/tmp` over GCS-FUSE

> Decision: Symphony stores per-issue workspaces on tmpfs (`/tmp`), not on a
> GCS-FUSE-mounted volume. Reasons + trade-offs below. Source of truth:
> `WORKFLOW.example.md` `workspace.root: /tmp/symphony-workspaces`.

## Background

Spec [§9](https://github.com/openai/symphony/blob/main/SPEC.md) describes
per-issue workspaces as durable state — each issue gets a directory under
`workspace.root`, the orchestrator runs lifecycle hooks (`after_create`,
`before_run`, `after_run`, `before_remove`) inside it, and the directory
persists across runs unless the issue moves to a terminal state.

A natural Cloud Run mapping is:

- Mount a GCS bucket at `/workspaces` via the Cloud Run **Volumes — Cloud
  Storage** integration (which uses [GCS-FUSE](https://cloud.google.com/storage/docs/cloud-storage-fuse/overview)).
- Set `workspace.root: /workspaces` so each per-issue dir lives in GCS.
- Workspaces survive revision rollovers (the bucket stays); a new revision
  picks up the orchestrator's running issues' workspaces from where the
  previous one left off.

We tested this approach — until the **chmod incompatibility** below blocked
it, and the workspace root was switched to tmpfs.

## Why GCS-FUSE didn't work

GCS doesn't have file-mode bits — there's no `chmod` semantically. The FUSE
driver translates POSIX calls to GCS object operations as best it can, but
some operations have no mapping. Specifically:

- `chmod(path, mode)` — emulated as a no-op on GCS-FUSE. Always succeeds
  with whatever the driver decides.
- `git clone` — internally writes `<repo>/.git/config.lock`, then calls
  `chmod()` on the lock to fix permissions before renaming it to `.git/config`.
  On GCS-FUSE the chmod returns "Operation not permitted" (some GCS-FUSE
  releases) or the rename later fails because of unexpected permission
  bits set during the no-op chmod. Either way, `git clone` reports
  `error: chmod on .git/config.lock: Operation not permitted` and aborts.

Result: WORKFLOW.md's `before_run` hook (which `git clone`s the monorepo if
not present) fails on every dispatch under GCS-FUSE.

We tested `pnpm install` next — same story: `chmod` calls during `node_modules`
extraction fail. Cloud Run's GCS-FUSE volume is unfit for a workspace that
runs git + node tooling.

## What we picked instead

`workspace.root: /tmp/symphony-workspaces` — Cloud Run's POSIX-compliant tmpfs.

Trade-offs:

| Property                             | GCS-FUSE volume                      | tmpfs `/tmp` (current)              |
| ------------------------------------ | ------------------------------------ | ----------------------------------- |
| Survives Cloud Run revision rollover | ✅ yes                               | ❌ no — dropped per-revision        |
| Cross-instance shared state          | ✅ yes (single bucket)               | ❌ no — instance-local              |
| `chmod` works                        | ❌ no                                | ✅ yes                              |
| `git clone` works                    | ❌ no                                | ✅ yes                              |
| Capacity                             | ~unlimited                           | ~1 GB tmpfs (Cloud Run default)     |
| Cleanup discipline needed            | bucket lifecycle (7d on `terminal/`) | in-app GC + emergency-disk-pressure |

Notably the **persistence** trade-off matters less than it looks because
Symphony runs with `min=max=1` (required by the singleton lock design):

- Only one instance ever runs at a time — there's no cross-instance sharing
  to lose.
- Revision rollovers happen during deploys (a few times per week at most).
  The `before_run` hook is idempotent: clone if missing, fetch+reset if
  already present. A rollover wipes `/tmp`, the next dispatch's `before_run`
  re-clones — adds ~30 s to the first turn after a deploy. Acceptable.

## Workspace GC

`/tmp` on Cloud Run is ~1 GB by default. Each dispatch leaves a ~500 MB
workspace (cloned monorepo + `node_modules`). Without periodic cleanup,
two dispatches fill `/tmp` and the next clone fails with `ENOSPC`.

`workspace/cleanup.ts` runs two GC paths:

- **Periodic GC** (`gcIntervalMs: 600_000` / `gcMaxAgeMs: 3_600_000`
  default). Every 10 min, sweeps workspace dirs whose mtime is older than
  1 h AND don't belong to a running/claimed issue.
- **Emergency GC** (`workspace/manager.ts#DISK_PRESSURE_FREE_BYTES`,
  100 MB threshold). Before allocating a new workspace, `ensureWorkspace`
  calls `statfs(workspaceRoot)` — if free space is below 100 MB, it
  bypasses the age check and drops every non-active workspace.

Both paths run the `before_remove` hook so user scripts (e.g.
`git stash list`, disk-usage logging) fire consistently.

## When to revisit

Revisit GCS-FUSE if any of these change:

- Cloud Run's GCS-FUSE driver gains real chmod/POSIX-mode support.
- Symphony moves off `min=max=1` to multiple concurrent instances —
  cross-instance shared state would re-emerge as load-bearing.
- Workspace size grows past tmpfs cap — a 4-GB monorepo clone wouldn't
  fit and the GC bandaid alone wouldn't help.

Neither of the above scenarios is imminent; this doc records the investigation
so the decision doesn't have to be re-derived if the constraints change.

## Related code

- `WORKFLOW.example.md` — frontmatter `workspace.root` + `workspace.gc_interval_ms` /
  `workspace.gc_max_age_ms`.
- `src/workflow/config.ts` — Zod schema + defaults for the workspace block.
- `src/workspace/manager.ts` — `ensureWorkspace`, `DISK_PRESSURE_FREE_BYTES`,
  `assertContained`, `assertCwdMatchesWorkspace`.
- `src/workspace/cleanup.ts` — periodic + emergency GC, `getDiskFreeBytes`.
- `src/workspace/hooks.ts` — `after_create` / `before_run` / `after_run` /
  `before_remove` execution contract.
