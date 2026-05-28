import { readdir, rm, stat, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import type { Issue } from "../types.js";
import { sanitizeIdentifier } from "../lib/ids.js";
import { logger } from "../observability/logger.js";
import { runHook } from "./hooks.js";
import { assertContained } from "./manager.js";

/**
 * Spec §8.6 startup terminal cleanup + §8.5 on-transition cleanup.
 *
 * Removes workspace directories belonging to issues that have moved to a
 * terminal state. Failures are logged and skipped — never fatal to the
 * orchestrator.
 */

export interface CleanupArgs {
  workspaceRoot: string;
  identifier: string;
  beforeRemoveScript: string | null;
  hookTimeoutMs: number;
}

export async function cleanupWorkspace(args: CleanupArgs): Promise<boolean> {
  const root = resolve(args.workspaceRoot);
  const path = resolve(root, sanitizeIdentifier(args.identifier));
  try {
    assertContained(root, path);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, identifier: args.identifier },
      "skip cleanup: containment check failed",
    );
    return false;
  }

  // Skip the hook + rm entirely when the workspace doesn't exist (terminal
  // issues that never had work dispatched). Avoids spawning bash with a
  // non-existent cwd, which logs noisy warnings for nothing.
  let exists = true;
  try {
    await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      exists = false;
    }
  }
  if (!exists) return false;

  // before_remove hook: failures logged + ignored.
  await runHook({
    kind: "before_remove",
    script: args.beforeRemoveScript,
    cwd: path,
    timeoutMs: args.hookTimeoutMs,
  });

  try {
    await rm(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message, path }, "failed to remove workspace; continuing");
    return false;
  }
}

/** Bulk cleanup invoked at startup over a list of terminal-state issues. */
export async function cleanupTerminalIssues(args: {
  workspaceRoot: string;
  issues: Issue[];
  beforeRemoveScript: string | null;
  hookTimeoutMs: number;
}): Promise<void> {
  for (const issue of args.issues) {
    await cleanupWorkspace({
      workspaceRoot: args.workspaceRoot,
      identifier: issue.identifier,
      beforeRemoveScript: args.beforeRemoveScript,
      hookTimeoutMs: args.hookTimeoutMs,
    });
  }
}

/**
 * Free bytes available on the filesystem hosting `path`. Returns null when
 * the syscall fails (e.g. `path` doesn't exist yet) so callers can fall back
 * to "skip the safeguard" rather than crash the orchestrator.
 *
 * Uses `node:fs/promises.statfs` (Node 18.15+, our floor is Node 22).
 * Returns `bavail * bsize`, mirroring `df`'s "Available" column.
 */
export async function getDiskFreeBytes(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    // bavail/bsize fit in JS number safely for any tmpfs we'd encounter
    // (Cloud Run's /tmp is on the order of GB; max safe int is ~9 PB).
    return Number(s.bavail) * Number(s.bsize);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, path },
      "statfs failed; disk-pressure safeguard disabled for this call",
    );
    return null;
  }
}

export interface GcArgs {
  workspaceRoot: string;
  /** Sanitized workspace keys whose worker is currently running. */
  runningKeys: Set<string>;
  /** Sanitized workspace keys reserved by claimed/retry/continuation entries. */
  claimedKeys: Set<string>;
  beforeRemoveScript: string | null;
  hookTimeoutMs: number;
}

export interface PeriodicGcArgs extends GcArgs {
  /** Minimum mtime age (ms) before a stale workspace is eligible for removal. */
  gcMaxAgeMs: number;
  /** Optional `Date.now`-style clock for tests. */
  now?: () => number;
}

/**
 * Periodic GC pass — removes workspace directories that:
 *   1. Aren't tied to any live worker (`runningKeys`)
 *   2. Aren't tied to any pending dispatch (`claimedKeys`)
 *   3. Haven't been mtime-touched in `gcMaxAgeMs`
 *
 * Each removal goes through the same `before_remove` hook + `rm -rf` path
 * as terminal-state cleanup so user hook scripts (e.g. `git stash list`,
 * disk-usage logging) fire consistently.
 *
 * Returns the number of workspaces actually removed.
 */
export async function runPeriodicGc(args: PeriodicGcArgs): Promise<number> {
  return await runGcPass({ ...args, mode: "periodic" });
}

/**
 * Emergency GC — invoked when free space on `workspace.root`'s filesystem
 * drops below the safeguard threshold. Bypasses the age check and removes
 * every workspace not in `runningKeys` / `claimedKeys`.
 */
export async function runEmergencyGc(args: GcArgs): Promise<number> {
  return await runGcPass({ ...args, gcMaxAgeMs: 0, mode: "emergency" });
}

interface GcPassArgs extends GcArgs {
  gcMaxAgeMs: number;
  mode: "periodic" | "emergency";
  now?: () => number;
}

async function runGcPass(args: GcPassArgs): Promise<number> {
  const root = resolve(args.workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    logger.warn(
      { err: (err as Error).message, root },
      "workspace gc: failed to readdir; skipping pass",
    );
    return 0;
  }

  const now = (args.now ?? Date.now)();
  let removed = 0;
  for (const name of entries) {
    if (args.runningKeys.has(name) || args.claimedKeys.has(name)) continue;
    const path = resolve(root, name);
    try {
      assertContained(root, path);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, name },
        "workspace gc: skip entry (containment check failed)",
      );
      continue;
    }
    let isDir = false;
    let mtimeMs = 0;
    try {
      const s = await stat(path);
      isDir = s.isDirectory();
      mtimeMs = s.mtimeMs;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger.warn(
          { err: (err as Error).message, path },
          "workspace gc: stat failed; skipping entry",
        );
      }
      continue;
    }
    if (!isDir) continue;
    const ageMs = now - mtimeMs;
    if (args.mode === "periodic" && ageMs < args.gcMaxAgeMs) continue;

    await runHook({
      kind: "before_remove",
      script: args.beforeRemoveScript,
      cwd: path,
      timeoutMs: args.hookTimeoutMs,
    });
    try {
      await rm(path, { recursive: true, force: true });
      removed++;
      logger.info({ path, ageMs, mode: args.mode }, "workspace gc: removed stale workspace");
    } catch (err) {
      logger.warn({ err: (err as Error).message, path }, "workspace gc: rm failed; continuing");
    }
  }
  if (removed > 0) {
    logger.info({ removed, mode: args.mode, root }, "workspace gc: pass complete");
  }
  return removed;
}
