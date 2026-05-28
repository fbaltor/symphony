import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureWorkspace,
  WorkspaceSafetyError,
  assertContained,
} from "../../src/workspace/manager.js";
import { runHook } from "../../src/workspace/hooks.js";
import { runEmergencyGc } from "../../src/workspace/cleanup.js";

/**
 * Spec §17.2 — Workspace Manager and Safety.
 */

function freshRoot(): string {
  return mkdtempSync(`${tmpdir()}/sym-ws-`);
}

describe("§17.2 workspace manager", () => {
  it("computes deterministic workspace path per identifier", async () => {
    const root = freshRoot();
    const a = await ensureWorkspace({ workspaceRoot: root, identifier: "ABC-1" });
    const b = await ensureWorkspace({ workspaceRoot: root, identifier: "ABC-1" });
    expect(a.path).toBe(b.path);
    expect(a.workspaceKey).toBe("ABC-1");
  });

  it("creates a missing workspace directory and reuses an existing one", async () => {
    const root = freshRoot();
    const first = await ensureWorkspace({ workspaceRoot: root, identifier: "ABC-2" });
    expect(first.createdNow).toBe(true);
    const second = await ensureWorkspace({ workspaceRoot: root, identifier: "ABC-2" });
    expect(second.createdNow).toBe(false);
  });

  it("sanitizes identifier characters outside [A-Za-z0-9._-]", async () => {
    const root = freshRoot();
    const ws = await ensureWorkspace({ workspaceRoot: root, identifier: "ABC/!?-3" });
    expect(ws.workspaceKey).toBe("ABC___-3");
    expect(ws.path.endsWith("ABC___-3")).toBe(true);
  });

  it("refuses a workspace location that exists as a non-directory", async () => {
    const root = freshRoot();
    const collision = join(root, "FILE-COLLISION");
    writeFileSync(collision, "not a dir");
    await expect(
      ensureWorkspace({ workspaceRoot: root, identifier: "FILE-COLLISION" }),
    ).rejects.toBeInstanceOf(WorkspaceSafetyError);
  });

  it("enforces root containment", () => {
    const root = freshRoot();
    expect(() => assertContained(root, root)).not.toThrow();
    expect(() => assertContained(root, join(root, "child"))).not.toThrow();
    expect(() => assertContained(root, "/etc/passwd")).toThrow(WorkspaceSafetyError);
  });

  it("after_run hook failures are logged but ignored", async () => {
    const root = freshRoot();
    const r = await runHook({
      kind: "after_run",
      script: "exit 17",
      cwd: root,
      timeoutMs: 5_000,
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("after_create / before_run hook failures are still surfaced", async () => {
    const root = freshRoot();
    const r = await runHook({
      kind: "after_create",
      script: "exit 1",
      cwd: root,
      timeoutMs: 5_000,
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("hook timeouts are surfaced via timedOut=true", async () => {
    const root = freshRoot();
    const r = await runHook({
      kind: "before_run",
      script: "sleep 5",
      cwd: root,
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("hooks with null script no-op", async () => {
    const root = freshRoot();
    const r = await runHook({ kind: "after_create", script: null, cwd: root, timeoutMs: 1_000 });
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("disk-pressure scenario: emergency GC reclaims unprotected workspaces", async () => {
    // Spec §17.2 disk-pressure path. We can't reliably fill the host
    // filesystem from a test, but we can validate the behavior the
    // safeguard depends on: when emergency GC runs against a populated
    // workspace root, it removes every directory NOT in
    // running/claimed regardless of mtime. If this contract changes, the
    // 100 MB threshold check in `ensureWorkspace` would silently leak
    // disk under sustained load.
    const root = freshRoot();
    mkdirSync(join(root, "RUN-A"), { recursive: true });
    mkdirSync(join(root, "FRESH-B"), { recursive: true });
    mkdirSync(join(root, "OLD-C"), { recursive: true });
    const fiveHoursAgo = (Date.now() - 60 * 60 * 1000 * 5) / 1000;
    utimesSync(join(root, "OLD-C"), fiveHoursAgo, fiveHoursAgo);
    writeFileSync(join(root, "FRESH-B", "marker"), "fresh");

    const removed = await runEmergencyGc({
      workspaceRoot: root,
      runningKeys: new Set(["RUN-A"]),
      claimedKeys: new Set(),
      beforeRemoveScript: null,
      hookTimeoutMs: 1_000,
    });

    expect(removed).toBe(2);
    expect(() => statSync(join(root, "RUN-A"))).not.toThrow();
    expect(() => statSync(join(root, "FRESH-B"))).toThrow();
    expect(() => statSync(join(root, "OLD-C"))).toThrow();
  });
});
