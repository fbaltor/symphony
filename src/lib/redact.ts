/**
 * Secret-redaction for Linear-bound free-text payloads.
 *
 * The orchestrator posts comments + creates issues with content that may
 * include arbitrary text the agent surfaced — error messages, command
 * output, file contents. A determined or careless agent could blast a
 * SLACK_BOT_TOKEN or ANTHROPIC_API_KEY into a Linear comment. This module
 * scrubs known-shape secrets BEFORE the body hits Linear.
 *
 * **Coverage is best-effort.** Canary patterns drift; new providers
 * surface new key formats. A regex miss here is not a hard guarantee
 * failure — but the orchestrator's audit log will still record the
 * attempted post (post-redaction), and a separate canary-leak detector
 * (future work) can run against `symphony.run_audit` rows for residue.
 *
 * For each match, we replace the secret with `[redacted:<kind>]` so a
 * downstream observer can see WHICH secret leaked without seeing the
 * value. The kind labels are stable; consumers can grep for them.
 */

interface SecretPattern {
  /** Stable identifier emitted as `[redacted:<kind>]`. */
  kind: string;
  /** Match the secret. MUST be a global regex so `.replace` walks the whole string. */
  pattern: RegExp;
}

/**
 * Patterns matched in this order. Order matters when one pattern would
 * match a substring of another (e.g. JWT vs Anthropic key — the Anthropic
 * key is more specific so it runs first).
 */
const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  { kind: "anthropic_api_key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "anthropic_admin_key", pattern: /sk-ant-admin01-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack_bot_token", pattern: /xoxb-[A-Za-z0-9-]{10,}/g },
  { kind: "slack_user_token", pattern: /xoxp-[A-Za-z0-9-]{10,}/g },
  { kind: "github_pat_classic", pattern: /\bghp_[A-Za-z0-9]{36,255}\b/g },
  { kind: "github_pat_finegrained", pattern: /\bgithub_pat_[A-Za-z0-9_]{36,}\b/g },
  { kind: "github_oauth", pattern: /\bgho_[A-Za-z0-9]{36,255}\b/g },
  { kind: "linear_api_key", pattern: /\blin_api_[A-Za-z0-9]{20,}\b/g },
  { kind: "linear_oauth", pattern: /\blin_oauth_[A-Za-z0-9]{20,}\b/g },
  { kind: "gitlab_pat", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "aws_access_key_id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "notion_token", pattern: /\b(?:secret_|ntn_)[A-Za-z0-9]{40,}\b/g },
  { kind: "sentry_auth_token", pattern: /\bsntrys?_[A-Za-z0-9_-]{20,}\b/g },
  // PEM private keys (multi-line). Anchors on header + footer.
  {
    kind: "pem_private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // JWTs (3-segment base64url, e.g. GitHub App tokens, Anthropic admin
  // bearers in some flows). High false-positive risk — kept LAST so more
  // specific patterns above pre-empt it.
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
];

/**
 * Replace every known-shape secret in `text` with `[redacted:<kind>]`. Runs
 * the patterns in order. Idempotent — already-redacted strings pass through
 * unchanged because the placeholder doesn't match any pattern.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { kind, pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, `[redacted:${kind}]`);
  }
  return out;
}

/**
 * Walk an arbitrarily-nested JSON-shaped value and apply `redactSecrets` to
 * every string. Non-string scalars (numbers, booleans, null) pass through
 * unchanged. Arrays and plain objects are walked recursively. Returns a new
 * value — the input is never mutated.
 *
 * Used by `LinearTrackerClient.runGraphqlForAgent` to scrub agent-side
 * GraphQL `variables` payloads (e.g. `commentCreate.input.body`,
 * `issueCreate.input.description`) at the outbound MCP boundary. Without
 * this, the per-string redactor in `createComment` only covers
 * orchestrator-emitted posts; agent-side posts via the `linear_graphql`
 * MCP would forward the literal credential to Linear — a real agent-side
 * leak surfaced this gap. See docs/adr/0016.
 *
 * Cycle-safe via a `WeakSet` guard. Non-cyclic inputs from JSON-deserialized
 * GraphQL variables won't trigger it; the guard exists to prevent stack
 * overflow if a future caller passes a self-referencing object by accident.
 */
export function redactStringsRecursive<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") {
    return redactSecrets(value) as unknown as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => redactStringsRecursive(item, seen)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactStringsRecursive(v, seen);
  }
  return out as unknown as T;
}

/**
 * Test-only — exposed so a unit test can iterate. Production code should
 * call `redactSecrets` directly.
 */
export function _patternsForTesting(): ReadonlyArray<SecretPattern> {
  return SECRET_PATTERNS;
}
