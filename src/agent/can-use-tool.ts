import { resolve, sep } from "node:path";
import { logger } from "../observability/logger.js";

/**
 * `canUseTool` defense-in-depth for the Claude Agent SDK.
 *
 * Symphony runs with `permissionMode: "bypassPermissions"` because there's
 * no human in the loop to answer interactive prompts. That removes the
 * SDK's per-call gate; this hook reinstates a baseline allowlist:
 *
 *   - `Bash`: deny commands matching well-known dangerous patterns
 *     (`sudo`, `curl`, `wget`, `nc`, `ssh`, `rm -rf /`, fork bombs,
 *     `cd /` to escape the workspace).
 *   - `Edit` / `Write` / `MultiEdit`: reject `file_path` outside the
 *     per-issue workspace. Spec §9.5 invariant 1.
 *   - Everything else (`Read`, `Grep`, `Glob`, MCP tools): allow.
 *
 * The hook is "best-effort security" — a determined exfiltration attack
 * can usually find a way through (e.g. write Python that opens a socket).
 * It's a real-world hardening against the most common ways an autonomous
 * agent can accidentally damage shared infra (running `rm -rf` on the
 * orchestrator's parent dir, opening a reverse shell, etc.).
 *
 * Per the Claude Agent SDK docs, `canUseTool` fires AFTER permissionMode
 * has decided to allow the call — so it's the last guard. It can return:
 *   - `{behavior: "allow", updatedInput?}` — let the call proceed
 *   - `{behavior: "deny", message?}` — refuse with a model-visible reason
 *
 * Callers wire this into `options.canUseTool` on each `query()` call.
 */

export type CanUseToolDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string };

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<CanUseToolDecision>;

/**
 * Bash command patterns that bypass the workspace sandbox or attempt
 * remote network egress / privilege escalation. Kept as a flat list so a
 * single false-positive can be tuned in isolation.
 */
const DENIED_BASH_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: "sudo (privilege escalation)" },
  { pattern: /(^|[\s;&|`(])cd\s+\//, reason: "cd to absolute root (workspace escape)" },
  { pattern: /\bcurl\b/, reason: "curl (network egress)" },
  { pattern: /\bwget\b/, reason: "wget (network egress)" },
  { pattern: /(^|[\s;&|`(])nc\s/, reason: "nc / netcat (network egress)" },
  { pattern: /(^|[\s;&|`(])ssh\b/, reason: "ssh (remote shell)" },
  { pattern: /\brm\s+-[rRf]+\s+\/(?:[^\s]|\s*$)/, reason: "rm -rf at filesystem root" },
  // Classic fork bomb (`:(){ :|: & };:`).
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, reason: "fork bomb" },
];

/**
 * Decision made by the canUseTool hook for a Bash call. Exported for
 * testing — the production hook just returns the SDK shape directly.
 */
export interface BashCheckResult {
  ok: boolean;
  reason?: string;
}

export function checkBashCommand(command: string): BashCheckResult {
  if (!command) return { ok: true };
  for (const { pattern, reason } of DENIED_BASH_PATTERNS) {
    if (pattern.test(command)) return { ok: false, reason };
  }
  return { ok: true };
}

/**
 * Optional self-edit guard. When `SYMPHONY_SELF_PATH_FRAGMENT` is set, writes
 * to any path containing that fragment are denied, preventing an in-flight
 * agent from modifying the orchestrator's own source while it runs. Only
 * relevant in a monorepo layout where Symphony's source lives inside the repo
 * being orchestrated (e.g. set it to `/packages/symphony/`). Empty (the
 * default) disables the check — correct for standalone deployments, where the
 * workspace is the user's repo, not Symphony's.
 */
function selfPathFragment(): string {
  return process.env.SYMPHONY_SELF_PATH_FRAGMENT ?? "";
}

/**
 * Build a `canUseTool` callback bound to a per-issue workspace path. Called
 * once per `runTurn` (workspace path is per-session). The returned callback
 * is invoked synchronously by the SDK; do no I/O inside it beyond local
 * pure checks.
 *
 * `writeCwds`: when set, restricts Edit /
 * Write / MultiEdit calls to ONLY paths inside one of these workspace
 * subdirectories. Each entry is joined with the workspace root (so
 * `["apps", "packages"]` ⇒ `${ws}/apps/**` or `${ws}/packages/**`). An
 * EXPLICIT empty array `[]` means "no file writes allowed at all" — useful
 * for plan-only stages. Omit (`undefined`) to fall back to the default
 * "anywhere inside the workspace" rule.
 */
export function makeCanUseTool(workspacePath: string, writeCwds?: readonly string[]): CanUseToolFn {
  const wsAbs = resolve(workspacePath);
  // Resolve writeCwds against workspace once at session start (cheap, but
  // we'd rather not recompute on every tool call). `undefined` ⇒ no scope
  // restriction; `[]` ⇒ scope is "nothing"; non-empty ⇒ allowlist of dirs.
  const writeCwdsAbs: readonly string[] | undefined =
    writeCwds === undefined ? undefined : writeCwds.map((p) => resolve(wsAbs, p));
  return async (toolName, input) => {
    if (toolName === "Bash") {
      const command = typeof input.command === "string" ? input.command : "";
      const result = checkBashCommand(command);
      if (!result.ok) {
        logger.warn(
          { toolName, command: command.slice(0, 200), reason: result.reason },
          "canUseTool: blocked Bash command",
        );
        return {
          behavior: "deny",
          message: `Symphony canUseTool blocked the Bash command: ${result.reason}. Use a workspace-scoped alternative.`,
        };
      }
      return { behavior: "allow", updatedInput: input };
    }

    if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
      const path = typeof input.file_path === "string" ? input.file_path : "";
      if (!path) {
        // No path in input — let the tool surface its own error.
        return { behavior: "allow", updatedInput: input };
      }
      const target = resolve(path);
      const inside = target === wsAbs || target.startsWith(wsAbs + sep);
      if (!inside) {
        logger.warn(
          { toolName, path, workspace: wsAbs },
          "canUseTool: blocked write outside workspace",
        );
        return {
          behavior: "deny",
          message: `Symphony canUseTool blocked a write to ${path} — Edit/Write/MultiEdit are restricted to the per-issue workspace (${wsAbs}).`,
        };
      }
      // Scope-lock for Symphony itself. Even when the path is inside the
      // workspace, deny writes that land in Symphony's own source tree.
      // The agent shouldn't modify its own orchestrator while it's running.
      const selfFragment = selfPathFragment();
      if (selfFragment && target.includes(selfFragment)) {
        logger.warn(
          { toolName, path, fragment: selfFragment },
          "canUseTool: blocked Symphony self-edit",
        );
        return {
          behavior: "deny",
          message:
            "Symphony canUseTool blocked an edit to Symphony's own source. The orchestrator source is off-limits to in-flight agent runs — file a separate ticket and merge a manual PR if you need to modify it.",
        };
      }
      // Per-state write-scope discipline. When `writeCwds` is set,
      // restrict file writes to ONLY paths inside one of the listed
      // subdirectories. An explicit empty list means "no writes allowed."
      if (writeCwdsAbs !== undefined) {
        if (writeCwdsAbs.length === 0) {
          logger.warn(
            { toolName, path, writeCwds: [] },
            "canUseTool: blocked write — current state allows no file writes",
          );
          return {
            behavior: "deny",
            message:
              "Symphony canUseTool blocked a file write — the current Linear state allows no file writes (write_cwds_by_state[state]: []). This stage is for analysis / Linear comments only.",
          };
        }
        const insideAllowed = writeCwdsAbs.some(
          (allowed) => target === allowed || target.startsWith(allowed + sep),
        );
        if (!insideAllowed) {
          logger.warn(
            { toolName, path, writeCwds: writeCwdsAbs },
            "canUseTool: blocked write outside per-state allowlist",
          );
          return {
            behavior: "deny",
            message: `Symphony canUseTool blocked a write to ${path} — current Linear state restricts writes to: ${writeCwdsAbs.join(
              ", ",
            )}.`,
          };
        }
      }
      return { behavior: "allow", updatedInput: input };
    }

    // Read, Grep, Glob, MCP tools: allow without modification.
    return { behavior: "allow", updatedInput: input };
  };
}
