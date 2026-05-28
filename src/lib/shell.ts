import { spawn } from "node:child_process";

/**
 * Spec §9.4 hook execution contract — `bash -c <script>` with a timeout, in a
 * given cwd. Returns exit code, stdout, stderr.
 *
 * Switched from `bash -lc` to `bash -c` per IMPROVEMENTS.md A-26: the login-
 * shell flag (`-l`) sources `/etc/profile` + `~/.bash_profile` + `~/.bashrc`
 * before running the script, which leaks the host's PATH/PROMPT/locale into
 * hook execution. On Cloud Run's minimal image those files are typically empty
 * but on developer machines they can shadow PWD or set unexpected env. Plain
 * `-c` is the hermetic invocation.
 */

export interface ShellResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunShellOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

/** Cap each of stdout/stderr at this size to keep the long-running daemon from
 * leaking memory on noisy hooks. We keep the most-recent bytes (tail) since
 * that's usually what diagnoses a failure. */
const MAX_CAPTURE_BYTES = 1_000_000;
const TRUNCATION_MARKER = "\n…[truncated]\n";

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (next.length <= MAX_CAPTURE_BYTES) return next;
  // Keep the tail: drop the oldest bytes so failure diagnostics survive.
  return TRUNCATION_MARKER + next.slice(next.length - MAX_CAPTURE_BYTES);
}

export async function runShell(script: string, opts: RunShellOptions): Promise<ShellResult> {
  return new Promise((resolve) => {
    // `detached: true` puts the shell in its own process group so we can SIGKILL
    // the *whole tree* on timeout. Without this, `child.kill("SIGKILL")` reaps
    // only the bash shell and leaves grandchildren (e.g. a hung `pnpm install`)
    // running orphaned.
    const child = spawn("bash", ["-c", script], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });

    const killTree = (): void => {
      if (typeof child.pid !== "number") {
        // Fallback if no pid (e.g., spawn error before fork).
        child.kill("SIGKILL");
        return;
      }
      try {
        // Negative pid → process group. Detached above guarantees a fresh pgid.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Process group may already be gone; fall back to direct kill.
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree();
      },
      Math.max(1, opts.timeoutMs),
    );

    // `close` and `error` can both fire in some failure modes; only the first
    // event resolves the promise.
    let settled = false;
    const finish = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal, stdout, stderr, timedOut });
    });

    child.on("error", (err) => {
      finish({
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr + String(err.message),
        timedOut,
      });
    });
  });
}
