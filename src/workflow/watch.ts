import { watch, type FSWatcher } from "node:fs";
import { logger } from "../observability/logger.js";
import { loadWorkflow, type RawWorkflow, WorkflowError } from "./loader.js";
import {
  preflightValidate,
  resolveConfig,
  type ResolveContext,
  type SymphonyConfig,
} from "./config.js";

/**
 * Spec §6.2 — watch `WORKFLOW.md`, debounce edits, attempt re-parse and
 * re-resolve, fall back to last known good config on failure.
 */

export interface WorkflowSnapshot {
  raw: RawWorkflow;
  config: SymphonyConfig;
  loadedAt: number;
}

export type WorkflowChangeListener = (snapshot: WorkflowSnapshot) => void;

export class WorkflowWatcher {
  private current: WorkflowSnapshot;
  private listeners = new Set<WorkflowChangeListener>();
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly path: string;
  private readonly resolveCtx: ResolveContext;

  private constructor(path: string, ctx: ResolveContext, initial: WorkflowSnapshot) {
    this.path = path;
    this.resolveCtx = ctx;
    this.current = initial;
  }

  static async start(path: string, env: NodeJS.ProcessEnv): Promise<WorkflowWatcher> {
    const ctx: ResolveContext = { workflowPath: path, env };
    const raw = await loadWorkflow(path);
    const config = resolveConfig(raw, ctx);
    // Fail-fast preflight at boot. The reload path (`reloadFromDisk`)
    // already runs preflightValidate to keep last-known-good on bad
    // edits; the boot path previously did NOT, so a fresh deploy with
    // a malformed WORKFLOW.md would boot successfully and the failure
    // wouldn't surface until the first dispatch tick referenced the
    // missing config (e.g. `state_transitions["Plan"]` returning
    // undefined → orchestrator throws on auto-advance).
    //
    // Now boot fails loudly with the same WorkflowError shape the
    // operator sees on `/admin/reload`, plus a clear log line so the
    // Cloud Run startup probe failure has an actionable error message
    // instead of "/health 503 forever".
    const preflightErr = preflightValidate(config);
    if (preflightErr !== null) {
      throw new WorkflowError(
        "workflow_parse_error",
        `WORKFLOW.md preflight failed at boot: ${preflightErr}`,
      );
    }
    const snapshot: WorkflowSnapshot = { raw, config, loadedAt: Date.now() };
    const w = new WorkflowWatcher(path, ctx, snapshot);
    w.attach();
    return w;
  }

  private attach(): void {
    try {
      this.watcher = watch(this.path, { persistent: true }, (event) => {
        if (event !== "change" && event !== "rename") return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          void this.reload();
        }, 250);
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, path: this.path },
        "fs.watch unavailable; reload disabled",
      );
    }
  }

  private async reload(): Promise<void> {
    await this.reloadFromDisk();
  }

  /**
   * Force a reload from disk on demand. Used by the `POST /admin/reload`
   * HTTP endpoint (A-32 / S-I5) — Cloud Run min=max=1 doesn't see file
   * changes since the file is baked into the image, but an operator with
   * `gcloud run services proxy` access can hit `/admin/reload` after
   * editing the secret-mounted version of WORKFLOW.md without redeploying.
   *
   * Returns the resolved snapshot on success (callers can surface the
   * `loadedAt` timestamp to confirm the new state took effect). Throws on
   * failure with the same `WorkflowError` shape as the watch path; the
   * caller's responsibility to translate that into an HTTP response. The
   * snapshot is only updated on success — last-known-good is preserved.
   */
  async reloadNow(): Promise<WorkflowSnapshot> {
    return await this.reloadFromDisk({ throwOnError: true });
  }

  private async reloadFromDisk(opts: { throwOnError?: boolean } = {}): Promise<WorkflowSnapshot> {
    try {
      const raw = await loadWorkflow(this.path);
      const config = resolveConfig(raw, this.resolveCtx);
      // A-8: Zod-parsed config can still fail spec §6.3 preflight (e.g.
      // a literal `$SLACK_CHANNEL_ID` that survived expansion when the
      // env was unset). Reject the snapshot here so we keep last-known-good
      // instead of letting the orchestrator hit the failure on the next
      // dispatch tick.
      const preflightErr = preflightValidate(config);
      if (preflightErr !== null) {
        throw new WorkflowError("workflow_parse_error", `preflight failed: ${preflightErr}`);
      }
      this.current = { raw, config, loadedAt: Date.now() };
      logger.info({ path: this.path }, "WORKFLOW.md reloaded");
      for (const fn of this.listeners) {
        try {
          fn(this.current);
        } catch (cbErr) {
          logger.error({ err: (cbErr as Error).message }, "workflow change listener threw");
        }
      }
      return this.current;
    } catch (err) {
      const message = err instanceof WorkflowError ? `${err.code}: ${err.message}` : String(err);
      logger.error({ err: message }, "WORKFLOW.md reload failed; keeping last known good config");
      if (opts.throwOnError) throw err;
      return this.current;
    }
  }

  snapshot(): WorkflowSnapshot {
    return this.current;
  }

  onChange(fn: WorkflowChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
