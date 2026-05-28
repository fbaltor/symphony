import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { Workspace } from "../types.js";
import { sanitizeIdentifier } from "../lib/ids.js";
import { logger } from "../observability/logger.js";
import { getDiskFreeBytes, runEmergencyGc } from "./cleanup.js";

/**
 * Free-space threshold below which `ensureWorkspace` runs an emergency GC
 * before allocating a new workspace. 100 MB is small enough to react before
 * the next monorepo clone (~500 MB) would fail with ENOSPC, but big enough
 * to avoid thrashing the GC on noise (a single git fetch may temporarily
 * push 10–30 MB).
 */
export const DISK_PRESSURE_FREE_BYTES = 100 * 1024 * 1024;

/**
 * Spec §9.1 / §9.2 / §9.5 — workspace creation, reuse, and safety invariants.
 *
 * Invariants enforced here:
 *   1. Workspace key sanitized (`sanitizeIdentifier`).
 *   2. Workspace path stays inside workspace root (no escape via `..`).
 */

export class WorkspaceSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSafetyError";
  }
}

export interface EnsureWorkspaceArgs {
  workspaceRoot: string;
  identifier: string;
  /**
   * Optional disk-pressure safeguard. When provided, `ensureWorkspace`
   * checks `statfs(workspaceRoot)` BEFORE creating a new workspace; if
   * free bytes drop below `DISK_PRESSURE_FREE_BYTES`, it runs an
   * emergency GC pass that drops every workspace not currently in
   * `runningKeys`/`claimedKeys`.
   *
   * The orchestrator passes these. Tests / one-off callers can omit
   * them — the safeguard simply doesn't fire.
   */
  diskPressure?: {
    runningKeys: Set<string>;
    claimedKeys: Set<string>;
    beforeRemoveScript: string | null;
    hookTimeoutMs: number;
  };
}

export async function ensureWorkspace(args: EnsureWorkspaceArgs): Promise<Workspace> {
  // Reject relative roots up-front; `resolve()` would otherwise silently
  // resolve them against process.cwd(), which is not what we want.
  if (!isAbsolute(args.workspaceRoot)) {
    throw new WorkspaceSafetyError(`workspace.root must be absolute: ${args.workspaceRoot}`);
  }
  const root = resolve(args.workspaceRoot);
  const key = sanitizeIdentifier(args.identifier);
  const path = resolve(root, key);
  assertContained(root, path);

  // Disk-pressure safeguard: BEFORE allocating new space, check free bytes
  // on the workspace filesystem. tmpfs `/tmp` on Cloud Run is ~1 GB and
  // ~500 MB-per-workspace dispatches fill it after a couple of cycles.
  // The emergency GC drops every non-active workspace so the next clone
  // doesn't ENOSPC.
  if (args.diskPressure) {
    const free = await getDiskFreeBytes(root);
    if (free !== null && free < DISK_PRESSURE_FREE_BYTES) {
      logger.warn(
        { freeBytes: free, threshold: DISK_PRESSURE_FREE_BYTES, root },
        "disk pressure detected; running emergency workspace GC",
      );
      await runEmergencyGc({
        workspaceRoot: root,
        runningKeys: args.diskPressure.runningKeys,
        claimedKeys: args.diskPressure.claimedKeys,
        beforeRemoveScript: args.diskPressure.beforeRemoveScript,
        hookTimeoutMs: args.diskPressure.hookTimeoutMs,
      });
    }
  }

  let createdNow = false;
  try {
    const s = await stat(path);
    if (!s.isDirectory()) {
      throw new WorkspaceSafetyError(`workspace path exists and is not a directory: ${path}`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      await mkdir(path, { recursive: true });
      createdNow = true;
    } else {
      throw err;
    }
  }

  return { path, workspaceKey: key, createdNow };
}

/** Spec §9.5 invariant 2 — root containment. */
export function assertContained(root: string, path: string): void {
  const rootAbs = resolve(root);
  const pathAbs = resolve(path);
  const ok = pathAbs === rootAbs || pathAbs.startsWith(rootAbs + sep);
  if (!ok) {
    throw new WorkspaceSafetyError(`workspace path escapes root: path=${pathAbs} root=${rootAbs}`);
  }
}

/** Spec §9.5 invariant 1 — agent process must launch in the workspace cwd. */
export function assertCwdMatchesWorkspace(cwd: string, workspacePath: string): void {
  const cwdAbs = resolve(cwd);
  const wsAbs = resolve(workspacePath);
  if (cwdAbs !== wsAbs) {
    throw new WorkspaceSafetyError(`agent cwd ${cwdAbs} != workspace ${wsAbs}`);
  }
}
