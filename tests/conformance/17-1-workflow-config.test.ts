import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflow, WorkflowError } from "../../src/workflow/loader.js";
import { resolveConfig, expandEnvAndHome } from "../../src/workflow/config.js";

/**
 * Spec §17.1 — Workflow and Config Parsing.
 */

describe("§17.1 workflow and config parsing", () => {
  it("treats files with no front matter as pure prompt body", () => {
    const r = parseWorkflow("# Hello\n\nSome prompt.");
    expect(r.config).toEqual({});
    expect(r.promptTemplate).toContain("# Hello");
  });

  it("splits front matter and body when delimited by ---", () => {
    const r = parseWorkflow("---\nfoo: 1\n---\nBody here");
    expect(r.config).toEqual({ foo: 1 });
    expect(r.promptTemplate).toBe("Body here");
  });

  it("throws workflow_front_matter_not_a_map on non-object front matter", () => {
    expect(() => parseWorkflow("---\n- one\n- two\n---\nBody")).toThrow(WorkflowError);
  });

  it("throws workflow_parse_error on invalid YAML", () => {
    expect(() => parseWorkflow("---\nfoo: : :\n---\nBody")).toThrow(WorkflowError);
  });

  it("throws workflow_parse_error when front matter is unterminated", () => {
    expect(() => parseWorkflow("---\nfoo: 1\nno closing")).toThrow(/never closes/);
  });

  it("expands $VAR via expandEnvAndHome", () => {
    expect(expandEnvAndHome("$FOO", { FOO: "bar" })).toBe("bar");
    expect(expandEnvAndHome("/x/$FOO/y", { FOO: "bar" })).toBe("/x/bar/y");
  });

  it("expands ~ to homedir", () => {
    const out = expandEnvAndHome("~/work", {});
    expect(out.startsWith("/")).toBe(true);
    expect(out.endsWith("/work")).toBe(true);
  });

  it("applies defaults and resolves config end-to-end", () => {
    const raw = parseWorkflow(
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: my-proj",
        "---",
        "Hello {{ issue.identifier }}",
      ].join("\n"),
    );
    const cfg = resolveConfig(raw, {
      workflowPath: pathJoin(mkdtempSync(`${tmpdir()}/sym-`), "WORKFLOW.md"),
      env: { LINEAR_API_KEY: "lin_xxx" } as NodeJS.ProcessEnv,
    });
    expect(cfg.tracker.apiKey).toBe("lin_xxx");
    expect(cfg.polling.intervalMs).toBe(30_000);
    expect(cfg.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(cfg.codex.command).toBe("codex app-server");
    expect(cfg.guardrails.dailyCapUsd).toBe(250);
  });

  it("normalizes per-state concurrency map keys to lowercase and rejects non-positive", () => {
    const raw = parseWorkflow(
      [
        "---",
        "tracker: { kind: linear, api_key: x, project_slug: p }",
        "agent: { max_concurrent_agents_by_state: { 'In Progress': 3, Bad: 0 } }",
        "---",
      ].join("\n"),
    );
    const tmp = mkdtempSync(`${tmpdir()}/sym-`);
    const cfg = resolveConfig(raw, {
      workflowPath: pathJoin(tmp, "WORKFLOW.md"),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(cfg.agent.maxConcurrentAgentsByState).toEqual({ "in progress": 3 });
  });

  it("renders the prompt template with strict variables", async () => {
    const { renderPrompt } = await import("../../src/workflow/template.js");
    const out = await renderPrompt("Hello {{ issue.identifier }}", {
      issue: {
        id: "x",
        identifier: "ABC-1",
        title: "t",
        description: null,
        priority: null,
        state: "Todo",
        branchName: null,
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      },
      attempt: null,
    });
    expect(out).toBe("Hello ABC-1");
  });

  it("template render fails on unknown variables", async () => {
    const { renderPrompt, TemplateError } = await import("../../src/workflow/template.js");
    await expect(
      renderPrompt("Hello {{ unknown_var }}", {
        issue: {
          id: "x",
          identifier: "ABC-1",
          title: "t",
          description: null,
          priority: null,
          state: "Todo",
          branchName: null,
          url: null,
          labels: [],
          blockedBy: [],
          createdAt: null,
          updatedAt: null,
        },
        attempt: null,
      }),
    ).rejects.toBeInstanceOf(TemplateError);
  });
});
