import { execSync } from "node:child_process";
import pkg from "../../package.json" with { type: "json" };

/**
 * Symphony build provenance — surfaces `version + gitSha` everywhere on-call
 * needs to answer "is the fix I just shipped actually live?" without a log
 * dive.
 *
 * Surfaces:
 *  - `/health` response (consumed by Cloud Run probe + curl from anywhere).
 *  - `symphony started` boot banner (first line a deploy operator looks at).
 *  - Slack lifecycle cards (footer with `symphony/<version>+<sha>`).
 *  - GitHub User-Agent + Anthropic `CLAUDE_AGENT_SDK_CLIENT_APP` env (audit).
 *
 * SHA resolution priority:
 *  1. `SYMPHONY_BUILD_SHA` env var — set at image-build / deploy time.
 *  2. `K_REVISION` env var — Cloud Run injects this (e.g. `symphony-orchestrator-00007-abc`).
 *  3. `git rev-parse --short HEAD` — only fires in local dev when a `.git/`
 *     tree is reachable. Never fires in production (the runtime image has
 *     no `.git/`).
 *  4. `"unknown"` — final fallback so misconfigured deploys are visible
 *     in `/health` instead of silently masking the SHA.
 */

export const SYMPHONY_VERSION: string = pkg.version;

let cachedGitSha: string | null = null;

export function readGitSha(env: NodeJS.ProcessEnv = process.env): string {
  if (cachedGitSha !== null) return cachedGitSha;

  const fromBuildArg = (env.SYMPHONY_BUILD_SHA ?? "").trim();
  if (fromBuildArg) {
    cachedGitSha = fromBuildArg.slice(0, 7);
    return cachedGitSha;
  }

  // Cloud Run injects K_REVISION as e.g. "symphony-orchestrator-00007-abc".
  // The trailing fragment isn't a git SHA but it IS a per-revision identifier
  // — useful as a fallback when the build-arg wasn't wired. We surface the
  // last segment after the final "-".
  const fromKRevision = (env.K_REVISION ?? "").trim();
  if (fromKRevision) {
    const tail = fromKRevision.split("-").pop() ?? "";
    if (tail) {
      cachedGitSha = `rev-${tail}`;
      return cachedGitSha;
    }
  }

  // Local-dev fallback: read from .git/. Wrapped in try/catch because the
  // runtime container has no `.git` tree and `execSync` would throw.
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (sha) {
      cachedGitSha = sha;
      return cachedGitSha;
    }
  } catch {
    // Fall through to `unknown`.
  }

  cachedGitSha = "unknown";
  return cachedGitSha;
}

/** Compose the canonical short build identifier: `symphony/<version>+<sha>`. */
export function buildIdentifier(env: NodeJS.ProcessEnv = process.env): string {
  return `symphony/${SYMPHONY_VERSION}+${readGitSha(env)}`;
}

/** Test-only — flush the cache so a test that toggles `SYMPHONY_BUILD_SHA`
 *  sees the new value on its next read. Production code never calls this. */
export function _resetBuildInfoCache(): void {
  cachedGitSha = null;
}
