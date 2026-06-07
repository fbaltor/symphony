import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { logger } from "../../src/observability/logger.js";
import {
  type CascadeContext,
  runCancelCascade,
  runDevelopmentCascade,
  runSubDoneWatcher,
} from "../../src/orchestrator/cascade.js";

interface ChildSpec {
  id: string;
  identifier: string;
  title: string;
  state: string;
  description: string | null;
  url: string | null;
}

class FakeTracker {
  childrenByParent = new Map<string, ChildSpec[]>();
  transitionCalls: Array<{ issueId: string; state: string }> = [];
  commentCalls: Array<{ issueId: string; body: string }> = [];
  /** Set true to throw on every transition (simulates Linear write outage). */
  failTransitions = false;
  /** Optional: fail on a specific issueId only. */
  failTransitionFor: Set<string> = new Set();

  async fetchChildIssues(parentId: string): Promise<ChildSpec[]> {
    return this.childrenByParent.get(parentId) ?? [];
  }

  async transitionIssueToState(issueId: string, state: string) {
    if (this.failTransitions || this.failTransitionFor.has(issueId)) {
      throw new Error(`fake: transitionIssueToState failed for ${issueId} → ${state}`);
    }
    this.transitionCalls.push({ issueId, state });
    // Mutate the child state in our fake state-of-the-world so subsequent
    // queries see the new state.
    for (const subs of this.childrenByParent.values()) {
      const c = subs.find((x) => x.id === issueId);
      if (c) c.state = state;
    }
    return { identifier: issueId, state };
  }

  async createComment(issueId: string, body: string) {
    this.commentCalls.push({ issueId, body });
    return { id: `comment-${this.commentCalls.length}`, url: "" };
  }
}

const PARENT = { id: "parent-1", identifier: "PROJ-100" };

const DATABASE_URL = process.env.DATABASE_URL;
const SUITE = DATABASE_URL ? describe : describe.skip;

SUITE("cascade dispatch (live Postgres for issue_metadata UPSERTs)", () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  describe("runDevelopmentCascade", () => {
    let tracker: FakeTracker;
    let ctx: CascadeContext;
    beforeEach(async () => {
      tracker = new FakeTracker();
      ctx = { tracker: tracker as never, pool, logger };
    });

    it("transitions every sub in 'Subtask drafted' to 'To implement (manual)'", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "s1", identifier: "PROJ-101", title: "A", state: "Subtask drafted", description: null, url: null },
        { id: "s2", identifier: "PROJ-102", title: "B", state: "Subtask drafted", description: null, url: null },
        { id: "s3", identifier: "PROJ-103", title: "C", state: "Subtask drafted", description: null, url: null },
      ]);

      const result = await runDevelopmentCascade(ctx, PARENT);

      expect(result.cascadedSubIdentifiers).toEqual(["PROJ-101", "PROJ-102", "PROJ-103"]);
      expect(result.skippedSubIdentifiers).toEqual([]);
      expect(tracker.transitionCalls).toHaveLength(3);
      for (const call of tracker.transitionCalls) {
        expect(call.state).toBe("To implement (manual)");
      }

      // Cleanup metadata rows
      await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = ANY($1)`, [["s1", "s2", "s3"]]);
    });

    it("skips subs not in 'Subtask drafted' (idempotency)", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "s1", identifier: "PROJ-101", title: "A", state: "Subtask drafted", description: null, url: null },
        { id: "s2", identifier: "PROJ-102", title: "B", state: "Pull request", description: null, url: null }, // human raced ahead
        { id: "s3", identifier: "PROJ-103", title: "C", state: "Done", description: null, url: null },
      ]);

      const result = await runDevelopmentCascade(ctx, PARENT);

      expect(result.cascadedSubIdentifiers).toEqual(["PROJ-101"]);
      expect(result.skippedSubIdentifiers).toEqual(["PROJ-102", "PROJ-103"]);
      expect(tracker.transitionCalls).toHaveLength(1);

      await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, ["s1"]);
    });

    it("posts a parent comment listing the cascaded subs", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "s1", identifier: "PROJ-101", title: "A", state: "Subtask drafted", description: null, url: null },
        { id: "s2", identifier: "PROJ-102", title: "B", state: "Subtask drafted", description: null, url: null },
      ]);

      await runDevelopmentCascade(ctx, PARENT);

      expect(tracker.commentCalls).toHaveLength(1);
      const body = tracker.commentCalls[0]!.body;
      expect(body).toContain("Development cascade");
      expect(body).toContain("PROJ-101");
      expect(body).toContain("PROJ-102");
      expect(body).toContain("To implement (manual)");

      await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = ANY($1)`, [["s1", "s2"]]);
    });

    it("no-ops when parent has no sub-issues (logs warn but doesn't throw)", async () => {
      tracker.childrenByParent.set(PARENT.id, []);
      const result = await runDevelopmentCascade(ctx, PARENT);
      expect(result.cascadedSubIdentifiers).toEqual([]);
      expect(tracker.transitionCalls).toEqual([]);
      expect(tracker.commentCalls).toEqual([]);
    });

    it("collects per-sub failures into errors[] without aborting the rest", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "s1", identifier: "PROJ-101", title: "A", state: "Subtask drafted", description: null, url: null },
        { id: "s2", identifier: "PROJ-102", title: "B", state: "Subtask drafted", description: null, url: null },
      ]);
      tracker.failTransitionFor.add("s2");

      const result = await runDevelopmentCascade(ctx, PARENT);

      expect(result.cascadedSubIdentifiers).toEqual(["PROJ-101"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.subIdentifier).toBe("PROJ-102");

      await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, ["s1"]);
    });

    it("UPSERTs an issue_metadata row for each cascaded sub", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "s-meta-1", identifier: "PROJ-201", title: "A", state: "Subtask drafted", description: null, url: null },
      ]);
      await runDevelopmentCascade(ctx, PARENT);

      const { rows } = await pool.query(
        `SELECT issue_identifier FROM symphony.issue_metadata WHERE issue_id = $1`,
        ["s-meta-1"],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].issue_identifier).toBe("PROJ-201");

      await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, ["s-meta-1"]);
    });
  });

  describe("runCancelCascade", () => {
    let tracker: FakeTracker;
    let ctx: CascadeContext;
    beforeEach(() => {
      tracker = new FakeTracker();
      ctx = { tracker: tracker as never, pool, logger };
    });

    it("cancels all non-terminal subs", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "c1", identifier: "PROJ-301", title: "A", state: "Subtask drafted", description: null, url: null },
        { id: "c2", identifier: "PROJ-302", title: "B", state: "Implementation (manual)", description: null, url: null },
        { id: "c3", identifier: "PROJ-303", title: "C", state: "PR validation", description: null, url: null },
      ]);

      const result = await runCancelCascade(ctx, PARENT);

      expect(result.cascadedSubIdentifiers.sort()).toEqual(["PROJ-301", "PROJ-302", "PROJ-303"]);
      for (const call of tracker.transitionCalls) {
        expect(call.state).toBe("Canceled");
      }
    });

    it("does NOT touch subs already in terminal states (Done/Canceled/Duplicate)", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "c1", identifier: "PROJ-401", title: "A", state: "Done", description: null, url: null },
        { id: "c2", identifier: "PROJ-402", title: "B", state: "Implementation (manual)", description: null, url: null },
        { id: "c3", identifier: "PROJ-403", title: "C", state: "Canceled", description: null, url: null },
        { id: "c4", identifier: "PROJ-404", title: "D", state: "Duplicate", description: null, url: null },
      ]);

      const result = await runCancelCascade(ctx, PARENT);

      expect(result.cascadedSubIdentifiers).toEqual(["PROJ-402"]);
      expect(result.skippedSubIdentifiers.sort()).toEqual(["PROJ-401", "PROJ-403", "PROJ-404"]);
    });

    it("posts a parent comment listing canceled subs", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "c1", identifier: "PROJ-501", title: "A", state: "Implementation (manual)", description: null, url: null },
      ]);
      await runCancelCascade(ctx, PARENT);

      expect(tracker.commentCalls).toHaveLength(1);
      const body = tracker.commentCalls[0]!.body;
      expect(body).toContain("Cancel cascade");
      expect(body).toContain("PROJ-501");
    });

    it("no-ops when there's nothing to cancel (parent has no subs OR all subs terminal)", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "c1", identifier: "PROJ-601", title: "A", state: "Done", description: null, url: null },
      ]);

      const result = await runCancelCascade(ctx, PARENT);
      expect(result.cascadedSubIdentifiers).toEqual([]);
      expect(tracker.transitionCalls).toEqual([]);
      // No comment when nothing was actually canceled.
      expect(tracker.commentCalls).toEqual([]);
    });
  });

  describe("runSubDoneWatcher", () => {
    let tracker: FakeTracker;
    let ctx: CascadeContext;
    beforeEach(() => {
      tracker = new FakeTracker();
      ctx = { tracker: tracker as never, pool, logger };
    });

    it("transitions parent → Validation (manual) when ALL subs are Done", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "d1", identifier: "PROJ-701", title: "A", state: "Done", description: null, url: null },
        { id: "d2", identifier: "PROJ-702", title: "B", state: "Done", description: null, url: null },
      ]);
      const result = await runSubDoneWatcher(ctx, { ...PARENT, state: "Development" });
      expect(result.parentTransitioned).toBe(true);
      expect(result.totalSiblings).toBe(2);
      expect(result.completedSiblings).toBe(2);
      expect(tracker.transitionCalls).toEqual([{ issueId: PARENT.id, state: "Validation (manual)" }]);
    });

    it("counts Canceled and Duplicate as 'completed' (still fires the watcher)", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "d1", identifier: "PROJ-801", title: "A", state: "Done", description: null, url: null },
        { id: "d2", identifier: "PROJ-802", title: "B", state: "Canceled", description: null, url: null },
        { id: "d3", identifier: "PROJ-803", title: "C", state: "Duplicate", description: null, url: null },
      ]);
      const result = await runSubDoneWatcher(ctx, { ...PARENT, state: "Development" });
      expect(result.parentTransitioned).toBe(true);
    });

    it("does NOT fire when only some subs are done", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "d1", identifier: "PROJ-901", title: "A", state: "Done", description: null, url: null },
        { id: "d2", identifier: "PROJ-902", title: "B", state: "Implementation (manual)", description: null, url: null },
      ]);
      const result = await runSubDoneWatcher(ctx, { ...PARENT, state: "Development" });
      expect(result.parentTransitioned).toBe(false);
      expect(result.skipReason).toContain("1/2");
      expect(tracker.transitionCalls).toEqual([]);
    });

    it("is idempotent — parent already in Validation (manual) is a fast-path no-op", async () => {
      // Children are all done...
      tracker.childrenByParent.set(PARENT.id, [
        { id: "d1", identifier: "PROJ-1001", title: "A", state: "Done", description: null, url: null },
      ]);
      // ... but parent has already moved.
      const result = await runSubDoneWatcher(ctx, { ...PARENT, state: "Validation (manual)" });
      expect(result.parentTransitioned).toBe(false);
      expect(result.skipReason).toContain("already in");
      expect(tracker.transitionCalls).toEqual([]);
    });

    it("is idempotent — parent already in Done is a fast-path no-op", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "d1", identifier: "PROJ-1101", title: "A", state: "Done", description: null, url: null },
      ]);
      const result = await runSubDoneWatcher(ctx, { ...PARENT, state: "Done" });
      expect(result.parentTransitioned).toBe(false);
      expect(result.skipReason).toContain("already in Done");
    });

    it("posts a 'parent advanced' comment on success", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "d1", identifier: "PROJ-1201", title: "A", state: "Done", description: null, url: null },
      ]);
      await runSubDoneWatcher(ctx, { ...PARENT, state: "Development" });
      expect(tracker.commentCalls).toHaveLength(1);
      const body = tracker.commentCalls[0]!.body;
      expect(body).toContain("Sub-Done watcher");
      expect(body).toContain("Validation (manual)");
    });

    it("returns a structured result with skipReason on transition failure", async () => {
      tracker.childrenByParent.set(PARENT.id, [
        { id: "d1", identifier: "PROJ-1301", title: "A", state: "Done", description: null, url: null },
      ]);
      tracker.failTransitions = true;
      const result = await runSubDoneWatcher(ctx, { ...PARENT, state: "Development" });
      expect(result.parentTransitioned).toBe(false);
      expect(result.skipReason).toContain("failed");
    });
  });
});
