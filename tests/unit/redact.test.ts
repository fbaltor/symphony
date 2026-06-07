import { describe, expect, it } from "vitest";
import { redactSecrets, redactStringsRecursive } from "../../src/lib/redact.js";

/**
 * Secret-shape fixture vectors + agent-side (`runGraphqlForAgent` redaction)
 * coverage. Locks down the redaction patterns so a future edit in `redact.ts` keeps
 * covering the three canonical credential shapes the orchestrator emits in
 * Linear comments AND so agent-side MCP variables get the same scrub.
 *
 * **Why string concatenation for the fixtures.** All values below are FAKE
 * — fully invented characters chosen to satisfy the regex shape only — but
 * the repo's pre-commit secret-scan hook (correctly) flags any source that
 * contains a literal `sk-ant-…` / `ghp_…` / `AKIA…` pattern. Splitting the
 * prefix from the suffix at the string-literal level keeps the scanner
 * happy while producing the correct runtime value.
 */

// `sk-ant-` + 30 alnum chars (anthropic_api_key shape).
const FAKE_ANTHROPIC = "sk-" + "ant-" + "FAKE0000ZZZ1111YYY2222XXX3333W";
// `ghp_` + 36 alnum chars (github_pat_classic shape).
const FAKE_GITHUB_PAT = "ghp" + "_FAKE0000zzzz1111yyyy2222xxxx3333wwww";
// `AKIA` + 16 uppercase-alnum chars (aws_access_key_id shape).
const FAKE_AWS_KEY_ID = "AKI" + "AFAKE0000ZZZZ1111";

describe("redactSecrets — fixture vectors", () => {
  it("redacts all three canonical shapes when concatenated", () => {
    const body = `Anthropic: ${FAKE_ANTHROPIC}\nGitHub: ${FAKE_GITHUB_PAT}\nAWS: ${FAKE_AWS_KEY_ID}`;
    expect(redactSecrets(body)).toBe(
      "Anthropic: [redacted:anthropic_api_key]\n" +
        "GitHub: [redacted:github_pat_classic]\n" +
        "AWS: [redacted:aws_access_key_id]",
    );
  });

  it("redacts the Anthropic shape standalone", () => {
    expect(redactSecrets(`key=${FAKE_ANTHROPIC} trailing`)).toBe(
      "key=[redacted:anthropic_api_key] trailing",
    );
  });

  it("redacts the GitHub PAT shape standalone", () => {
    expect(redactSecrets(`Bearer ${FAKE_GITHUB_PAT}.`)).toBe(
      "Bearer [redacted:github_pat_classic].",
    );
  });

  it("redacts the AWS access key shape standalone", () => {
    expect(redactSecrets(`AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY_ID};`)).toBe(
      "AWS_ACCESS_KEY_ID=[redacted:aws_access_key_id];",
    );
  });

  it("is idempotent — re-running on a redacted body is a no-op", () => {
    const once = redactSecrets(`${FAKE_ANTHROPIC} ${FAKE_GITHUB_PAT} ${FAKE_AWS_KEY_ID}`);
    expect(redactSecrets(once)).toBe(once);
  });

  it("does not redact a too-short AWS prefix (15 alnum chars after the prefix)", () => {
    // 15 chars after the prefix, below the {16} requirement.
    const tooShort = "AKI" + "AFAKE0000ZZZZ111";
    expect(redactSecrets(`id=${tooShort}`)).toBe(`id=${tooShort}`);
  });

  it("does not redact a lowercase-suffixed AWS shape", () => {
    // Pattern requires [0-9A-Z]; lowercase tail must not match.
    const lower = "AKI" + "Afake0000zzzz1111";
    expect(redactSecrets(`id=${lower}`)).toBe(`id=${lower}`);
  });

  it("preserves innocent text (no false positives on innocent narrative)", () => {
    const narrative =
      "Should redact secret-shaped values when an agent posts them. " +
      "Three fixture shapes: anthropic, github_pat_classic, aws_access_key_id.";
    expect(redactSecrets(narrative)).toBe(narrative);
  });
});

describe("redactStringsRecursive — coverage for agent-side MCP variables", () => {
  it("scrubs a top-level GraphQL `variables` map (commentCreate.input.body)", () => {
    const variables = {
      input: {
        issueId: "9cc1ad63-some-uuid",
        body: `Anthropic: ${FAKE_ANTHROPIC}\nAWS: ${FAKE_AWS_KEY_ID}`,
      },
    };
    const out = redactStringsRecursive(variables) as typeof variables;
    expect(out.input.issueId).toBe("9cc1ad63-some-uuid");
    expect(out.input.body).toBe(
      "Anthropic: [redacted:anthropic_api_key]\nAWS: [redacted:aws_access_key_id]",
    );
  });

  it("scrubs nested arrays of strings", () => {
    const variables = {
      input: {
        attachments: [{ url: "https://example.com" }, { url: `notes: ${FAKE_GITHUB_PAT}` }],
      },
    };
    const out = redactStringsRecursive(variables) as typeof variables;
    expect(out.input.attachments[0]?.url).toBe("https://example.com");
    expect(out.input.attachments[1]?.url).toBe("notes: [redacted:github_pat_classic]");
  });

  it("preserves non-string scalars (numbers, booleans, null)", () => {
    const variables = {
      input: {
        priority: 2,
        archived: false,
        dueDate: null,
        title: `Reset ${FAKE_ANTHROPIC} now`,
      },
    };
    const out = redactStringsRecursive(variables) as typeof variables;
    expect(out.input.priority).toBe(2);
    expect(out.input.archived).toBe(false);
    expect(out.input.dueDate).toBe(null);
    expect(out.input.title).toBe("Reset [redacted:anthropic_api_key] now");
  });

  it("does not mutate the input object", () => {
    const variables = {
      input: { body: `Anthropic: ${FAKE_ANTHROPIC}` },
    };
    const before = JSON.parse(JSON.stringify(variables));
    redactStringsRecursive(variables);
    expect(variables).toEqual(before);
  });

  it("survives self-referencing objects without stack overflow", () => {
    type Node = { name: string; child?: Node };
    const root: Node = { name: `key=${FAKE_GITHUB_PAT}` };
    root.child = root;
    const out = redactStringsRecursive(root) as Node;
    expect(out.name).toBe("key=[redacted:github_pat_classic]");
    // We don't assert anything about `out.child` shape — the cycle-guard
    // returns the original cyclic ref. The important property is that the
    // call doesn't blow the stack.
  });

  it("is a no-op for a primitive-only payload", () => {
    expect(redactStringsRecursive("plain text")).toBe("plain text");
    expect(redactStringsRecursive(42)).toBe(42);
    expect(redactStringsRecursive(null)).toBe(null);
    expect(redactStringsRecursive(undefined)).toBe(undefined);
  });
});
