import { randomUUID } from "node:crypto";
import type { AgentEvent } from "./events.js";
import { AsyncQueue } from "./event-queue.js";
import type {
  AgentRunner,
  AgentSessionHandle,
  RunTurnArgs,
  RunTurnResult,
  RunTurnOutcome,
  StartSessionArgs,
} from "./runner.js";

/**
 * Phase B (zero-dep E2E) — scripted in-process `AgentRunner`.
 *
 * `FakeAgentRunner` implements the spec §10 `AgentRunner` interface but never
 * touches the Claude SDK: every turn resolves from a pre-baked script. It
 * exists so Symphony flows run end-to-end with zero LLM cost and reproducible
 * outcomes — the orchestrator dispatches against it exactly as it would the
 * real `ClaudeAgentRunner`, reading outcome / usage / `finalEvent` off the
 * `RunTurnResult` without knowing the runner is faked.
 *
 * The real Claude adapter stays selectable (see `runner-factory.ts`); the fake
 * is the default under the `kind: memory` profile.
 */

/**
 * The usage accounting a single scripted turn reports back via
 * `RunTurnResult.usageDelta`. Mirrors the interface shape but makes every
 * field optional so a bare script (`{ outcome: "completed" }`) is valid;
 * unset fields default to numeric `0` at turn time (never undefined / NaN —
 * the orchestrator sums these unconditionally into the audit row).
 */
export interface FakeTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * One scripted turn: the outcome plus the optional accounting / routing
 * payload the orchestrator reads off the turn result.
 *
 *   - `decisionLine` lands on `finalEvent.message` (the orchestrator reads it
 *     as the routing decision / lastError for non-completed turns).
 *   - `payload` lands on `finalEvent.payload` (free-form record, e.g. a
 *     scripted `descriptionEdit`).
 */
export interface FakeTurnScript {
  outcome: RunTurnOutcome;
  usage?: FakeTurnUsage;
  decisionLine?: string;
  payload?: Record<string, unknown>;
}

/**
 * Constructor script. Three mutually-supportive forms, in precedence order:
 *
 *   1. `turns: [...]`     — a full per-turn script (outcome + payload each).
 *   2. `outcomes: [...]`  — an outcome sequence (shared top-level usage/model).
 *   3. `outcome: X`       — a single repeated outcome.
 *
 * The shared `usage` / `model` / `decisionLine` / `payload` fields apply to
 * every turn produced by forms 2 and 3 (and as a fallback once a `turns`
 * sequence is exhausted).
 */
export interface FakeAgentRunnerScript {
  outcome?: RunTurnOutcome;
  outcomes?: readonly RunTurnOutcome[];
  turns?: readonly FakeTurnScript[];
  usage?: FakeTurnUsage;
  /** Scripted model, surfaced on `runner.model` for cost/audit attribution. */
  model?: string;
  /** Default decision-line text (lands on `finalEvent.message`). */
  decisionLine?: string;
  /** Default free-form payload (lands on `finalEvent.payload`). */
  payload?: Record<string, unknown>;
}

/** Map a turn outcome to the spec §10.4 final event kind the orchestrator
 *  distinguishes success vs failure on. A non-completed turn must NEVER carry
 *  a `turn_completed` finalEvent. */
function finalEventKind(outcome: RunTurnOutcome): AgentEvent["event"] {
  if (outcome === "completed") return "turn_completed";
  if (outcome === "cancelled") return "turn_cancelled";
  return "turn_failed";
}

/** Fill in numeric-zero defaults for every usage subfield so the orchestrator
 *  never sums an undefined / NaN into the audit rollup. */
function resolveUsage(usage: FakeTurnUsage | undefined): RunTurnResult["usageDelta"] {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    costUsd: usage?.costUsd ?? 0,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
  };
}

export class FakeAgentRunner implements AgentRunner {
  readonly kind = "fake";
  /**
   * The scripted model the turns ran under, surfaced so a cost/audit
   * consumer can attribute the spend. The `RunTurnResult` type has no
   * dedicated model field, so the fake exposes it on the instance — the
   * strictest reading that stays within the shipped interface.
   */
  readonly model: string | undefined;

  private readonly script: FakeAgentRunnerScript;
  /** Pre-flattened per-turn scripts, consumed in order across runTurn calls. */
  private readonly turns: readonly FakeTurnScript[];
  /** Index into `turns`; once exhausted the last/fallback turn repeats. */
  private turnIndex = 0;

  constructor(script: FakeAgentRunnerScript) {
    this.script = script;
    this.model = script.model;
    this.turns = this.flattenScript(script);
  }

  /**
   * Normalize the three script forms into one ordered list of per-turn
   * scripts. `turns` wins; otherwise we expand `outcomes` (sequence) or
   * `outcome` (single) and attach the shared top-level usage / decisionLine /
   * payload to each.
   */
  private flattenScript(script: FakeAgentRunnerScript): readonly FakeTurnScript[] {
    if (script.turns && script.turns.length > 0) {
      return script.turns;
    }
    const shared: Omit<FakeTurnScript, "outcome"> = {
      usage: script.usage,
      decisionLine: script.decisionLine,
      payload: script.payload,
    };
    if (script.outcomes && script.outcomes.length > 0) {
      return script.outcomes.map((outcome) => ({ outcome, ...shared }));
    }
    return [{ outcome: script.outcome ?? "completed", ...shared }];
  }

  async startSession(args: StartSessionArgs): Promise<AgentSessionHandle> {
    const threadId = `fake-${randomUUID()}`;
    const sessionId = `${threadId}-init`;
    // A real, drainable event stream so observers iterating `session.events`
    // behave the same as against the Claude adapter. `endSession` closes it.
    const queue = new AsyncQueue<AgentEvent>({
      name: `fake-session-${threadId.slice(0, 8)}`,
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
      // Spec §10 — echo the workspace path back so callers read it without a
      // side-channel.
      workspacePath: args.workspacePath,
      events: queue,
    };
    handle._eventQueue = queue;
    return handle;
  }

  async runTurn(session: AgentSessionHandle, _args: RunTurnArgs): Promise<RunTurnResult> {
    // Consume the next scripted turn; once the sequence is exhausted, repeat
    // the final entry so a flow that runs more turns than scripted keeps a
    // deterministic outcome rather than crashing.
    const turn =
      this.turns[Math.min(this.turnIndex, this.turns.length - 1)] ??
      ({ outcome: "completed" } as FakeTurnScript);
    this.turnIndex += 1;

    const usageDelta = resolveUsage(turn.usage ?? this.script.usage);
    const finalEvent: AgentEvent = {
      event: finalEventKind(turn.outcome),
      timestamp: Date.now(),
      pid: null,
      usage: {
        inputTokens: usageDelta.inputTokens,
        outputTokens: usageDelta.outputTokens,
        totalTokens: usageDelta.totalTokens,
        costUsd: usageDelta.costUsd,
      },
      // Only set `message` when a decision line is scripted — an unset script
      // must NOT fabricate a stray decision string that would mis-route the
      // issue (the orchestrator treats a completed turn's message as null).
      ...(turn.decisionLine !== undefined ? { message: turn.decisionLine } : {}),
      ...(turn.payload !== undefined ? { payload: turn.payload } : {}),
    };

    // Mirror the Claude adapter: push the final event into the live queue so
    // consumers iterating `session.events` see the turn end. Best-effort.
    const eventQueue: AsyncQueue<AgentEvent> | undefined = (
      session as AgentSessionHandle & { _eventQueue?: AsyncQueue<AgentEvent> }
    )._eventQueue;
    try {
      eventQueue?.push(finalEvent);
    } catch {
      /* swallowed — event queue is observability only */
    }

    return { outcome: turn.outcome, finalEvent, usageDelta };
  }

  async endSession(session: AgentSessionHandle): Promise<void> {
    const eventQueue: AsyncQueue<AgentEvent> | undefined = (
      session as AgentSessionHandle & { _eventQueue?: AsyncQueue<AgentEvent> }
    )._eventQueue;
    eventQueue?.close();
  }
}
