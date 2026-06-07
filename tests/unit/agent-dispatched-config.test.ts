import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../../src/workflow/loader.js";
import { resolveConfig } from "../../src/workflow/config.js";

/**
 * M3 config surface: `tracker.agent_dispatched_states` (snake_case in
 * WORKFLOW.md → camelCase `agentDispatchedStates` after resolve) and the new
 * `agent_runtime.effort: xhigh` option.
 */

function resolve(raw: string) {
  const tmp = mkdtempSync(`${tmpdir()}/sym-`);
  return resolveConfig(parseWorkflow(raw), {
    workflowPath: pathJoin(tmp, "WORKFLOW.md"),
    env: {} as NodeJS.ProcessEnv,
  });
}

describe("agent_dispatched_states", () => {
  it("maps snake_case agent_dispatched_states → tracker.agentDispatchedStates", () => {
    const cfg = resolve(
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: x",
        "  project_slug: p",
        "  agent_dispatched_states:",
        '    - "To implement"',
        "---",
      ].join("\n"),
    );
    expect(cfg.tracker.agentDispatchedStates).toEqual(["To implement"]);
  });

  it("defaults to [] when omitted (back-compat)", () => {
    const cfg = resolve(
      ["---", "tracker: { kind: linear, api_key: x, project_slug: p }", "---"].join("\n"),
    );
    expect(cfg.tracker.agentDispatchedStates).toEqual([]);
  });
});

describe("agent_runtime.effort", () => {
  it("accepts xhigh (Opus 4.7/4.8 effort level)", () => {
    const cfg = resolve(
      [
        "---",
        "tracker: { kind: linear, api_key: x, project_slug: p }",
        "agent_runtime: { runtime: claude, model: claude-opus-4-8, effort: xhigh }",
        "---",
      ].join("\n"),
    );
    expect(cfg.agentRuntime.effort).toBe("xhigh");
  });

  it("rejects an unknown effort level", () => {
    expect(() =>
      resolve(
        [
          "---",
          "tracker: { kind: linear, api_key: x, project_slug: p }",
          "agent_runtime: { runtime: claude, effort: turbo }",
          "---",
        ].join("\n"),
      ),
    ).toThrow();
  });
});
