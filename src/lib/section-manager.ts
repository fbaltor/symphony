/**
 * Section manager — idempotent edit helper for Linear-issue descriptions.
 *
 * The 16-state pipeline (docs/adr/0010) drives this. Every
 * specialist agent (Prioritized, Technical plan, PR validation, Release)
 * writes its output as a `## <Name>` block in the issue's description. The
 * key requirement is **idempotency**: when a specialist re-runs (e.g., a
 * human re-drags Plan review (manual) → Technical plan), the agent must
 * UPDATE its existing block in-place rather than appending a duplicate.
 *
 * This module owns the parsing + writing of those blocks. It is intentionally
 * conservative — only the names in MANAGED_SECTIONS are touched. Any other
 * heading that looks like `## Something` (e.g., a human-written `## Notes`,
 * or a section copied from an ADR) is preserved verbatim.
 *
 * Heading rules:
 *   - Top-level only: matches `^## <name>` at column 0. Sub-headings
 *     `### Examples` / `#### Foo` inside a section body do NOT terminate it.
 *   - Case-sensitive on the section name. Trailing whitespace on the heading
 *     line is tolerated.
 *   - First match wins. If the issue somehow has duplicate `## Goals` blocks
 *     (because an old agent wrote them before this helper existed), only the
 *     first one is updated; the second is left alone for a human to clean up.
 *
 * Append rule:
 *   - When a managed section doesn't exist yet, it's appended at the end of
 *     the description with a single blank line separator. Insertion order is
 *     not enforced — re-running a specialist that produces multiple sections
 *     keeps them in the order they were first written.
 */

/**
 * Whitelist of section names that specialists may write. Anything outside
 * this list is human-owned and never touched by the agent.
 *
 * Extending this list = adding a new managed section. Renames should be
 * added at the bottom (so old descriptions still parse) until a migration
 * sweep updates legacy blocks.
 */
export const MANAGED_SECTIONS = [
  // Prioritized agent (src/agents/prioritized/)
  "Goals",
  "Context",
  "Questions",
  // Technical plan agent (src/agents/technical-plan/) — written into each sub-issue
  "Scope",
  "Files to change",
  "Implementation steps",
  "Tests to pass",
  "Branch",
  "PR title + body",
  "Exit criteria",
  // PR validation agent (src/agents/pr-validation/)
  "PR validation report",
  // Release agent (src/agents/release/)
  "Release report",
  // Error-state escalation block (any specialist that escalates writes this)
  "Error",
] as const;

export type ManagedSection = (typeof MANAGED_SECTIONS)[number];

const MANAGED_LOOKUP = new Set<string>(MANAGED_SECTIONS);

/** Match a top-level `## Name` heading at column 0. Trailing whitespace OK. */
const HEADING_RE = /^## (.+?)\s*$/;

interface ParsedSection {
  name: string;
  /** The heading line text (e.g., `## Goals`). Used to preserve original spacing. */
  heading: string;
  /** Body lines (everything between this heading and the next `## ` or EOS). */
  body: string[];
}

interface ParsedDescription {
  /** Lines BEFORE the first `## ` heading. Preserved verbatim. */
  prelude: string[];
  /** Sections in document order. */
  sections: ParsedSection[];
  /**
   * Detected line ending. Symphony preserves whatever the input used so
   * round-tripping doesn't churn diffs in Linear's edit history.
   */
  newline: "\n" | "\r\n";
}

/**
 * Parse a description into prelude + ordered sections. Lossless: a parse +
 * serialize round-trip produces the original string byte-for-byte (including
 * trailing newlines).
 */
export function parseDescription(description: string): ParsedDescription {
  const newline = description.includes("\r\n") ? "\r\n" : "\n";
  // Split preserving trailing empty lines so trailing newline survives round-trip.
  const lines = description.split(newline);
  const prelude: string[] = [];
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m && line.startsWith("## ")) {
      if (current) sections.push(current);
      const rawName = m[1] ?? "";
      current = { name: rawName, heading: line, body: [] };
      continue;
    }
    if (current) {
      current.body.push(line);
    } else {
      prelude.push(line);
    }
  }
  if (current) sections.push(current);
  return { prelude, sections, newline };
}

/**
 * Serialize a parsed description back to a string. Round-trip-safe.
 */
export function serializeDescription(parsed: ParsedDescription): string {
  const out: string[] = [...parsed.prelude];
  for (const sec of parsed.sections) {
    out.push(sec.heading);
    out.push(...sec.body);
  }
  return out.join(parsed.newline);
}

/**
 * Return the body of the named managed section, or null if absent.
 *
 * Body excludes the heading line itself but includes whatever blank lines
 * the agent wrote inside the section (so trailing whitespace stays a
 * round-trip identity).
 */
export function getSection(description: string, name: ManagedSection): string | null {
  if (!MANAGED_LOOKUP.has(name)) {
    throw new Error(`getSection: "${name}" is not a managed section`);
  }
  const parsed = parseDescription(description);
  const sec = parsed.sections.find((s) => s.name === name);
  if (!sec) return null;
  return sec.body.join(parsed.newline);
}

/**
 * Insert or replace a managed section in the description.
 *
 * If the named section exists: replace its body (heading line preserved
 * verbatim — so a manually-edited `## Goals  ` with extra spaces stays
 * that way).
 *
 * If absent: append a new section at the end. The new heading is canonical
 * `## <name>` (no trailing whitespace) and is preceded by exactly one blank
 * line of separator from the previous content. Trailing newline of the
 * input is preserved.
 *
 * Idempotency: `updateSection(updateSection(d, n, c), n, c) === updateSection(d, n, c)`
 * for the same content `c`. Tested in the unit suite.
 */
export function updateSection(
  description: string,
  name: ManagedSection,
  content: string,
): string {
  if (!MANAGED_LOOKUP.has(name)) {
    throw new Error(`updateSection: "${name}" is not a managed section`);
  }
  const parsed = parseDescription(description);

  // Normalize the new content's line endings to match the description.
  const newBody = content.split(/\r\n|\n/);

  const existing = parsed.sections.find((s) => s.name === name);
  if (existing) {
    existing.body = padBody(newBody);
    return serializeDescription(parsed);
  }

  // Append. Ensure exactly one blank-line separator between the prior
  // content and the new heading. If the prior content already ends with a
  // blank line, don't double it; if it doesn't, insert one.
  const lastLines = parsed.sections.length > 0
    ? parsed.sections[parsed.sections.length - 1]!.body
    : parsed.prelude;
  if (lastLines.length === 0 || lastLines[lastLines.length - 1] !== "") {
    lastLines.push("");
  }
  parsed.sections.push({
    name,
    heading: `## ${name}`,
    body: padBody(newBody),
  });
  return serializeDescription(parsed);
}

/**
 * Remove a managed section. Used on re-plan paths where the human's revised
 * request no longer needs a previously-written sub-detail. Other sections
 * are untouched.
 *
 * Returns the description unchanged when the section doesn't exist.
 */
export function removeSection(description: string, name: ManagedSection): string {
  if (!MANAGED_LOOKUP.has(name)) {
    throw new Error(`removeSection: "${name}" is not a managed section`);
  }
  const parsed = parseDescription(description);
  const idx = parsed.sections.findIndex((s) => s.name === name);
  if (idx === -1) return description;
  parsed.sections.splice(idx, 1);
  return serializeDescription(parsed);
}

/**
 * List all sections (managed and unmanaged) in document order, with their
 * bodies. Used by tests + future tooling that wants to inspect the
 * description structure without re-implementing the parser.
 */
export function listSections(description: string): { name: string; body: string }[] {
  const parsed = parseDescription(description);
  return parsed.sections.map((s) => ({
    name: s.name,
    body: s.body.join(parsed.newline),
  }));
}

/**
 * Section names whose body is allowed to contain a `Decision` line that
 * overrides the orchestrator's default `state_transitions` map. The order
 * here is the search order — the parser scans the description and takes
 * the LAST decision line found across these sections (re-runs override
 * earlier turns).
 *
 * Kept narrow on purpose: only specialist-owned report sections may carry
 * a decision override. A human's `## Notes` cannot redirect routing.
 */
const DECISION_OVERRIDE_SECTIONS: readonly ManagedSection[] = [
  "PR validation report",
  "Release report",
  "Error",
];

/**
 * Lines in this map exactly match what the specialist prompts instruct
 * agents to emit. Keys are case-insensitive substrings of a Decision line
 * (e.g. `Advancing to Done.`); values are the override (or `null` to fall
 * through to the default `state_transitions` lookup).
 *
 * Adding a new override target = add a row here AND update the relevant
 * specialist prompt so the LLM emits the matching string.
 */
const DECISION_LINE_PATTERNS: Array<{ regex: RegExp; override: string | null }> = [
  // Default-path advances: explicit but no override (default state_transitions
  // handles them). Listed first so a specialist that emits "Advancing to..."
  // correctly maps to null instead of a fallthrough mismatch.
  // Tolerant: the LLM tends to say "Advancing to Release." but may also say
  // "Advancing the sub to Release.", "Advancing — to Release.", etc. The
  // anchor is "to Release" / "to Done" prefixed by an "Advanc(e|ing)" verb
  // somewhere on the same line.
  { regex: /\bAdvanc(?:e|ing)\b[^\n]*?\bto\s+Release\b/i, override: null },
  { regex: /\bAdvanc(?:e|ing)\b[^\n]*?\bto\s+Done\b/i, override: null },
  // Bounce path. An LLM-phrasing miss surfaced here: the specialist
  // wrote "bouncing back to Pull request" instead of the spec's terser
  // "Bouncing to Pull request". The "back" word broke a stricter regex.
  // Tolerate any "Bounc(e|ing)" verb followed by "to Pull request" with
  // arbitrary words in between (e.g. "back", "the sub", "this PR").
  { regex: /\bBounc(?:e|ing)\b[^\n]*?\bto\s+Pull\s+request\b/i, override: "Pull request" },
  // Escalate path — same tolerance pattern.
  { regex: /\bEscalat(?:e|ing|ed)\b[^\n]*?\bto\s+Error\s*\(manual\)/i, override: "Error (manual)" },
];

/**
 * Scan the description for the LAST Decision line emitted in any specialist
 * report section, and return the explicit state override it requests (or
 * null when the line is one of the default-path advances).
 *
 * Returns:
 *   - `null` when no Decision line is present, or the latest Decision line
 *     resolves to a default-path advance (the orchestrator should consult
 *     its `state_transitions` map and use that).
 *   - A state name string (e.g. `"Pull request"`, `"Error (manual)"`) when
 *     the latest Decision line names an explicit override target.
 *
 * This is the orchestrator's authoritative override path — the agent can't
 * call `update_issue` to change state directly (the reconciler reverts
 * unauthorized agent moves), so it writes the Decision line into its
 * `## <Report> ` section and the orchestrator routes accordingly.
 *
 * Tie-breaking rule: when multiple Decision lines exist (e.g. a re-run
 * appended a new report section without removing the old one), the LAST
 * Decision line in document order wins. This matches how a specialist's
 * `## <Report>` block is appended fresh on every iteration via
 * `updateSection()` (which replaces in-place when the section already
 * exists, but a stale `## Error` next to a fresh `## PR validation report`
 * could leak through).
 */
export function parseDecisionOverride(description: string): string | null {
  if (!description) return null;
  const parsed = parseDescription(description);

  // Walk sections in document order; remember the last Decision-line match.
  // The Decision line is matched per-line so a section body containing
  // unrelated prose with a stray "Advancing" word doesn't false-trip; we
  // only treat lines that match one of the canonical phrases.
  let lastMatch: { override: string | null; matched: boolean } | null = null;

  for (const sec of parsed.sections) {
    if (!DECISION_OVERRIDE_SECTIONS.includes(sec.name as ManagedSection)) continue;

    for (const line of sec.body) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      for (const { regex, override } of DECISION_LINE_PATTERNS) {
        if (regex.test(trimmed)) {
          lastMatch = { override, matched: true };
          break; // one decision per line; move on
        }
      }
    }
  }

  return lastMatch?.matched ? lastMatch.override : null;
}

/**
 * Pad a section body with leading + trailing blank lines so the heading +
 * body have visual separation. Idempotent: a body that already starts/ends
 * with blank lines is not double-padded.
 *
 * Result: `["", "...content...", ""]` shape, which serializes to:
 *   ## Heading
 *   <blank>
 *   ...content...
 *   <blank>
 *   ## Next heading or EOF
 */
function padBody(lines: string[]): string[] {
  let body = [...lines];
  // Trim runs of blank lines at the boundaries to a single blank line.
  while (body.length > 1 && body[0] === "" && body[1] === "") {
    body.shift();
  }
  while (body.length > 1 && body[body.length - 1] === "" && body[body.length - 2] === "") {
    body.pop();
  }
  if (body.length === 0 || body[0] !== "") body.unshift("");
  if (body[body.length - 1] !== "") body.push("");
  return body;
}
