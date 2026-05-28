import { describe, expect, it } from "vitest";
import { selectSubstantiveComments, type SymphonyComment } from "../../src/tracker/linear.js";

/**
 * Unit coverage for the conversation-history filter that trims the prompt's
 * comment window. Background: hot-patch #5 injected up to 25 prior comments
 * verbatim per dispatch, growing the prompt ~quadratically across stages
 * (Refinement → Plan → Validate → Implement → … → Done) and burning
 * ~$0.30/turn just on comment-history input on AGENT-447.
 */

const ISO = (n: number): string => new Date(2026, 3, 1, 9, n, 0).toISOString();

function comment(body: string, idx: number, author: string = "alice"): SymphonyComment {
  return { createdAt: ISO(idx), body, author };
}

describe("selectSubstantiveComments", () => {
  it("drops <!-- symphony:event=... lifecycle telemetry comments", () => {
    const input: SymphonyComment[] = [
      comment("<!-- symphony:event=turn_started -->\n🤖 Symphony — Plan turn 1", 1),
      comment("## Requirements\n- Acceptance: build clean", 2),
      comment("<!-- symphony:event=turn_finished -->\n✅ Symphony — Plan turn 1 finished", 3),
    ];
    const result = selectSubstantiveComments(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toContain("## Requirements");
  });

  it("drops <!-- cerebro:specialist=... lifecycle telemetry comments", () => {
    const input: SymphonyComment[] = [
      comment("<!-- cerebro:specialist=refiner -->\nRefiner pass complete", 1),
      comment("## RFC\n- File: src/x.ts", 2),
      comment("<!-- cerebro:specialist=planner -->\nPlanner pass complete", 3),
    ];
    const result = selectSubstantiveComments(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toContain("## RFC");
  });

  it("keeps ## Requirements / ## RFC / ## RCA / ## Implementer's checklist blocks", () => {
    const input: SymphonyComment[] = [
      comment("## Requirements\n- A", 1),
      comment("## RFC\n- File X", 2),
      comment("## RCA\n- Root cause: race", 3),
      comment("## Implementer's checklist\n- [ ] step", 4),
    ];
    const result = selectSubstantiveComments(input);
    expect(result).toHaveLength(4);
    const bodies = result.map((c: SymphonyComment) => c.body);
    expect(bodies.some((b: string) => b.includes("## Requirements"))).toBe(true);
    expect(bodies.some((b: string) => b.includes("## RFC"))).toBe(true);
    expect(bodies.some((b: string) => b.includes("## RCA"))).toBe(true);
    expect(bodies.some((b: string) => b.includes("## Implementer's checklist"))).toBe(true);
  });

  it("keeps comments bearing a github PR or commit URL", () => {
    const input: SymphonyComment[] = [
      comment("<!-- symphony:event=foo -->\nignored telemetry", 1),
      comment("PR opened: https://github.com/example-org/example-repo/pull/501", 2),
      comment(
        "Cherry-picked: https://github.com/example-org/example-repo/commit/abc1234def",
        3,
      ),
    ];
    const result = selectSubstantiveComments(input);
    expect(result).toHaveLength(2);
    expect(result[0]?.body).toContain("/pull/501");
    expect(result[1]?.body).toContain("/commit/abc1234def");
  });

  it("truncates bodies > 1500 chars with a `…[truncated, X chars total]` suffix", () => {
    const big = "## Requirements\n" + "x".repeat(2000);
    const total = big.length;
    const input: SymphonyComment[] = [comment(big, 1)];
    const result = selectSubstantiveComments(input);
    expect(result).toHaveLength(1);
    const body = result[0]?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(1500 + 64);
    expect(body.startsWith("## Requirements")).toBe(true);
    expect(body).toContain(`…[truncated, ${total} chars total]`);
  });

  it("does NOT add a truncation suffix to bodies at or below the cap", () => {
    const body = "## Requirements\n" + "y".repeat(100);
    const input: SymphonyComment[] = [comment(body, 1)];
    const result = selectSubstantiveComments(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe(body);
    expect(result[0]?.body).not.toContain("…[truncated");
  });

  it("returns at most 5 substantive entries even when 50 exist (most-recent-first selection, oldest-first output)", () => {
    const input: SymphonyComment[] = [];
    for (let i = 0; i < 50; i += 1) {
      input.push(comment(`## Requirements\n- iteration ${i}`, i));
    }
    const result = selectSubstantiveComments(input);
    expect(result).toHaveLength(5);
    expect(result[0]?.body).toContain("iteration 45");
    expect(result[1]?.body).toContain("iteration 46");
    expect(result[2]?.body).toContain("iteration 47");
    expect(result[3]?.body).toContain("iteration 48");
    expect(result[4]?.body).toContain("iteration 49");
  });

  it("keeps free-form human comments (no lifecycle markers, no symphony turn heading)", () => {
    const input: SymphonyComment[] = [
      comment("Hey, can you double-check the rate-limit handling on this one?", 1, "liuri"),
      comment("Sure, looking now.", 2, "max"),
    ];
    const result = selectSubstantiveComments(input);
    expect(result).toHaveLength(2);
    expect(result[0]?.body).toContain("rate-limit");
    expect(result[1]?.body).toContain("looking now");
  });

  it("drops the agent's own `🤖 Symphony — <state> turn N` lifecycle posts even without HTML markers", () => {
    const input: SymphonyComment[] = [
      comment("🤖 Symphony — Plan turn 1 started", 1),
      comment("✅ Symphony — Plan turn 1 finished — cost=$0.12", 2),
      comment("⏰ Symphony — Implement turn 3 timeout", 3),
      comment("## Requirements\n- ship the thing", 4),
    ];
    const result = selectSubstantiveComments(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toContain("## Requirements");
  });

  it("returns an empty array when given an empty input", () => {
    expect(selectSubstantiveComments([])).toEqual([]);
  });

  it("respects substantiveLimit override", () => {
    const input: SymphonyComment[] = [];
    for (let i = 0; i < 10; i += 1) {
      input.push(comment(`## Requirements\n- iter ${i}`, i));
    }
    const result = selectSubstantiveComments(input, { substantiveLimit: 2 });
    expect(result).toHaveLength(2);
    expect(result[0]?.body).toContain("iter 8");
    expect(result[1]?.body).toContain("iter 9");
  });

  it("respects bodyMaxChars override", () => {
    const big = "## RFC\n" + "z".repeat(500);
    const input: SymphonyComment[] = [comment(big, 1)];
    const result = selectSubstantiveComments(input, { bodyMaxChars: 100 });
    expect(result).toHaveLength(1);
    const body = result[0]?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(100 + 64);
    expect(body).toContain(`…[truncated, ${big.length} chars total]`);
  });
});
