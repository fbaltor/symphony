import { describe, expect, it } from "vitest";
import { FakeAgentRunner } from "../../src/agent/fake-runner.js";
import type {
  AgentRunner,
  AgentSessionHandle,
  RunTurnArgs,
  RunTurnResult,
} from "../../src/agent/runner.js";
import type { Issue } from "../../src/types.js";

/**
 * Phase B — scripted fake AgentRunner.
 *
 * `FakeAgentRunner` is a shipped class (NOT a test-local hand-roll) that
 * implements the `AgentRunner` interface and returns deterministic, scripted
 * turn results: outcome, token/cost/model accounting, and any
 * description-edit / decision-line payload the orchestrator reads off the turn
 * result after a turn. It exists so flows run end-to-end with zero LLM cost
 * and reproducible outcomes.
 *
 * These tests are the contract for behaviors 1-3 of the phase. They are
 * authored BEFORE the implementation exists, so they are expected RED until
 * `src/agent/fake-runner.ts` lands.
 *
 * Contract surface under test (from `src/agent/runner.ts`):
 *   - `runner.kind: string`
 *   - `startSession(args) => Promise<AgentSessionHandle>`
 *   - `runTurn(session, args) => Promise<RunTurnResult>`
 *   - `endSession(session) => Promise<void>`
 *   - `RunTurnResult.outcome: "completed" | "failed" | "cancelled" | "timeout" | "stalled"`
 *   - `RunTurnResult.usageDelta.{inputTokens,outputTokens,totalTokens,costUsd,
 *      cacheCreationInputTokens,cacheReadInputTokens}`
 *   - `RunTurnResult.finalEvent.{event,message,payload}`
 */

/* ------------------------------ fixtures -------------------------------- */

function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "MEM-1",
    title: overrides.title ?? "Fake issue",
    description: overrides.description ?? null,
    priority: overrides.priority ?? null,
    state: overrides.state ?? "Active",
    branchName: null,
    url: null,
    labels: overrides.labels ?? [],
    blockedBy: overrides.blockedBy ?? [],
    createdAt: overrides.createdAt ?? "2026-06-01T00:00:00Z",
    updatedAt: null,
  };
}

const TURN_ARGS: RunTurnArgs = {
  prompt: "do the thing",
  attempt: null,
  turnTimeoutMs: 5_000,
  stallTimeoutMs: 0,
};

async function startAndRun(
  runner: AgentRunner,
  args: RunTurnArgs = TURN_ARGS,
): Promise<{ session: AgentSessionHandle; result: RunTurnResult }> {
  const session = await runner.startSession({
    workspacePath: "/tmp/fake-ws",
    issue: fakeIssue(),
  });
  const result = await runner.runTurn(session, args);
  return { session, result };
}

/* ----------------------- interface conformance -------------------------- */

describe("FakeAgentRunner — AgentRunner interface conformance", () => {
  it("structurally satisfies the AgentRunner interface (assignable + all methods present)", async () => {
    // Compile-time: a FakeAgentRunner must be assignable to AgentRunner with
    // NO cast. If the class drifts from the interface this line fails to
    // type-check (caught by `npm run typecheck`).
    const runner: AgentRunner = new FakeAgentRunner({ outcome: "completed" });

    expect(typeof runner.kind).toBe("string");
    expect(typeof runner.startSession).toBe("function");
    expect(typeof runner.runTurn).toBe("function");
    expect(typeof runner.endSession).toBe("function");
  });

  it("startSession returns a handle carrying the requested workspacePath, then endSession resolves", async () => {
    const runner = new FakeAgentRunner({ outcome: "completed" });
    const session = await runner.startSession({
      workspacePath: "/tmp/fake-ws",
      issue: fakeIssue(),
    });

    // The handle must echo the workspace path back (spec §10 — adapters MUST
    // populate `workspacePath` so callers can read it without a side-channel).
    expect(session.workspacePath).toBe("/tmp/fake-ws");
    expect(typeof session.sessionId).toBe("string");
    expect(typeof session.threadId).toBe("string");
    expect(session.events[Symbol.asyncIterator]).toBeTypeOf("function");

    // Tear-down must resolve cleanly.
    await expect(runner.endSession(session)).resolves.toBeUndefined();
  });
});

/* ----------------------------- behavior 1 ------------------------------- */
/*
 * A scripted FakeAgentRunner returns the configured outcome for a turn.
 * Each RunTurnOutcome value is a falsifiable claim: scripting outcome X must
 * make runTurn resolve with outcome X. If the runner ignored the script (e.g.
 * always returned "completed") these would fail.
 */

describe("behavior 1: FakeAgentRunner returns the scripted turn outcome", () => {
  const outcomes: RunTurnResult["outcome"][] = [
    "completed",
    "failed",
    "cancelled",
    "timeout",
    "stalled",
  ];

  for (const outcome of outcomes) {
    it(`runTurn resolves outcome="${outcome}" when scripted with outcome="${outcome}"`, async () => {
      const runner = new FakeAgentRunner({ outcome });
      const { result } = await startAndRun(runner);
      expect(result.outcome).toBe(outcome);
    });
  }

  it("the finalEvent.event matches the configured failure outcome (failed ⇒ a non-completed event kind)", async () => {
    // A 'failed' turn must NOT carry a `turn_completed` finalEvent — downstream
    // audit distinguishes success vs failure off the finalEvent. The strict
    // claim: a scripted failure yields a finalEvent whose kind is not the
    // success kind.
    const runner = new FakeAgentRunner({ outcome: "failed" });
    const { result } = await startAndRun(runner);
    expect(result.outcome).toBe("failed");
    expect(result.finalEvent.event).not.toBe("turn_completed");
  });

  it("plays a multi-turn script: successive runTurn calls return successive scripted outcomes", async () => {
    // The orchestrator can run multiple turns per session (runner.ts lifecycle
    // doc). A script with an outcome SEQUENCE must be consumed in order, so a
    // deterministic flow can model "turn 1 succeeds, turn 2 stalls".
    const runner = new FakeAgentRunner({ outcomes: ["completed", "stalled"] });
    const session = await runner.startSession({
      workspacePath: "/tmp/fake-ws",
      issue: fakeIssue(),
    });

    const r1 = await runner.runTurn(session, TURN_ARGS);
    const r2 = await runner.runTurn(session, TURN_ARGS);

    expect(r1.outcome).toBe("completed");
    expect(r2.outcome).toBe("stalled");
  });
});

/* ----------------------------- behavior 2 ------------------------------- */
/*
 * It reports configured token counts, cost, and model so audit/cost
 * accounting receive those values. Tokens + cost flow through
 * RunTurnResult.usageDelta (the only result slot the orchestrator reads for
 * cost rollup — see orchestrator.ts ~L1232). The scripted model is surfaced
 * on the turn result so an audit/cost test can read it back.
 */

describe("behavior 2: FakeAgentRunner reports scripted token/cost/model accounting", () => {
  it("usageDelta echoes the scripted input/output/total token counts and cost", async () => {
    const runner = new FakeAgentRunner({
      outcome: "completed",
      usage: {
        inputTokens: 1234,
        outputTokens: 567,
        totalTokens: 1801,
        costUsd: 0.0421,
      },
    });
    const { result } = await startAndRun(runner);

    expect(result.usageDelta.inputTokens).toBe(1234);
    expect(result.usageDelta.outputTokens).toBe(567);
    expect(result.usageDelta.totalTokens).toBe(1801);
    expect(result.usageDelta.costUsd).toBeCloseTo(0.0421);
  });

  it("usageDelta carries the cache-token subfields when scripted (audit cache hit-rate)", async () => {
    const runner = new FakeAgentRunner({
      outcome: "completed",
      usage: {
        inputTokens: 300,
        outputTokens: 80,
        totalTokens: 380,
        costUsd: 0.01,
        cacheCreationInputTokens: 4096,
        cacheReadInputTokens: 2048,
      },
    });
    const { result } = await startAndRun(runner);

    expect(result.usageDelta.cacheCreationInputTokens).toBe(4096);
    expect(result.usageDelta.cacheReadInputTokens).toBe(2048);
  });

  it("usageDelta cache subfields default to 0 (never undefined/NaN) when not scripted", async () => {
    // The orchestrator sums these unconditionally into the audit row; a
    // missing field would poison the rollup with NaN. A bare script must
    // still produce numeric zeros.
    const runner = new FakeAgentRunner({ outcome: "completed" });
    const { result } = await startAndRun(runner);

    expect(result.usageDelta.cacheCreationInputTokens).toBe(0);
    expect(result.usageDelta.cacheReadInputTokens).toBe(0);
    expect(Number.isFinite(result.usageDelta.inputTokens)).toBe(true);
    expect(Number.isFinite(result.usageDelta.outputTokens)).toBe(true);
    expect(Number.isFinite(result.usageDelta.totalTokens)).toBe(true);
    expect(Number.isFinite(result.usageDelta.costUsd)).toBe(true);
  });

  it("surfaces the scripted model so cost/audit accounting can attribute the turn", async () => {
    // The model the turn ran under must be readable back from the runner so a
    // cost-accounting consumer can attribute the spend. The AgentRunner result
    // type has no dedicated `model` field, so the fake exposes the scripted
    // model on the runner instance (`runner.model`). This is the strictest
    // reading that stays within the shipped interface — see AMBIGUITY note in
    // the report.
    const runner = new FakeAgentRunner({
      outcome: "completed",
      model: "claude-opus-4-8",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 },
    });
    await startAndRun(runner);

    expect(runner.model).toBe("claude-opus-4-8");
  });
});

/* ----------------------------- behavior 3 ------------------------------- */
/*
 * It can emit configured description edits / decision-line text that
 * downstream routing would consume: the turn RESULT carries the scripted
 * payload the orchestrator reads after a turn. The orchestrator reads routing
 * intent off `RunTurnResult.finalEvent` (`.message` is used as lastError for
 * non-completed turns at orchestrator.ts ~L1242/L1325; `.payload` is the
 * free-form record on AgentEvent). The fake must let a script set both.
 */

describe("behavior 3: FakeAgentRunner emits a scripted decision/description payload on the turn result", () => {
  it("carries the scripted decision-line text on finalEvent.message", async () => {
    const runner = new FakeAgentRunner({
      outcome: "completed",
      decisionLine: "Bouncing to Pull request.",
    });
    const { result } = await startAndRun(runner);

    expect(result.finalEvent.message).toBe("Bouncing to Pull request.");
  });

  it("carries the scripted description-edit payload on finalEvent.payload", async () => {
    const descriptionEdit = "## Release report\n\nDecision: Advancing to Done.";
    const runner = new FakeAgentRunner({
      outcome: "completed",
      payload: { descriptionEdit },
    });
    const { result } = await startAndRun(runner);

    expect(result.finalEvent.payload).toBeDefined();
    expect(result.finalEvent.payload?.descriptionEdit).toBe(descriptionEdit);
  });

  it("a turn with NO scripted decision/description payload yields an empty (non-throwing) finalEvent message", async () => {
    // Falsifiable counterpart: when nothing is scripted, the fake must not
    // fabricate a decision line. The orchestrator treats a completed turn's
    // message as null, so an unset script must NOT leak a stray decision
    // string that would mis-route the issue.
    const runner = new FakeAgentRunner({ outcome: "completed" });
    const { result } = await startAndRun(runner);

    expect(result.finalEvent.message ?? "").toBe("");
  });

  it("scripts per-turn payloads: each turn in a sequence yields its own decision line", async () => {
    // A deterministic multi-turn flow must be able to attach a distinct
    // decision line to each scripted turn (e.g. turn 1 advances, turn 2
    // escalates). The per-turn script entry's decision line must land on that
    // turn's finalEvent.message.
    const runner = new FakeAgentRunner({
      turns: [
        { outcome: "completed", decisionLine: "Advancing to RFC." },
        { outcome: "completed", decisionLine: "Escalating to Error (manual)." },
      ],
    });
    const session = await runner.startSession({
      workspacePath: "/tmp/fake-ws",
      issue: fakeIssue(),
    });

    const r1 = await runner.runTurn(session, TURN_ARGS);
    const r2 = await runner.runTurn(session, TURN_ARGS);

    expect(r1.finalEvent.message).toBe("Advancing to RFC.");
    expect(r2.finalEvent.message).toBe("Escalating to Error (manual).");
  });
});
