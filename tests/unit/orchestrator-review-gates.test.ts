import { describe, expect, it, vi } from "vitest";
import { reconcileTrackerStates } from "../../src/orchestrator/reconcile.js";
import { createState } from "../../src/orchestrator/state.js";
import { nowMonotonicMs } from "../../src/lib/time.js";
import type { Issue, OrchestratorState, RunningEntry } from "../../src/types.js";

/**
 * Review-gate enforcement tests — close the PROJ-447 hole where an
 * in-flight agent calls `update_issue` to bypass an RFC / Code Review /
 * Human Review halt. The reconciler reverts unauthorized moves to/from
 * any state in `human_review_states` unless the transition is a known
 * `state_transitions` edge (forward = orchestrator auto-advance, reverse
 * = explicit human "go back"). Terminal moves (Done / Canceled / etc.)
 * are always respected.
 */

const STATE_TRANSITIONS: Record<string, string> = {
  Refinement: "Plan",
  Plan: "RFC",
  Validate: "Code Review",
  Implement: "Code Review",
  "Open PR": "Code Review",
  Reviewed: "Test",
  Test: "Deploy",
  Deploy: "Monitoring",
};

const HUMAN_REVIEW_STATES = ["RFC", "Code Review", "Human Review"];

const ACTIVE_STATES = [
  "Refinement",
  "Plan",
  "Validate",
  "Implement",
  "Open PR",
  "Reviewed",
  "Test",
  "Deploy",
  "Monitoring",
];

const TERMINAL_STATES = ["Done", "Canceled", "Duplicate", "Error"];

function fakeIssue(state: string): Issue {
  return {
    id: "i1",
    identifier: "PROJ-447",
    title: "t",
    description: null,
    priority: null,
    state,
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function seedRunningState(initialState: string): {
  state: OrchestratorState;
  lastSeen: Map<string, string>;
  entry: RunningEntry;
} {
  const state = createState(30_000, 1);
  const issue = fakeIssue(initialState);
  const now = nowMonotonicMs();
  const entry: RunningEntry = {
    issue,
    attempt: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: null,
      workspacePath: "/tmp",
      startedAt: Date.now(),
      status: "StreamingTurn",
      error: null,
    },
    session: null,
    startedAtMonotonicMs: now,
    lastEventMonotonicMs: now,
    abort: async () => undefined,
  };
  state.running.set(issue.id, entry);
  const lastSeen = new Map<string, string>();
  lastSeen.set(issue.id, initialState);
  return { state, lastSeen, entry };
}

interface RunArgs {
  initial: string;
  fresh: string;
}

async function run(args: RunArgs) {
  const { state, lastSeen, entry } = seedRunningState(args.initial);
  const transitionIssueToState =
    vi.fn<(id: string, name: string) => Promise<{ identifier: string; state: string }>>();
  transitionIssueToState.mockImplementation(async (_id, name) => ({
    identifier: "PROJ-447",
    state: name,
  }));
  const createComment =
    vi.fn<(id: string, body: string) => Promise<{ id: string; url: string } | null>>();
  createComment.mockResolvedValue({ id: "c1", url: "u" });
  const onTerminal = vi.fn<(args: { issueId: string; cleanup: boolean }) => Promise<void>>(
    async () => undefined,
  );
  const tracker = {
    fetchIssueStatesByIds: async () => [fakeIssue(args.fresh)],
    transitionIssueToState,
    createComment,
  };
  await reconcileTrackerStates({
    state,
    tracker,
    activeStates: ACTIVE_STATES,
    terminalStates: TERMINAL_STATES,
    humanReviewStates: HUMAN_REVIEW_STATES,
    stateTransitions: STATE_TRANSITIONS,
    lastSeenState: lastSeen,
    onTerminal,
  });
  return { state, lastSeen, entry, transitionIssueToState, createComment, onTerminal };
}

describe("orchestrator review-gate enforcement", () => {
  it("Plan → RFC is allowed (matches state_transitions map)", async () => {
    const { transitionIssueToState, createComment, lastSeen, onTerminal } = await run({
      initial: "Plan",
      fresh: "RFC",
    });
    expect(transitionIssueToState).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(lastSeen.get("i1")).toBe("RFC");
    // RFC is not in active_states → onTerminal called with cleanup=false to
    // stop the worker gracefully (the human gate now owns the issue).
    expect(onTerminal).toHaveBeenCalledWith({ issueId: "i1", cleanup: false });
  });

  it("Plan → Implement is REVERTED (bypasses RFC review gate)", async () => {
    const { transitionIssueToState, createComment, lastSeen } = await run({
      initial: "Plan",
      fresh: "Implement",
    });
    expect(transitionIssueToState).toHaveBeenCalledTimes(1);
    expect(transitionIssueToState).toHaveBeenCalledWith("i1", "Plan");
    expect(createComment).toHaveBeenCalledTimes(1);
    const body = createComment.mock.calls[0]?.[1] ?? "";
    expect(body).toMatch(/reverted unauthorized state move/i);
    expect(body).toMatch(/Plan/);
    expect(body).toMatch(/Implement/);
    expect(body).toMatch(/RFC/); // gate name surfaces in the comment
    // After revert the lastSeen map snaps back to the prev state so we
    // don't busy-loop on the same divergence.
    expect(lastSeen.get("i1")).toBe("Plan");
  });

  it("Implement → Code Review is allowed (matches state_transitions map)", async () => {
    const { transitionIssueToState, createComment, lastSeen, onTerminal } = await run({
      initial: "Implement",
      fresh: "Code Review",
    });
    expect(transitionIssueToState).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(lastSeen.get("i1")).toBe("Code Review");
    expect(onTerminal).toHaveBeenCalledWith({ issueId: "i1", cleanup: false });
  });

  it("Implement → Done is allowed (terminal exit, never reverted)", async () => {
    const { transitionIssueToState, createComment, onTerminal } = await run({
      initial: "Implement",
      fresh: "Done",
    });
    expect(transitionIssueToState).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    // Terminal moves route through onTerminal with cleanup=true.
    expect(onTerminal).toHaveBeenCalledWith({ issueId: "i1", cleanup: true });
  });

  it("Code Review → Reviewed is allowed (human-driven approval)", async () => {
    // Reviewed is NOT a key→value of `Code Review` in state_transitions, so
    // the strict-forward rule would revert it. But the human moving CR →
    // Reviewed is the literal happy-path approval — and `Code Review` is in
    // human_review_states, so a match-only-on-forward rule would also fail.
    //
    // We DO want this to be respected. The user's spec marks it "allowed
    // (human-driven approval)". To keep the rule purely structural we add a
    // synthetic `Code Review: "Reviewed"` edge to the test config — that's
    // exactly how the hybrid-workflow operator would express "the next state
    // after a human approves the PR is Reviewed".
    const transitions = { ...STATE_TRANSITIONS, "Code Review": "Reviewed" };
    const { state, lastSeen } = seedRunningState("Code Review");
    const tx = vi.fn();
    const cc = vi.fn();
    const onTerminal = vi.fn(async () => undefined);
    const tracker = {
      fetchIssueStatesByIds: async () => [fakeIssue("Reviewed")],
      transitionIssueToState: tx as never,
      createComment: cc as never,
    };
    await reconcileTrackerStates({
      state,
      tracker,
      activeStates: ACTIVE_STATES,
      terminalStates: TERMINAL_STATES,
      humanReviewStates: HUMAN_REVIEW_STATES,
      stateTransitions: transitions,
      lastSeenState: lastSeen,
      onTerminal,
    });
    expect(tx).not.toHaveBeenCalled();
    expect(cc).not.toHaveBeenCalled();
    expect(lastSeen.get("i1")).toBe("Reviewed");
  });

  it('Code Review → Implement is allowed (explicit human "go back")', async () => {
    // Inverse of Implement → Code Review. The reverse-edge allowance in
    // isAuthorizedTransition() respects this: the operator (or the agent
    // following human direction) goes back to Implement to revise a PR.
    // We deliberately do NOT add `Code Review: "Implement"` as a forward
    // edge because that would auto-advance Code Review on success — which
    // is exactly the human-gate skip we're trying to prevent. The reverse
    // match handles the legitimate go-back direction without enabling
    // auto-advance. Documented case.
    const { transitionIssueToState, createComment, lastSeen } = await run({
      initial: "Code Review",
      fresh: "Implement",
    });
    expect(transitionIssueToState).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(lastSeen.get("i1")).toBe("Implement");
  });

  it('RFC → Plan is allowed (explicit human "rejected, redo plan")', async () => {
    // Reverse of Plan → RFC. Same reverse-edge allowance: the human
    // rejected the plan, kicks it back to Plan, the agent re-plans.
    const { transitionIssueToState, createComment, lastSeen } = await run({
      initial: "RFC",
      fresh: "Plan",
    });
    expect(transitionIssueToState).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(lastSeen.get("i1")).toBe("Plan");
  });

  it("does NOT revert when neither prev nor next is a review gate", async () => {
    // Sanity: an unauthorized transition between two non-gate active
    // states (e.g. Refinement → Test, agent restructured the pipeline) is
    // RESPECTED — review-gate enforcement is scoped to gates only.
    const { transitionIssueToState, createComment, lastSeen } = await run({
      initial: "Refinement",
      fresh: "Test",
    });
    expect(transitionIssueToState).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(lastSeen.get("i1")).toBe("Test");
  });

  it("disabled when humanReviewStates is empty", async () => {
    const { state, lastSeen } = seedRunningState("Plan");
    const tx = vi.fn();
    const cc = vi.fn();
    const onTerminal = vi.fn(async () => undefined);
    await reconcileTrackerStates({
      state,
      tracker: {
        fetchIssueStatesByIds: async () => [fakeIssue("Implement")],
        transitionIssueToState: tx as never,
        createComment: cc as never,
      },
      activeStates: ACTIVE_STATES,
      terminalStates: TERMINAL_STATES,
      humanReviewStates: [],
      stateTransitions: STATE_TRANSITIONS,
      lastSeenState: lastSeen,
      onTerminal,
    });
    expect(tx).not.toHaveBeenCalled();
    expect(cc).not.toHaveBeenCalled();
  });

  it("revert-comment failure does not throw and lastSeen reflects revert", async () => {
    const { state, lastSeen } = seedRunningState("Plan");
    const tx = vi.fn(async (_id: string, name: string) => ({
      identifier: "PROJ-447",
      state: name,
    }));
    const cc = vi.fn(async () => {
      throw new Error("linear comment outage");
    });
    const onTerminal = vi.fn(async () => undefined);
    await expect(
      reconcileTrackerStates({
        state,
        tracker: {
          fetchIssueStatesByIds: async () => [fakeIssue("Implement")],
          transitionIssueToState: tx as never,
          createComment: cc as never,
        },
        activeStates: ACTIVE_STATES,
        terminalStates: TERMINAL_STATES,
        humanReviewStates: HUMAN_REVIEW_STATES,
        stateTransitions: STATE_TRANSITIONS,
        lastSeenState: lastSeen,
        onTerminal,
      }),
    ).resolves.not.toThrow();
    expect(tx).toHaveBeenCalledWith("i1", "Plan");
    expect(lastSeen.get("i1")).toBe("Plan");
  });
});

// Actor-aware revert skip (see docs/adr/0020)
describe("reconciler skips revert when actor is human", () => {
  /**
   * Build a stub Postgres pool that responds to the actor SELECT with
   * the row supplied by `actor`. Pass `null` for "no row" (the legacy
   * fallback path). `state` defaults to `"Implement"` to match the
   * `fresh.state` used in most tests below — pass an explicit value
   * to exercise the stale-row guard (Copilot review).
   */
  function makePool(
    actor: { actor_id: string; actor_type?: string; state?: string } | null,
  ): { query: ReturnType<typeof vi.fn> } {
    return {
      query: vi.fn(async (_sql: string, _params: unknown[]) => {
        if (!actor) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              last_actor_id: actor.actor_id,
              last_actor_type: actor.actor_type ?? "user",
              last_state: actor.state ?? "Implement",
            },
          ],
          rowCount: 1,
        };
      }),
    };
  }

  async function runWithActor(args: {
    initial: string;
    fresh: string;
    botUserId: string | null;
    actor: { actor_id: string; actor_type?: string; state?: string } | null;
  }) {
    const { state, lastSeen, entry } = seedRunningState(args.initial);
    const transitionIssueToState =
      vi.fn<(id: string, name: string) => Promise<{ identifier: string; state: string }>>();
    transitionIssueToState.mockImplementation(async (_id, name) => ({
      identifier: "PROJ-447",
      state: name,
    }));
    const createComment =
      vi.fn<(id: string, body: string) => Promise<{ id: string; url: string } | null>>();
    createComment.mockResolvedValue({ id: "c1", url: "u" });
    const onTerminal = vi.fn<(args: { issueId: string; cleanup: boolean }) => Promise<void>>(
      async () => undefined,
    );
    const tracker = {
      fetchIssueStatesByIds: async () => [fakeIssue(args.fresh)],
      transitionIssueToState,
      createComment,
    };
    const pool = makePool(args.actor);
    await reconcileTrackerStates({
      state,
      tracker,
      activeStates: ACTIVE_STATES,
      terminalStates: TERMINAL_STATES,
      humanReviewStates: HUMAN_REVIEW_STATES,
      stateTransitions: STATE_TRANSITIONS,
      lastSeenState: lastSeen,
      onTerminal,
      botUserId: args.botUserId,
      pool: pool as never,
    });
    return { transitionIssueToState, createComment, lastSeen, entry, pool };
  }

  it("skips revert when actor.id != botUserId (human override)", async () => {
    // Plan → Implement bypasses RFC gate. Without actor info this would
    // be reverted. With a HUMAN actor on record, the revert is skipped.
    const { transitionIssueToState, createComment, lastSeen, pool } = await runWithActor({
      initial: "Plan",
      fresh: "Implement",
      botUserId: "bot-user-uuid",
      actor: { actor_id: "human-user-uuid", actor_type: "user" },
    });
    expect(transitionIssueToState).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    // lastSeen advances to the new state so the next tick doesn't try
    // again.
    expect(lastSeen.get("i1")).toBe("Implement");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("reverts as before when actor.id == botUserId (agent self-move)", async () => {
    const { transitionIssueToState, createComment, lastSeen } = await runWithActor({
      initial: "Plan",
      fresh: "Implement",
      botUserId: "bot-user-uuid",
      actor: { actor_id: "bot-user-uuid", actor_type: "user" },
    });
    // Bot did the move → legacy revert fires.
    expect(transitionIssueToState).toHaveBeenCalledWith("i1", "Plan");
    expect(createComment).toHaveBeenCalled();
    expect(lastSeen.get("i1")).toBe("Plan");
  });

  it("falls back to legacy revert when no actor row exists", async () => {
    // No row — could be an event Symphony missed, or pre-Task-2 history.
    const { transitionIssueToState, lastSeen } = await runWithActor({
      initial: "Plan",
      fresh: "Implement",
      botUserId: "bot-user-uuid",
      actor: null,
    });
    expect(transitionIssueToState).toHaveBeenCalledWith("i1", "Plan");
    expect(lastSeen.get("i1")).toBe("Plan");
  });

  it("falls back to legacy revert when botUserId is null (boot lookup failed)", async () => {
    // boot fetchViewerId returned null → reconciler reverts as before
    // (status quo). The pool would be hit otherwise; ensure it isn't.
    const { transitionIssueToState, lastSeen, pool } = await runWithActor({
      initial: "Plan",
      fresh: "Implement",
      botUserId: null,
      actor: { actor_id: "human-user-uuid", actor_type: "user" },
    });
    expect(transitionIssueToState).toHaveBeenCalledWith("i1", "Plan");
    expect(lastSeen.get("i1")).toBe("Plan");
    // botUserId null → reconciler skips the actor check entirely.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("falls back to legacy revert when actor row's last_state doesn't match observed state (stale row)", async () => {
    // Stale-row guard (Copilot review): if the recorded
    // actor row reflects an OLDER state than what the orchestrator just
    // observed, we can't trust it — the webhook missed a delivery, or a
    // bot move came after the human one. Skipping revert based on a
    // stale human actor for a fresh bot move would defeat the gate.
    // This test simulates: actor row says human moved to "Plan", but
    // orchestrator now observes "Implement" — different state, fall
    // back to legacy revert.
    const { transitionIssueToState, lastSeen } = await runWithActor({
      initial: "Plan",
      fresh: "Implement",
      botUserId: "bot-user-uuid",
      // Actor moved to "Plan" earlier; now we see "Implement" → mismatch.
      actor: { actor_id: "human-user-uuid", actor_type: "user", state: "Plan" },
    });
    expect(transitionIssueToState).toHaveBeenCalledWith("i1", "Plan");
    expect(lastSeen.get("i1")).toBe("Plan");
  });

  it("falls back to legacy revert when the actor lookup throws", async () => {
    // Postgres outage — reconciler should not crash; should revert as
    // before (status quo). lastSeen reflects the revert.
    const { state, lastSeen } = seedRunningState("Plan");
    const tx = vi.fn<(id: string, name: string) => Promise<{ identifier: string; state: string }>>(
      async (_id, name) => ({ identifier: "PROJ-447", state: name }),
    );
    const cc = vi.fn(async () => ({ id: "c1", url: "u" }));
    const onTerminal = vi.fn(async () => undefined);
    const pool = {
      query: vi.fn(async () => {
        throw new Error("postgres connection refused");
      }),
    };
    await expect(
      reconcileTrackerStates({
        state,
        tracker: {
          fetchIssueStatesByIds: async () => [fakeIssue("Implement")],
          transitionIssueToState: tx as never,
          createComment: cc as never,
        },
        activeStates: ACTIVE_STATES,
        terminalStates: TERMINAL_STATES,
        humanReviewStates: HUMAN_REVIEW_STATES,
        stateTransitions: STATE_TRANSITIONS,
        lastSeenState: lastSeen,
        onTerminal,
        botUserId: "bot-user-uuid",
        pool: pool as never,
      }),
    ).resolves.not.toThrow();
    expect(tx).toHaveBeenCalledWith("i1", "Plan");
    expect(lastSeen.get("i1")).toBe("Plan");
  });
});
