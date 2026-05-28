/**
 * §8 / E-10..E-15 conformance — 16-state specialist registry + prompt routing.
 *
 * Asserts that:
 *   - `findSpecialist(stateName)` resolves the correct specialist module by
 *     state name, case-insensitively.
 *   - `findSpecialist` returns null for unowned states (Backlog, Done, etc.).
 *   - `buildSpecialistPrompt` returns a string that opens with the
 *     specialist's SYSTEM_PROMPT for an owned state.
 *   - `buildSpecialistPrompt` returns null for unowned states so the caller
 *     falls back to the legacy `buildFullPrompt` path.
 *
 * The build only exercises the state→specialist routing — `Specialist.run()`
 * is still a stub for all four specialists, so we don't need a live
 * Postgres pool here. We pass `undefined as unknown as pg.Pool` as a
 * sentinel because the specialists' `buildUserMessage` doesn't touch the
 * pool during prompt construction (verified by reading each module's
 * prompt.ts — only PR validation MIGHT read it, and falls back to a
 * placeholder string when the iteration counter isn't on `ctx.extra`).
 */

import type pg from "pg";
import { describe, expect, it } from "vitest";

import prioritized from "../../src/agents/prioritized/index.js";
import technicalPlan from "../../src/agents/technical-plan/index.js";
import prValidation from "../../src/agents/pr-validation/index.js";
import release from "../../src/agents/release/index.js";
import { findSpecialist, SPECIALISTS } from "../../src/agents/index.js";
import { buildSpecialistPrompt } from "../../src/agent/prompt.js";
import type { Issue } from "../../src/types.js";
import type { LinearTrackerClient as LinearTracker } from "../../src/tracker/linear.js";

function fakeIssue(state: string): Issue {
  return {
    id: "i1",
    identifier: "STG-1",
    title: "test issue",
    description: "## Goals\nA placeholder body for prompt assembly.",
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

// `buildSpecialistPrompt` documents that none of the four specialists' build
// functions actually call methods on the pool / tracker during prompt
// construction. We assert that contract by passing nullish stubs cast to
// the expected types — if a future change adds a synchronous DB read, this
// test fails with a clear NPE pointing at the offending specialist.
const FAKE_POOL = undefined as unknown as pg.Pool;
const FAKE_TRACKER = undefined as unknown as LinearTracker;

describe("§8 specialist registry — findSpecialist", () => {
  it("resolves Prioritized to the prioritized specialist", () => {
    expect(findSpecialist("Prioritized")).toBe(prioritized);
  });

  it("resolves Technical plan to the technical-plan specialist", () => {
    expect(findSpecialist("Technical plan")).toBe(technicalPlan);
  });

  it("resolves PR validation to the pr-validation specialist", () => {
    expect(findSpecialist("PR validation")).toBe(prValidation);
  });

  it("resolves Release to the release specialist", () => {
    expect(findSpecialist("Release")).toBe(release);
  });

  it("returns null for terminal / unowned states", () => {
    expect(findSpecialist("Done")).toBeNull();
    expect(findSpecialist("Backlog")).toBeNull();
    expect(findSpecialist("Canceled")).toBeNull();
    expect(findSpecialist("Questions (manual)")).toBeNull();
  });

  it("is case-insensitive on state name", () => {
    expect(findSpecialist("PRIORITIZED")).toBe(prioritized);
    expect(findSpecialist("prioritized")).toBe(prioritized);
    expect(findSpecialist("pr validation")).toBe(prValidation);
    expect(findSpecialist("RELEASE")).toBe(release);
  });

  it("includes exactly the four wired specialists", () => {
    expect(SPECIALISTS).toHaveLength(4);
    expect(SPECIALISTS.map((s) => s.name).sort()).toEqual(
      ["pr-validation", "prioritized", "release", "technical-plan"].sort(),
    );
  });
});

describe("§8 buildSpecialistPrompt — first-turn rendering", () => {
  it("returns a string opening with the specialist's SYSTEM_PROMPT for Prioritized", async () => {
    const prompt = await buildSpecialistPrompt({
      state: "Prioritized",
      issue: fakeIssue("Prioritized"),
      attempt: null,
      comments: [],
      pool: FAKE_POOL,
      tracker: FAKE_TRACKER,
      workspacePath: "/tmp/test-workspace",
    });
    expect(prompt).not.toBeNull();
    expect(prompt!).toMatch(/^You are Symphony's Prioritized specialist/);
    // The user message is concatenated after the system prompt with a "---"
    // separator. Assert both halves landed.
    expect(prompt!).toContain("---");
    expect(prompt!).toContain("STG-1");
  });

  it("returns null for Backlog (not dispatched)", async () => {
    const prompt = await buildSpecialistPrompt({
      state: "Backlog",
      issue: fakeIssue("Backlog"),
      attempt: null,
      comments: [],
      pool: FAKE_POOL,
      tracker: FAKE_TRACKER,
      workspacePath: "/tmp/test-workspace",
    });
    expect(prompt).toBeNull();
  });

  it("returns null for Done (terminal state, never dispatched)", async () => {
    const prompt = await buildSpecialistPrompt({
      state: "Done",
      issue: fakeIssue("Done"),
      attempt: null,
      comments: [],
      pool: FAKE_POOL,
      tracker: FAKE_TRACKER,
      workspacePath: "/tmp/test-workspace",
    });
    expect(prompt).toBeNull();
  });

  it("matches case-insensitively (caller passes Linear's casing verbatim)", async () => {
    const prompt = await buildSpecialistPrompt({
      state: "RELEASE",
      issue: fakeIssue("RELEASE"),
      attempt: null,
      comments: [],
      pool: FAKE_POOL,
      tracker: FAKE_TRACKER,
      workspacePath: "/tmp/test-workspace",
    });
    expect(prompt).not.toBeNull();
    expect(prompt!).toMatch(/^You are Symphony's Release specialist/);
  });
});
