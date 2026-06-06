/**
 * Unit tests for the Prioritized specialist module (§8 / E-11).
 *
 * Coverage:
 *   - SYSTEM_PROMPT shape (non-empty, mentions Prioritized + the 3 sections)
 *   - buildUserMessage echoes identifier/title/description
 *   - buildUserMessage echoes existing managed sections on the re-prioritize path
 *   - buildUserMessage includes substantive comments (oldest-first)
 *   - Specialist.state / name / promptVersion are set correctly
 *   - Live-Postgres integration: run() bumps validation_iteration via
 *     recordSpecialistRun(). Gated on DATABASE_URL like
 *     tests/unit/issue-metadata.test.ts.
 */

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import prioritized, { NAME, STATE } from "../../src/agents/prioritized/index.js";
import { buildUserMessage, SYSTEM_PROMPT } from "../../src/agents/prioritized/prompt.js";
import type { SpecialistContext } from "../../src/agents/types.js";
import { getIssueMetadata } from "../../src/audit/issue-metadata.js";
import type { MetadataStore } from "../../src/audit/store.js";
import { PostgresMetadataStore } from "../../src/audit/store-postgres.js";
import type { Issue } from "../../src/types.js";

/**
 * Minimal Issue factory used by every test that doesn't care about the
 * fields beyond identifier / title / description.
 */
function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    identifier: "STG-9999",
    title: "Add a logout-confirmation modal to legal-admin",
    description: "When the user clicks logout, ask them to confirm.",
    priority: 2,
    state: "Prioritized",
    branchName: null,
    url: "https://linear.app/example-org/issue/PROJ-9999",
    labels: [],
    blockedBy: [],
    createdAt: "2026-05-06T12:00:00.000Z",
    updatedAt: "2026-05-06T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * Minimal SpecialistContext factory. The store, tracker, and abortController
 * fields are typed but never touched by buildUserMessage; we leave them as
 * `null as any` for the prompt-shape tests and only wire a real store for
 * the live-Postgres `run()` test below.
 */
function fakeCtx(overrides: Partial<SpecialistContext> = {}): SpecialistContext {
  const noopLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  return {
    issue: fakeIssue(),
    comments: [],
    store: null as unknown as MetadataStore,
    tracker: null as unknown as SpecialistContext["tracker"],
    workspacePath: "/tmp/symphony-workspaces/STG-9999",
    logger: noopLogger,
    abortController: new AbortController(),
    ...overrides,
  };
}

describe("Prioritized specialist — module shape", () => {
  it("SYSTEM_PROMPT is non-empty and self-identifies as the Prioritized specialist", () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(200);
    expect(SYSTEM_PROMPT).toContain("Prioritized");
    // Must explicitly call out the three sections it owns.
    expect(SYSTEM_PROMPT).toContain("## Goals");
    expect(SYSTEM_PROMPT).toContain("## Context");
    expect(SYSTEM_PROMPT).toContain("## Questions");
    // Must reference the exactly-five-questions rule.
    expect(SYSTEM_PROMPT).toMatch(/exactly 5|Exactly 5|exactly five/i);
  });

  it("Specialist.state is 'Prioritized' and name is 'prioritized' (kebab-case slug)", () => {
    expect(prioritized.state).toBe("Prioritized");
    expect(prioritized.name).toBe("prioritized");
    expect(STATE).toBe("Prioritized");
    expect(NAME).toBe("prioritized");
  });

  it("Specialist.promptVersion is set (non-empty string)", () => {
    expect(typeof prioritized.promptVersion).toBe("string");
    expect(prioritized.promptVersion.length).toBeGreaterThan(0);
  });

  it("Specialist.systemPrompt equals the exported SYSTEM_PROMPT", () => {
    expect(prioritized.systemPrompt).toBe(SYSTEM_PROMPT);
  });
});

describe("Prioritized specialist — buildUserMessage", () => {
  it("includes the issue identifier and title in the header", () => {
    const ctx = fakeCtx({ issue: fakeIssue() });
    const out = buildUserMessage(ctx);
    expect(out).toContain("STG-9999");
    expect(out).toContain("Add a logout-confirmation modal to legal-admin");
    // Sanity: header should be the very first line.
    expect(out.split("\n")[0]).toBe(
      "# Prioritized turn for STG-9999 — Add a logout-confirmation modal to legal-admin",
    );
  });

  it("echoes the raw description body verbatim", () => {
    const ctx = fakeCtx({
      issue: fakeIssue({
        description: "When the user clicks logout, ask them to confirm.\n\n- Use a modal.",
      }),
    });
    const out = buildUserMessage(ctx);
    expect(out).toContain("When the user clicks logout, ask them to confirm.");
    expect(out).toContain("- Use a modal.");
  });

  it("falls back to a placeholder when description is null/empty", () => {
    const out = buildUserMessage(fakeCtx({ issue: fakeIssue({ description: null }) }));
    expect(out).toContain("(no description provided)");
  });

  it("on the re-prioritize path echoes existing Goals / Context / Questions sections", () => {
    const description = [
      "Original human request goes here.",
      "",
      "## Goals",
      "",
      "Add a logout-confirmation modal in legal-admin.",
      "",
      "## Context",
      "",
      "Saw `apps/frontend/legal-admin/components/topbar.tsx` already has a logout button.",
      "",
      "## Questions",
      "",
      "1. Which component library? (HeroUI vs custom)",
      "2. Cancel button copy?",
      "3. Destructive variant or primary?",
      "4. Telemetry event name?",
      "5. Edge case for keyboard-only users?",
      "",
    ].join("\n");
    const ctx = fakeCtx({ issue: fakeIssue({ description }) });
    const out = buildUserMessage(ctx);
    // Must surface the re-prioritize hint banner.
    expect(out).toMatch(/[Rr]e-prioritize run/);
    // Must echo each previous section under its labeled heading.
    expect(out).toContain("## Previous output — Goals");
    expect(out).toContain("Add a logout-confirmation modal in legal-admin.");
    expect(out).toContain("## Previous output — Context");
    expect(out).toContain("apps/frontend/legal-admin/components/topbar.tsx");
    expect(out).toContain("## Previous output — Questions");
    expect(out).toContain("1. Which component library?");
    expect(out).toContain("5. Edge case for keyboard-only users?");
  });

  it("does NOT show the re-prioritize hint when no Goals section exists yet", () => {
    const ctx = fakeCtx({
      issue: fakeIssue({
        description: "Fresh ticket without prior agent output.",
      }),
    });
    const out = buildUserMessage(ctx);
    expect(out).not.toMatch(/[Rr]e-prioritize run/);
    expect(out).not.toContain("## Previous output — Goals");
  });

  it("includes substantive comments oldest-first with author + timestamp labels", () => {
    const ctx = fakeCtx({
      comments: [
        {
          author: "alice@example.com",
          createdAt: "2026-05-05T10:00:00Z",
          body: "First, please use HeroUI not a custom modal.",
        },
        {
          author: "bob@example.com",
          createdAt: "2026-05-06T08:30:00Z",
          body: "Also we need a destructive variant — red Confirm button.",
        },
      ],
    });
    const out = buildUserMessage(ctx);
    expect(out).toContain("## Conversation history");
    expect(out).toContain("### alice@example.com — 2026-05-05T10:00:00Z");
    expect(out).toContain("First, please use HeroUI not a custom modal.");
    expect(out).toContain("### bob@example.com — 2026-05-06T08:30:00Z");
    expect(out).toContain("Also we need a destructive variant");
    // Order check: alice's comment must appear before bob's.
    const aliceIdx = out.indexOf("alice@example.com");
    const bobIdx = out.indexOf("bob@example.com");
    expect(aliceIdx).toBeGreaterThan(-1);
    expect(bobIdx).toBeGreaterThan(aliceIdx);
  });

  it("includes the monorepo grep-target footer", () => {
    const out = buildUserMessage(fakeCtx());
    expect(out).toContain("Where to look in the monorepo");
    expect(out).toContain("README.md");
    expect(out).toContain("docs/adr/");
    expect(out).toContain("AGENTS.md");
  });
});

// Live-Postgres test — gated on DATABASE_URL, mirrors the pattern in
// tests/unit/issue-metadata.test.ts.
const DATABASE_URL = process.env.DATABASE_URL;
const SUITE = DATABASE_URL ? describe : describe.skip;

SUITE("Prioritized specialist — live Postgres run() stub", () => {
  let pool: pg.Pool;
  // Pad with the test name so concurrent test runs (CI matrix, retries)
  // don't collide on issue_id PK.
  const TEST_ISSUE_ID = `00000000-0000-0000-0000-${(Date.now() + 1).toString().padStart(12, "0")}`;
  const TEST_ISSUE_IDENT = `STG-PRIORITIZED-${Date.now()}`;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, [TEST_ISSUE_ID]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, [TEST_ISSUE_ID]);
  });

  it("run() returns a Succeeded SpecialistResult with zero cost (Phase 2 stub)", async () => {
    const ctx = fakeCtx({
      store: new PostgresMetadataStore(pool),
      issue: fakeIssue({ id: TEST_ISSUE_ID, identifier: TEST_ISSUE_IDENT }),
    });
    const result = await prioritized.run(ctx);
    expect(result.outcome).toBe("Succeeded");
    expect(result.costUsd).toBe(0);
    expect(result.tokens).toEqual({ input: 0, output: 0, total: 0 });
    expect(result.model).toBeNull();
    expect(result.error).toBeNull();
  });

  it("run() bumps validation_iteration and stamps last_specialist=prioritized", async () => {
    const ctx = fakeCtx({
      store: new PostgresMetadataStore(pool),
      issue: fakeIssue({ id: TEST_ISSUE_ID, identifier: TEST_ISSUE_IDENT }),
    });
    await prioritized.run(ctx);
    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta).not.toBeNull();
    expect(meta!.validationIteration).toBe(1);
    expect(meta!.planIteration).toBe(0);
    expect(meta!.prValidationIteration).toBe(0);
    expect(meta!.lastSpecialist).toBe("prioritized");
  });

  it("run() is incremental — two invocations bump the counter to 2", async () => {
    const ctx = fakeCtx({
      store: new PostgresMetadataStore(pool),
      issue: fakeIssue({ id: TEST_ISSUE_ID, identifier: TEST_ISSUE_IDENT }),
    });
    await prioritized.run(ctx);
    await prioritized.run(ctx);
    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.validationIteration).toBe(2);
  });
});
