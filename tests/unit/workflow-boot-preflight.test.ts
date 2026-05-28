import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowWatcher } from "../../src/workflow/watch.js";
import { WorkflowError } from "../../src/workflow/loader.js";

/**
 * Regression suite for the boot-time preflight wiring.
 *
 * Pre-this-PR `WorkflowWatcher.start` Zod-parsed the config but did NOT
 * run `preflightValidate`. A config with `slack.channel_id: $UNSET_VAR`
 * (literal env-token that survived expansion when SLACK_CHANNEL_ID was
 * unset) would boot successfully — Symphony then tried to post to a
 * literal "$SLACK_CHANNEL_ID" channel and Slack 404'd.
 *
 * Now `start()` calls `preflightValidate` after resolveConfig and throws
 * `WorkflowError("workflow_parse_error", ...)` on failure, identical to
 * the on-disk reload path. Cloud Run's startup probe sees the boot fail
 * with a clear log line instead of "/health 503 forever".
 */

const VALID_WORKFLOW_MD = `---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: lin_api_real_key
  team_id: real-team
  active_states: [Plan]
  terminal_states: [Done, Canceled]
  state_transitions: {}
codex:
  command: codex
slack:
  enabled: false
agent_runtime:
  runtime: claude
github:
  owner: example-org
  repo: example-repo
---
# prompt body
`;

const BAD_SLACK_WORKFLOW_MD = `---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: lin_api_real_key
  team_id: real-team
  active_states: [Plan]
  terminal_states: [Done, Canceled]
  state_transitions: {}
codex:
  command: codex
slack:
  enabled: true
  channel_id: $SLACK_CHANNEL_ID
agent_runtime:
  runtime: claude
github:
  owner: example-org
  repo: example-repo
---
# prompt body
`;

describe("WorkflowWatcher.start — boot-time preflight (Task 5)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "symphony-watch-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a watcher when preflight passes", async () => {
    const path = join(dir, "WORKFLOW.md");
    await writeFile(path, VALID_WORKFLOW_MD, "utf8");
    // Empty env — slack.channelId isn't required (slack.enabled=false in fixture).
    const watcher = await WorkflowWatcher.start(path, {});
    expect(watcher).toBeDefined();
    const snap = watcher.snapshot();
    expect(snap.config.tracker.kind).toBe("linear");
    expect(snap.config.tracker.teamId).toBe("real-team");
    watcher.stop();
  });

  it("throws WorkflowError when preflight fails (unresolved $SLACK_CHANNEL_ID)", async () => {
    const path = join(dir, "WORKFLOW.md");
    await writeFile(path, BAD_SLACK_WORKFLOW_MD, "utf8");
    // Don't set SLACK_CHANNEL_ID in env — `$SLACK_CHANNEL_ID` survives expansion
    // and preflight should reject the literal token.
    await expect(WorkflowWatcher.start(path, {})).rejects.toThrowError(WorkflowError);
    // Also verify the error code + message shape so a future maintainer
    // can tell what failed at a glance.
    let caught: WorkflowError | null = null;
    try {
      await WorkflowWatcher.start(path, {});
    } catch (err) {
      caught = err instanceof WorkflowError ? err : null;
    }
    expect(caught).toBeInstanceOf(WorkflowError);
    expect(caught?.code).toBe("workflow_parse_error");
    expect(caught?.message).toMatch(/preflight failed at boot/);
    expect(caught?.message).toMatch(/slack\.channel_id/);
  });

  it("preflight passing with env-resolved channel ID succeeds", async () => {
    const path = join(dir, "WORKFLOW.md");
    await writeFile(path, BAD_SLACK_WORKFLOW_MD, "utf8");
    // Env-resolve the channel ID — preflight should now pass.
    const watcher = await WorkflowWatcher.start(path, { SLACK_CHANNEL_ID: "C0123456789" });
    expect(watcher.snapshot().config.slack.channelId).toBe("C0123456789");
    watcher.stop();
  });
});
