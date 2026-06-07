#!/usr/bin/env bash
# Symphony `before_run` hook — clone fbaltor/project-cars into the per-issue
# workspace so the Technical plan (and the To implement) specialist works
# against the real repo on disk.
#
# Contract (src/workspace/hooks.ts + src/orchestrator/orchestrator.ts):
#   - Invoked as `bash -c <this path>` with cwd = the per-issue workspace,
#     already created (mkdir) by ensureWorkspace and empty on first attempt.
#   - env carries GITHUB_TOKEN (GH App installation token, or a PAT/OAuth token
#     via resolveGitHubToken). Absent only when neither is configured.
#   - before_run runs on EVERY attempt → must be idempotent.
#   - before_run is fatal-on-failure: a non-zero exit aborts the dispatch.
#
# Auth: token embedded in the remote URL as the password (username
# x-access-token). github.com git-over-HTTPS wants Basic (user:token), NOT an
# `Authorization: Bearer` header, and a configured credential.helper breaks the
# otherwise-anonymous public clone — so URL-embed is the reliable path. It also
# authorizes the agent's later `git push` (the remote carries the token). The
# workspace is ephemeral + single-tenant, so the token in .git/config is
# acceptable. The token value is never echoed.
#
# Idempotent and NON-destructive: when the repo is already present we only
# refresh the remote (token may rotate) + `fetch` (never reset/clean), so an
# in-progress agent branch + commits survive a retry.

set -euo pipefail

OWNER_REPO="fbaltor/project-cars"
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/${OWNER_REPO}.git"
else
  REMOTE="https://github.com/${OWNER_REPO}.git"
fi

if [[ -d .git ]]; then
  echo "setup-workspace: repo already present — refreshing remote + fetching"
  git remote set-url origin "${REMOTE}"
  git fetch --prune origin
else
  echo "setup-workspace: cloning ${OWNER_REPO} into $(pwd)"
  git clone "${REMOTE}" .
fi

echo "setup-workspace: HEAD $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)"
