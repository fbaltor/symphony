import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PR_VALIDATION_ITERATION_CAP,
  ensureIssueMetadataRow,
  getIssueMetadata,
  isPrValidationCapped,
  markQuestionsAnswered,
  recordSpecialistRun,
  setErrorState,
} from "../../src/audit/issue-metadata.js";

const DATABASE_URL = process.env.DATABASE_URL;
const SUITE = DATABASE_URL ? describe : describe.skip;

SUITE("issue-metadata accessor (live Postgres)", () => {
  let pool: pg.Pool;
  const TEST_ISSUE_ID = `00000000-0000-0000-0000-${Date.now().toString().padStart(12, "0")}`;
  const TEST_ISSUE_IDENT = `STG-TEST-${Date.now()}`;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    // Clean up test row
    await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, [TEST_ISSUE_ID]);
    await pool.end();
  });

  beforeEach(async () => {
    // Each test starts with a clean slate for our test issue.
    await pool.query(`DELETE FROM symphony.issue_metadata WHERE issue_id = $1`, [TEST_ISSUE_ID]);
  });

  it("getIssueMetadata returns null for an unknown issue", async () => {
    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta).toBeNull();
  });

  it("ensureIssueMetadataRow creates a fresh row with defaults", async () => {
    await ensureIssueMetadataRow(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
    });
    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta).not.toBeNull();
    expect(meta!.validationIteration).toBe(0);
    expect(meta!.questionsAnswered).toBe(false);
    expect(meta!.planIteration).toBe(0);
    expect(meta!.prValidationIteration).toBe(0);
    expect(meta!.errorState).toBeNull();
    expect(meta!.costUsd).toBe(0);
    expect(meta!.lastSpecialist).toBeNull();
  });

  it("ensureIssueMetadataRow is idempotent", async () => {
    await ensureIssueMetadataRow(pool, { issueId: TEST_ISSUE_ID, issueIdentifier: TEST_ISSUE_IDENT });
    await ensureIssueMetadataRow(pool, { issueId: TEST_ISSUE_ID, issueIdentifier: TEST_ISSUE_IDENT });
    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta).not.toBeNull();
  });

  it("recordSpecialistRun bumps validation_iteration when iterationKey=validation", async () => {
    await recordSpecialistRun(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
      specialist: "prioritized",
      costUsdDelta: 1.5,
      iterationKey: "validation",
    });
    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.validationIteration).toBe(1);
    expect(meta!.planIteration).toBe(0);
    expect(meta!.prValidationIteration).toBe(0);
    expect(meta!.costUsd).toBeCloseTo(1.5);
    expect(meta!.lastSpecialist).toBe("prioritized");
  });

  it("recordSpecialistRun is incremental — multiple runs accumulate cost + counter", async () => {
    await recordSpecialistRun(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
      specialist: "prioritized",
      costUsdDelta: 1.5,
      iterationKey: "validation",
    });
    await recordSpecialistRun(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
      specialist: "prioritized",
      costUsdDelta: 0.7,
      iterationKey: "validation",
    });
    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.validationIteration).toBe(2);
    expect(meta!.costUsd).toBeCloseTo(2.2);
  });

  it("recordSpecialistRun with different iterationKeys bumps independent counters", async () => {
    await recordSpecialistRun(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
      specialist: "prioritized",
      costUsdDelta: 1,
      iterationKey: "validation",
    });
    await recordSpecialistRun(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
      specialist: "technical-plan",
      costUsdDelta: 2,
      iterationKey: "plan",
    });
    await recordSpecialistRun(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
      specialist: "pr-validation",
      costUsdDelta: 3,
      iterationKey: "pr_validation",
    });
    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.validationIteration).toBe(1);
    expect(meta!.planIteration).toBe(1);
    expect(meta!.prValidationIteration).toBe(1);
    expect(meta!.costUsd).toBeCloseTo(6);
    expect(meta!.lastSpecialist).toBe("pr-validation");
  });

  it("recordSpecialistRun with iterationKey=null records cost/specialist only", async () => {
    await recordSpecialistRun(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
      specialist: "release",
      costUsdDelta: 5,
      iterationKey: null,
    });
    const meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.validationIteration).toBe(0);
    expect(meta!.planIteration).toBe(0);
    expect(meta!.prValidationIteration).toBe(0);
    expect(meta!.costUsd).toBeCloseTo(5);
    expect(meta!.lastSpecialist).toBe("release");
  });

  it("markQuestionsAnswered flips the flag idempotently", async () => {
    await markQuestionsAnswered(pool, { issueId: TEST_ISSUE_ID, issueIdentifier: TEST_ISSUE_IDENT });
    let meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.questionsAnswered).toBe(true);
    await markQuestionsAnswered(pool, { issueId: TEST_ISSUE_ID, issueIdentifier: TEST_ISSUE_IDENT });
    meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.questionsAnswered).toBe(true);
  });

  it("setErrorState writes the stage name and clears with null", async () => {
    await setErrorState(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
      state: "PR validation",
    });
    let meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.errorState).toBe("PR validation");
    await setErrorState(pool, {
      issueId: TEST_ISSUE_ID,
      issueIdentifier: TEST_ISSUE_IDENT,
      state: null,
    });
    meta = await getIssueMetadata(pool, TEST_ISSUE_ID);
    expect(meta!.errorState).toBeNull();
  });

  it("isPrValidationCapped returns false on a fresh issue and true at the cap", async () => {
    expect(await isPrValidationCapped(pool, TEST_ISSUE_ID)).toBe(false);
    await ensureIssueMetadataRow(pool, { issueId: TEST_ISSUE_ID, issueIdentifier: TEST_ISSUE_IDENT });
    // Simulate hitting the cap
    await pool.query(
      `UPDATE symphony.issue_metadata SET pr_validation_iteration = $1 WHERE issue_id = $2`,
      [PR_VALIDATION_ITERATION_CAP, TEST_ISSUE_ID],
    );
    expect(await isPrValidationCapped(pool, TEST_ISSUE_ID)).toBe(true);
  });
});
