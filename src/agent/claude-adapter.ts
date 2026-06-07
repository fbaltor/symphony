import { randomUUID } from "node:crypto";
import { logger, withContext } from "../observability/logger.js";
import type { AgentEvent } from "./events.js";
import { AsyncQueue } from "./event-queue.js";
import { makeCanUseTool } from "./can-use-tool.js";
import type {
  AgentRunner,
  AgentSessionHandle,
  RunTurnArgs,
  RunTurnResult,
  StartSessionArgs,
} from "./runner.js";

/**
 * Spec §10 — `AgentRunner` adapter over `@anthropic-ai/claude-agent-sdk`.
 *
 * Each `runTurn` invocation drives one `query()` call. Symphony's "session"
 * is a logical grouping of one or more turns under a single worker — there
 * is no long-lived subprocess between turns in the Claude SDK model.
 *
 * Stall detection: a watchdog timer fires if no message is received for
 * `stallTimeoutMs`. When the timer fires we abort the underlying query.
 */

export interface ClaudeQueryMessage {
  type: "assistant" | "user" | "system" | "result";
  message?: { content?: unknown };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    /**
     * prompt-caching token tracking.
     *
     * Anthropic returns these on every message that hits a cached prefix:
     *   - `cache_creation_input_tokens` — tokens billed at the cache-write
     *     fee (1.25× standard for the default 5-min TTL).
     *   - `cache_read_input_tokens` — tokens served from cache, no
     *     model-side recomputation. Read fee is ~10% of the standard
     *     input-token rate.
     *
     * Both are subsets of the would-be input-token count had caching been
     * disabled. Non-cached input lives in `input_tokens`.
     *
     * We accumulate them across the turn and forward them to the audit
     * row (symphony.run_audit.cache_*_tokens) + the Slack succeeded card
     * so operators can verify cache hit-rate without grepping logs.
     *
     * `excludeDynamicSections: true` on the systemPrompt below is what
     * makes the Symphony-managed system prefix cacheable in the first
     * place — without that flag the SDK injects working-dir + git-status
     * into the system prompt, invalidating the cache on every dispatch.
     */
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

export type ClaudeQueryFn = (args: {
  prompt: string;
  options: {
    cwd: string;
    model?: string;
    permissionMode?: string;
    abortController?: AbortController;
    maxTurns?: number;
    mcpServers?: Record<string, ClaudeMcpServerOption>;
    /**
     * Disable reading settings (CLAUDE.md, AGENTS.md, .claude/settings.json)
     * from the workspace cwd and parent directories. Symphony's WORKFLOW.md
     * IS the user-turn prompt; without this, the cloned monorepo's
     * AGENTS.md (with rules like "AskUserQuestion before edit") leaks
     * into the agent's context.
     */
    settingSources?: string[];
    /**
     * SDK system prompt selector.
     *
     * Default (no `systemPrompt`): the Agent SDK uses an internal "default"
     * system prompt that includes a malware-refusal reminder. When the
     * agent reads source files in an Implement-stage context, that
     * reminder fires verbatim ("Whenever you read a file, you should
     * consider whether it would be considered malware... you MUST refuse
     * to improve or augment the code"), and the agent legitimately
     * declines to push commits — observed across 11
     * identical dispatches.
     *
     * `{ type: "preset", preset: "claude_code" }` switches to the same
     * preset that powers the Claude Code CLI, which is permissive about
     * editing files in trusted workspaces. Symphony's workspace IS
     * trusted (cloned from a private repo we own), so this is the
     * correct preset.
     *
     * `append` is layered on top — we use it to inject symphony-specific
     * autonomous rules (no AskUserQuestion, write substantive comments,
     * etc.) without losing the preset's tool-use guidance.
     */
    systemPrompt?:
      | string
      | {
          type: "preset";
          preset: "claude_code";
          append?: string;
          /**
           * when true, the SDK omits the per-session
           * dynamic context (working dir, memory path, git status) from the
           * system prompt. This makes the static preset prefix cacheable
           * across sessions — same prefix on every dispatch ⇒ Anthropic
           * cache_read_input_tokens > 0 from the second dispatch onward.
           *
           * Tradeoff acknowledged: the dynamic context moves into the user
           * message instead of the system prompt. Symphony already passes
           * `workspacePath` via `buildSpecialistPrompt` so the agent has
           * what it needs in the user-turn body; nothing material is lost.
           */
          excludeDynamicSections?: boolean;
        };
    /**
     * Settings overrides — empty placeholder for future use (e.g.
     * `forceLoginMethod`, `cwd` — passed through to the SDK if set).
     */
    [key: string]: unknown;
  };
}) => AsyncIterable<ClaudeQueryMessage>;

/**
 * Subset of the Claude SDK's MCP server descriptor that we forward through.
 * Supports both stdio (npm-shipped MCP servers) and http (hosted MCPs like
 * Linear / GitHub / Notion).
 */
export type ClaudeMcpServerOption =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      // in-process MCP server. The Claude Agent SDK accepts
      // a server instance (built via `createSdkMcpServer`-style helpers)
      // and dispatches tool calls without spawning a subprocess. Used by
      // the `linear_graphql` tool so agents reuse Symphony's tracker auth.
      type: "sdk";
      name: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance: any;
    };

export type McpServersResolver = () => Promise<Record<string, ClaudeMcpServerOption>>;

export type AgentEffort = "low" | "medium" | "high" | "max";

export interface ClaudeAdapterOptions {
  model?: string;
  /**
   * forwarded to Anthropic's adaptive thinking config as
   * `thinking: { type: "adaptive", effort }`. Omitted ⇒ SDK default
   * (currently `medium` per Anthropic's 2026 SDK rollout).
   *
   * NOTE: setting this changes the message-level thinking shape, which
   * invalidates per-message cache breakpoints (system-prompt cache
   * survives — see prompt-caching docs). Keep it stable across a worker's
   * turns for cache-hit consistency.
   */
  effort?: AgentEffort;
  /** Override for tests — inject a stub `query` function. */
  queryImpl?: ClaudeQueryFn;
  /**
   * Optional async hook to construct `mcpServers` per turn. Called once at
   * the top of each `runTurn` so each turn picks up freshly-minted GitHub
   * App tokens (which expire ~1h after issuance). Returns an empty object
   * when no MCPs are configured — the SDK accepts that.
   */
  mcpServersResolver?: McpServersResolver;
}

export class ClaudeAgentRunner implements AgentRunner {
  readonly kind = "claude";
  private readonly opts: ClaudeAdapterOptions;
  private resolvedQueryFn: ClaudeQueryFn | null;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.opts = opts;
    this.resolvedQueryFn = opts.queryImpl ?? null;
  }

  async startSession(args: StartSessionArgs): Promise<AgentSessionHandle> {
    const threadId = `claude-${randomUUID()}`;
    const sessionId = `${threadId}-init`;
    const log = withContext({ ...args.logContext, session_id: sessionId });
    log.info({ workspace: args.workspacePath }, "session_started (claude)");

    // real event queue replaces the previous placeholder. The
    // queue lives for the session lifetime; runTurn pushes per-message
    // events into it as the SDK stream emits, and `endSession`
    // closes() it so consumers iterating via for-await drain cleanly.
    // Stash the queue on the handle via the events iterable so callers
    // (orchestrator, observers) can subscribe; we keep a private
    // reference too for runTurn / endSession.
    const queue = new AsyncQueue<AgentEvent>({
      name: `claude-session-${threadId.slice(0, 8)}`,
      maxBuffered: 256,
    });
    queue.push({
      event: "session_started",
      timestamp: Date.now(),
      pid: null,
      payload: { sessionId, workspace: args.workspacePath },
    });

    const handle: AgentSessionHandle & { _eventQueue?: AsyncQueue<AgentEvent> } = {
      sessionId,
      threadId,
      pid: null,
      workspacePath: args.workspacePath,
      events: queue,
    };
    handle._eventQueue = queue;
    return handle;
  }

  async runTurn(session: AgentSessionHandle, args: RunTurnArgs): Promise<RunTurnResult> {
    const queryFn = await this.getQueryFn();
    const ac = new AbortController();
    let externallyAborted = false;
    // External signal (from the orchestrator's reconciliation loop) drives the
    // same internal AbortController so the in-flight turn actually stops.
    // We track the listener and remove it in `finally` to avoid leaking one
    // listener per turn — the per-worker signal is reused across turns.
    let externalAbortHandler: (() => void) | null = null;
    if (args.signal) {
      if (args.signal.aborted) {
        externallyAborted = true;
        ac.abort();
      } else {
        externalAbortHandler = (): void => {
          externallyAborted = true;
          ac.abort();
        };
        args.signal.addEventListener("abort", externalAbortHandler);
      }
    }
    const timeoutTimer = setTimeout(() => ac.abort(), Math.max(1, args.turnTimeoutMs));
    let lastEventAt = Date.now();
    const stallTimer =
      args.stallTimeoutMs > 0
        ? setInterval(
            () => {
              if (Date.now() - lastEventAt > args.stallTimeoutMs) ac.abort();
            },
            Math.max(500, Math.floor(args.stallTimeoutMs / 4)),
          )
        : null;

    let inputTokens = 0;
    let outputTokens = 0;
    // prompt-cache observability. `cache_creation_input_tokens`
    // counts what Anthropic charged at the cache-write fee; `cache_read_*`
    // counts what was served from cache. We only see non-zero `cache_read_*`
    // from the second dispatch onward (within the 5-min TTL); the first
    // dispatch pays the write fee on its way to populating the cache.
    let cacheCreationInputTokens = 0;
    let cacheReadInputTokens = 0;
    let costUsd = 0;
    let resultMessage: ClaudeQueryMessage | null = null;
    let outcome: RunTurnResult["outcome"] = "completed";
    let errorMessage: string | undefined;
    // per-issue cap tracking. When `perIssueCapUsd` is set,
    // each cost-bearing SDK message triggers a check against the
    // cumulative spend (already recorded + this turn's running total).
    // If the cumulative exceeds the cap, we abort + record below.
    // ALSO check the per-state turn cap (covers the case where one
    // turn would burn more than the state's per-turn budget allows even
    // if the cumulative-issue budget would otherwise still fit).
    let capExceeded = false;
    let capExceededReason: "issue" | "state" | null = null;
    const cap = args.perIssueCapUsd ?? 0;
    const alreadyRecorded = args.alreadyRecordedCostUsd ?? 0;
    const perStateCap = args.perStateCapUsd ?? 0;

    // Resolve MCP servers per-turn so each turn gets freshly minted tokens
    // (GitHub App installation tokens expire ~1h). Failure to resolve is
    // logged and we proceed with no MCPs rather than failing the turn.
    let mcpServers: Record<string, ClaudeMcpServerOption> | undefined;
    if (this.opts.mcpServersResolver) {
      try {
        mcpServers = await this.opts.mcpServersResolver();
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          "claude.mcp_resolver_failed; proceeding without MCPs",
        );
      }
    }

    // pull the per-session event queue off the handle ONCE at the
    // top so both the SDK message-loop emitter and the post-stream
    // `finalEvent` push reach the same queue. Best-effort — never lets
    // a queue operation throw or block the SDK stream.
    const eventQueue: AsyncQueue<AgentEvent> | undefined = (
      session as AgentSessionHandle & { _eventQueue?: AsyncQueue<AgentEvent> }
    )._eventQueue;

    try {
      const stream = queryFn({
        prompt: args.prompt,
        options: {
          cwd: session.workspacePath,
          model: this.opts.model,
          // **PERMISSION-MODE NOTE — DO NOT REVERT TO `bypassPermissions`.**
          //
          // `bypassPermissions` makes the underlying Claude Code CLI
          // auto-accept every tool call and SKIP the permission-prompt-tool
          // path entirely. With that mode set, the CLI never asks the SDK
          // about a tool call, so `canUseTool` (passed below) never fires.
          // All defense-in-depth that depends on `canUseTool` —
          //   - bash deny patterns (sudo, cd /, curl, wget, …)
          //   - Symphony self-edit lock (blocks writes to own source tree)
          //   - per-state writeCwds restriction
          //   - workspace-bound Edit/Write path containment (spec §9.5)
          // — is silently defeated when `bypassPermissions` is set.
          //
          // Surfaced by two incidents: one Implement turn ran 20 internal
          // turns generating 35K tokens; the agent reported `canUseTool was
          // never invoked on this dispatch path`, and another
          // confirmed `Read /etc/passwd` succeeded without any guard
          // firing. `gcloud logging read … "canUseTool"` returned ZERO
          // results across both dispatch windows.
          //
          // The right behavior: leave `permissionMode` unset (defaults to
          // `"default"`). When `canUseTool` is provided, the SDK
          // automatically passes `--permission-prompt-tool stdio` to the
          // CLI, which routes EVERY permission decision through the
          // callback we wired below. canUseTool gets to allow/deny based
          // on its rules, fully restoring the defense-in-depth.
          //
          // We cannot use `permissionMode: "default"` AND
          // `bypassPermissions` simultaneously — they're a config
          // dichotomy, not orthogonal flags.
          abortController: ac,
          // defense-in-depth. canUseTool is invoked by the
          // SDK for EVERY tool call (because permissionMode is left at
          // its default "default" value, which routes through stdio).
          // Blocks Bash commands matching dangerous patterns and refuses
          // Edit/Write/MultiEdit calls outside the per-issue workspace
          // (or outside per-state writeCwds when set).
          canUseTool: makeCanUseTool(session.workspacePath, args.writeCwds),
          // Per-query SDK step cap. Each symphony turn calls `query()` once
          // and we want the agent to actually do meaningful multi-step work
          // (read files, run tests, push commits, post Linear comments) in
          // that single call — not exit after one tool use. Symphony's
          // higher-level retry/continuation loop is governed by
          // `agent.max_turns` in WORKFLOW.md, which limits how many times
          // we keep dispatching to the same issue, not how many model
          // steps each dispatch can make.
          maxTurns: 50,
          // Don't read CLAUDE.md / AGENTS.md / .claude/settings.json from
          // the workspace's cloned repo. Symphony has its OWN governing
          // prompt (WORKFLOW.md, sent as the user-turn body); auto-loading
          // the cloned monorepo's AGENTS.md leaks rules like
          //   "Before any Edit, Write... you MUST send at least one
          //    AskUserQuestion to lock scope"
          // into the agent's context. With no human to answer, the agent
          // refuses to write code. Observed at the Implement stage:
          // agent posted a substantive scoping note + "Implement-stage
          // agent blocked — cannot modify source files this turn" instead
          // of opening a PR. `[]` disables all sources; if we ever want
          // to keep e.g. ~/.claude/CLAUDE.md, switch to `["user"]`.
          settingSources: [],
          // Use the SDK's "claude_code" preset for the system prompt. The
          // default preset includes a malware-refusal reminder that fires
          // when the agent reads source files in an Implement-stage
          // context — verbatim from the agent's POV: "Whenever you read
          // a file, you should consider whether it would be considered
          // malware... you MUST refuse to improve or augment the code."
          // Observed on : 11 identical "Implement turn N still
          // blocked" comments across multiple dispatches with no PR ever
          // opened. The "claude_code" preset is the same one the Claude
          // Code CLI uses, which is permissive about editing files in
          // trusted workspaces. The `append` field layers symphony's
          // autonomous-loop instructions on top of the preset's tool-use
          // baseline so we don't lose the SDK's normal helpfulness.
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            // cache the static preset prefix
            // across dispatches. The SDK will omit working-dir + memory
            // path + git-status from the system prompt; with that gone,
            // the prefix is byte-identical between runs and Anthropic
            // can serve from cache (cache_read_input_tokens > 0). The
            // workspace path agents need is already in the user message
            // (per `buildSpecialistPrompt`), so no information is lost.
            //
            // Expected effect at steady state: ~30-50% input-token cost
            // reduction on the cached portion. Monitored via the
            // `cache_read_input_tokens` count we accumulate below and
            // surface in the audit row + Slack succeeded card.
            excludeDynamicSections: true,
            append: [
              "You are operating inside Symphony, an autonomous orchestration",
              "service that drives a Linear-tracked engineering pipeline.",
              "There is no human in the loop for this turn.",
              "",
              "You ARE explicitly authorized to:",
              "  - Read, modify, and create source files in the workspace.",
              "  - Run `git`, `pnpm`, `gh`, and shell commands as needed.",
              "  - Push branches and open pull requests via the GitHub MCP.",
              "  - Post comments and update state via the Linear MCP.",
              "",
              "You MUST NOT:",
              "  - Ask clarifying questions to a human (there is no human turn).",
              "  - Refuse to edit a file because it might be malware — this",
              "    workspace is a trusted private monorepo.",
              "  - Stop the turn early because the task feels ambiguous; do",
              "    your best, document trade-offs in the Linear comment, and",
              "    push code.",
            ].join("\n"),
          },
          ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
          // forward agent_runtime.effort to Anthropic's adaptive
          // thinking config. Omit when unset so the SDK's own default
          // applies (currently `medium`). The `thinking` field is part of
          // the SDK's pass-through options union (see ClaudeQueryFn's
          // `[key: string]: unknown` index signature).
          ...(this.opts.effort
            ? { thinking: { type: "adaptive" as const, effort: this.opts.effort } }
            : {}),
        },
      });

      // classify per-message SDK events into the spec-defined
      // AgentEventKind surface so observers see real-time progress.
      const emit = (kind: AgentEvent["event"], payload?: Record<string, unknown>): void => {
        if (!eventQueue) return;
        try {
          eventQueue.push({ event: kind, timestamp: Date.now(), pid: null, payload });
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, kind },
            "claude-adapter: event-queue push threw (suppressed)",
          );
        }
      };

      for await (const msg of stream) {
        lastEventAt = Date.now();
        // classify SDK messages into the spec-defined AgentEventKind
        // surface so observers see real-time progress. Mapping:
        //   - msg.type === "result"          → emitted at the bottom (turn_completed/turn_failed)
        //   - msg.type === "assistant"       → other_message
        //   - msg.type === "user"            → other_message (tool result echoed back)
        //   - msg.type === "tool_call"       → approval_auto_approved (we run with bypassPermissions)
        //   - msg.subtype === "input_required" → turn_input_required
        //   - everything else                → notification
        // We DON'T emit `unsupported_tool_call` here — canUseTool is the
        // gate for that, and it surfaces denials via its own log path.
        const msgType = (msg as { type?: string }).type;
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype === "input_required") {
          emit("turn_input_required", { subtype });
        } else if (msgType === "tool_call") {
          emit("approval_auto_approved", {
            tool: (msg as { name?: string }).name ?? "unknown",
          });
        } else if (msgType === "assistant" || msgType === "user") {
          emit("other_message", { msgType });
        } else if (msgType !== "result") {
          emit("notification", { msgType });
        }

        if (msg.usage) {
          inputTokens += msg.usage.input_tokens ?? 0;
          outputTokens += msg.usage.output_tokens ?? 0;
          // track cache-fee subsets so the audit row + Slack
          // card can show hit-rate. These fields may be undefined on SDK
          // versions that don't surface cache usage; the `?? 0` guards
          // against that without a runtime check.
          cacheCreationInputTokens += msg.usage.cache_creation_input_tokens ?? 0;
          cacheReadInputTokens += msg.usage.cache_read_input_tokens ?? 0;
        }
        if (typeof msg.total_cost_usd === "number") {
          costUsd = msg.total_cost_usd;
          // mid-stream cap check. The SDK surfaces total_cost_usd on
          // result messages and (depending on transport) running messages;
          // either way, a check after each update aborts before the next
          // tool-call kicks off another expensive sub-task.
          if (cap > 0 && alreadyRecorded + costUsd > cap) {
            capExceeded = true;
            capExceededReason = "issue";
            ac.abort();
          } else if (perStateCap > 0 && costUsd > perStateCap) {
            // per-state cap independently. THIS turn alone exceeded
            // the state's per-turn budget (e.g. an Implement turn that
            // ran $30 in a state configured with $25 cap). Abort even
            // when the issue-wide cumulative is still under perIssueCap.
            capExceeded = true;
            capExceededReason = "state";
            ac.abort();
          }
        }
        if (msg.type === "result") {
          resultMessage = msg;
          if (msg.is_error) {
            outcome = "failed";
            errorMessage = msg.result ?? "result error";
          }
        }
      }
    } catch (err) {
      const aborted = ac.signal.aborted;
      if (capExceeded) {
        // cap-driven abort takes precedence over the generic
        // abort outcome — surface a structured reason so the orchestrator
        // can park the issue under the right "exceeded which cap" message.
        outcome = "failed";
        if (capExceededReason === "state") {
          errorMessage = `per-state cost cap exceeded (turn cost $${costUsd.toFixed(4)} > $${perStateCap.toFixed(2)}); aborted mid-turn`;
        } else {
          errorMessage = `per-issue cost cap exceeded ($${(alreadyRecorded + costUsd).toFixed(4)} > $${cap.toFixed(2)}); aborted mid-turn`;
        }
      } else if (externallyAborted) {
        outcome = "cancelled";
        errorMessage = "cancelled by orchestrator";
      } else if (
        aborted &&
        Date.now() - lastEventAt > args.stallTimeoutMs &&
        args.stallTimeoutMs > 0
      ) {
        outcome = "stalled";
        errorMessage = "no progress before stall_timeout_ms";
      } else if (aborted) {
        outcome = "timeout";
        errorMessage = `aborted after ${args.turnTimeoutMs}ms`;
      } else {
        outcome = "failed";
        errorMessage = (err as Error).message;
      }
      logger.warn({ outcome, err: errorMessage }, "claude turn ended abnormally");
    } finally {
      clearTimeout(timeoutTimer);
      if (stallTimer) clearInterval(stallTimer);
      if (externalAbortHandler && args.signal) {
        args.signal.removeEventListener("abort", externalAbortHandler);
      }
    }

    // Stream ended without an explicit `result` message — could be a clean
    // exit by the SDK without a final marker, or an aborted turn whose error
    // was swallowed.
    if (outcome === "completed" && resultMessage === null) {
      if (capExceeded) {
        outcome = "failed";
        if (capExceededReason === "state") {
          errorMessage = `per-state cost cap exceeded (turn cost $${costUsd.toFixed(4)} > $${perStateCap.toFixed(2)}); aborted mid-turn`;
        } else {
          errorMessage = `per-issue cost cap exceeded ($${(alreadyRecorded + costUsd).toFixed(4)} > $${cap.toFixed(2)}); aborted mid-turn`;
        }
      } else if (externallyAborted) {
        outcome = "cancelled";
        errorMessage = "cancelled by orchestrator";
      } else if (
        ac.signal.aborted &&
        args.stallTimeoutMs > 0 &&
        Date.now() - lastEventAt > args.stallTimeoutMs
      ) {
        // Preserve the stall classification when the stall watchdog fired
        // but the SDK ended the stream cleanly (no throw). Without this,
        // stalls were silently rewritten to timeouts.
        outcome = "stalled";
        errorMessage = "no progress before stall_timeout_ms";
      } else if (ac.signal.aborted) {
        outcome = "timeout";
        errorMessage = `aborted after ${args.turnTimeoutMs}ms`;
      } else {
        outcome = "failed";
        errorMessage = "stream ended without a result message";
      }
    }

    const finalEvent: AgentEvent = {
      event:
        outcome === "completed"
          ? "turn_completed"
          : outcome === "cancelled"
            ? "turn_cancelled"
            : "turn_failed",
      timestamp: Date.now(),
      pid: null,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd,
      },
      message: errorMessage ?? resultMessage?.result,
    };

    // also push the final outcome event into the live queue so
    // consumers iterating via `session.events` see the turn end without
    // having to await the runTurn promise separately. Best-effort.
    try {
      eventQueue?.push(finalEvent);
    } catch {
      /* swallowed — event queue is observability only */
    }

    return {
      outcome,
      finalEvent,
      usageDelta: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd,
        // forward cache-fee subsets to the orchestrator so
        // they make it into the audit row + Slack succeeded card.
        cacheCreationInputTokens,
        cacheReadInputTokens,
      },
    };
  }

  async endSession(session: AgentSessionHandle): Promise<void> {
    logger.debug({ session_id: session.sessionId }, "session ended (claude)");
    // close the per-session event queue so any consumer iterating
    // via `for await (const e of session.events)` drains and exits
    // cleanly. Idempotent — safe to call even if `runTurn` already
    // happened to close (it doesn't today, but a future refactor
    // might).
    const eventQueue: AsyncQueue<AgentEvent> | undefined = (
      session as AgentSessionHandle & { _eventQueue?: AsyncQueue<AgentEvent> }
    )._eventQueue;
    eventQueue?.close();
  }

  private async getQueryFn(): Promise<ClaudeQueryFn> {
    if (this.resolvedQueryFn) return this.resolvedQueryFn;
    // Lazy dynamic import so tests / typecheck don't require the SDK.
    const mod = (await import("@anthropic-ai/claude-agent-sdk").catch((err) => {
      throw new Error(`failed to load @anthropic-ai/claude-agent-sdk: ${(err as Error).message}`);
    })) as { query?: ClaudeQueryFn };
    if (!mod.query) {
      throw new Error("@anthropic-ai/claude-agent-sdk does not export `query`");
    }
    this.resolvedQueryFn = mod.query;
    return this.resolvedQueryFn;
  }
}

/**
 * `attachWorkspace` and `extractWorkspaceFromSession` (Symbol-keyed
 * mutation pattern) were retired in favor of a public `workspacePath` field
 * on `AgentSessionHandle`. The adapter populates it in `startSession` and
 * reads it back in `runTurn` via `session.workspacePath`. Type-safe + no
 * Symbol.for namespace concerns.
 *
 * Callers that previously imported `attachWorkspace` should update to read
 * `session.workspacePath` directly.
 */
/**
 * Compatibility shim — kept exported so an older orchestrator build can still
 * import `attachWorkspace` without breaking the typecheck during deploy
 * rollover. Effectively a no-op now (the public `workspacePath` field on
 * `AgentSessionHandle` makes the Symbol-keyed mutation unnecessary).
 *
 * @deprecated Will be removed once all in-tree callers move to
 *   `session.workspacePath`. Prefer constructing the session with the right
 *   `workspacePath` and reading it directly.
 */
export function attachWorkspace(session: AgentSessionHandle, workspacePath: string): void {
  // Same-value reassignment is a no-op for `runTurn`'s read path; opting to
  // preserve the call here so the orchestrator's existing line + tests don't
  // need to change in this same commit. Future cleanup: drop the call site.
  (session as { workspacePath: string }).workspacePath = workspacePath;
}
