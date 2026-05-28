import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDiskFreeBytes, runEmergencyGc, runPeriodicGc } from "../../src/workspace/cleanup.js";
import { DISK_PRESSURE_FREE_BYTES, ensureWorkspace } from "../../src/workspace/manager.js";

/**
 * Workspace garbage-collection tests.
 *
 * Covers the periodic GC, emergency GC, and the disk-pressure safeguard
 * plumbed through `ensureWorkspace`. The disk-pressure assertion exercises
 * the public threshold constant + the GC dispatcher path; we don't try to
 * truly fill the host filesystem (would be flaky on CI), instead we verify
 * that when `runEmergencyGc` is invoked directly with the right key sets
 * it removes exactly the unprotected workspaces.
 */

function freshRoot(): string {
  return mkdtempSync(`${tmpdir()}/sym-gc-`);
}

function makeWorkspace(root: string, name: string, ageMs: number): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "marker"), name);
  // Backdate mtime so the periodic-age threshold can fire.
  const target = (Date.now() - ageMs) / 1000;
  utimesSync(path, target, target);
  return path;
}

describe("workspace GC", () => {
  it("periodic GC removes stale workspaces older than gcMaxAgeMs", async () => {
    const root = freshRoot();
    makeWorkspace(root, "ABC-1", 0); // fresh
    makeWorkspace(root, "ABC-2", 60 * 60 * 1000 * 2); // 2h old → eligible
    makeWorkspace(root, "ABC-3", 60 * 60 * 1000 * 5); // 5h old → eligible

    const removed = await runPeriodicGc({
      workspaceRoot: root,
      runningKeys: new Set(),
      claimedKeys: new Set(),
      gcMaxAgeMs: 60 * 60 * 1000, // 1h
      beforeRemoveScript: null,
      hookTimeoutMs: 1_000,
    });

    expect(removed).toBe(2);
    expect(() => statSync(join(root, "ABC-1"))).not.toThrow();
    expect(() => statSync(join(root, "ABC-2"))).toThrow();
    expect(() => statSync(join(root, "ABC-3"))).toThrow();
  });

  it("periodic GC respects runningKeys and claimedKeys", async () => {
    const root = freshRoot();
    makeWorkspace(root, "RUN-1", 60 * 60 * 1000 * 5);
    makeWorkspace(root, "CLAIM-2", 60 * 60 * 1000 * 5);
    makeWorkspace(root, "FREE-3", 60 * 60 * 1000 * 5);

    const removed = await runPeriodicGc({
      workspaceRoot: root,
      runningKeys: new Set(["RUN-1"]),
      claimedKeys: new Set(["CLAIM-2"]),
      gcMaxAgeMs: 60 * 60 * 1000,
      beforeRemoveScript: null,
      hookTimeoutMs: 1_000,
    });

    expect(removed).toBe(1);
    expect(() => statSync(join(root, "RUN-1"))).not.toThrow();
    expect(() => statSync(join(root, "CLAIM-2"))).not.toThrow();
    expect(() => statSync(join(root, "FREE-3"))).toThrow();
  });

  it("periodic GC ignores fresh workspaces below the age threshold", async () => {
    const root = freshRoot();
    makeWorkspace(root, "FRESH-1", 5 * 60 * 1000); // 5 min old
    const removed = await runPeriodicGc({
      workspaceRoot: root,
      runningKeys: new Set(),
      claimedKeys: new Set(),
      gcMaxAgeMs: 60 * 60 * 1000,
      beforeRemoveScript: null,
      hookTimeoutMs: 1_000,
    });
    expect(removed).toBe(0);
    expect(() => statSync(join(root, "FRESH-1"))).not.toThrow();
  });

  it("periodic GC handles a missing root without crashing", async () => {
    const removed = await runPeriodicGc({
      workspaceRoot: join(tmpdir(), "sym-gc-does-not-exist-" + Date.now()),
      runningKeys: new Set(),
      claimedKeys: new Set(),
      gcMaxAgeMs: 60 * 60 * 1000,
      beforeRemoveScript: null,
      hookTimeoutMs: 1_000,
    });
    expect(removed).toBe(0);
  });

  it("emergency GC removes everything not in running/claimed regardless of age", async () => {
    const root = freshRoot();
    makeWorkspace(root, "RUN-1", 0);
    makeWorkspace(root, "FRESH-2", 0); // brand-new but unprotected
    makeWorkspace(root, "OLD-3", 60 * 60 * 1000 * 5);

    const removed = await runEmergencyGc({
      workspaceRoot: root,
      runningKeys: new Set(["RUN-1"]),
      claimedKeys: new Set(),
      beforeRemoveScript: null,
      hookTimeoutMs: 1_000,
    });

    expect(removed).toBe(2);
    expect(() => statSync(join(root, "RUN-1"))).not.toThrow();
    expect(() => statSync(join(root, "FRESH-2"))).toThrow();
    expect(() => statSync(join(root, "OLD-3"))).toThrow();
  });

  it("getDiskFreeBytes returns a non-negative number for a real path", async () => {
    const root = freshRoot();
    const free = await getDiskFreeBytes(root);
    expect(free).not.toBeNull();
    expect(free!).toBeGreaterThan(0);
  });

  it("getDiskFreeBytes returns null for a nonexistent path", async () => {
    const free = await getDiskFreeBytes(
      join(tmpdir(), "sym-gc-statfs-does-not-exist-" + Date.now()),
    );
    expect(free).toBeNull();
  });

  it("ensureWorkspace ignores a non-fired disk-pressure check (free space well above threshold)", async () => {
    // Smoke test the safeguard plumbing — on a normal dev machine /tmp has
    // GBs free, so the threshold check won't fire; we still want to be
    // sure that passing diskPressure doesn't change the happy-path
    // behavior or prematurely delete other workspaces.
    const root = freshRoot();
    makeWorkspace(root, "OTHER-1", 0);
    const ws = await ensureWorkspace({
      workspaceRoot: root,
      identifier: "NEW-1",
      diskPressure: {
        runningKeys: new Set(),
        claimedKeys: new Set(),
        beforeRemoveScript: null,
        hookTimeoutMs: 1_000,
      },
    });
    expect(ws.workspaceKey).toBe("NEW-1");
    expect(() => statSync(join(root, "NEW-1"))).not.toThrow();
    expect(() => statSync(join(root, "OTHER-1"))).not.toThrow();
  });

  it("DISK_PRESSURE_FREE_BYTES is the documented 100 MB threshold", () => {
    expect(DISK_PRESSURE_FREE_BYTES).toBe(100 * 1024 * 1024);
  });
});
