import { runShell } from "../lib/shell.js";
import { logger } from "../observability/logger.js";

/**
 * Spec §9.4 — workspace lifecycle hooks.
 *
 *   after_create   — fatal to workspace creation if it fails
 *   before_run     — fatal to current attempt if it fails
 *   after_run      — failures logged & ignored
 *   before_remove  — failures logged & ignored
 */

export type HookKind = "after_create" | "before_run" | "after_run" | "before_remove";

export interface HookExecArgs {
  kind: HookKind;
  script: string | null;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Additional env vars to merge on top of `env` (or `process.env` when env
   * is unset). Used to inject short-lived secrets like a freshly minted
   * GITHUB_TOKEN per hook call without mutating the orchestrator's process
   * env.
   */
  extraEnv?: Record<string, string | undefined>;
}

export interface HookResult {
  ran: boolean;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const FATAL_ON_FAILURE: Record<HookKind, boolean> = {
  after_create: true,
  before_run: true,
  after_run: false,
  before_remove: false,
};

export async function runHook(args: HookExecArgs): Promise<HookResult> {
  if (!args.script) return notRun();

  logger.debug({ hook: args.kind, cwd: args.cwd }, "running hook");
  const baseEnv = args.env ?? process.env;
  const mergedEnv: NodeJS.ProcessEnv = args.extraEnv
    ? { ...baseEnv, ...filterDefined(args.extraEnv) }
    : baseEnv;
  const res = await runShell(args.script, {
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    env: mergedEnv,
  });

  const ok = !res.timedOut && res.exitCode === 0;
  if (!ok) {
    const level = FATAL_ON_FAILURE[args.kind] ? "error" : "warn";
    logger[level](
      {
        hook: args.kind,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        stderr: res.stderr.slice(0, 4000),
      },
      "hook failed",
    );
  }
  return {
    ran: true,
    ok,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    timedOut: res.timedOut,
  };
}

export function isFatal(kind: HookKind): boolean {
  return FATAL_ON_FAILURE[kind];
}

function notRun(): HookResult {
  return { ran: false, ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false };
}

/** Drop undefined keys from an env-overlay before merging with process.env. */
function filterDefined(extra: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
