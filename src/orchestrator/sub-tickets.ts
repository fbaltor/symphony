/**
 * Sub-ticket parser for the Plan stage.
 *
 * Motivating case ("letter assignee"): the Plan-stage agent
 * correctly identified that the RFC scope required 5 sub-tickets — but
 * symphony had no path to file them. The ticket was manually closed.
 *
 * Contract: when a Plan-stage agent emits an `## RFC` block, it MAY
 * include a trailing `## Sub-tickets` section if the scope is too big
 * for a single PR. The orchestrator's post-Plan hook parses that
 * section, files each sub-ticket via Linear's `issueCreate` mutation
 * with `parentId = current issue id`, and posts a comment on the
 * parent linking the children.
 *
 * The parser is regex-based and intentionally tolerant — we'd rather
 * file 4-out-of-5 sub-tickets and surface the imperfect parse to the
 * human than refuse to file any. Malformed entries are skipped
 * silently (the human still sees the parent comment, can read the
 * RFC, and can file the missing one manually).
 *
 * Format the agent emits:
 *
 *   ## Sub-tickets
 *   1. **{Title}** — {one-line scope}
 *      Depends on: (none|#N)
 *   2. ...
 *
 * Variations we accept:
 *   - "—", "--", "-" as the title/scope separator
 *   - "Depends on:" line is OPTIONAL
 *   - the section header is matched case-insensitively as
 *     "Sub-tickets" / "Sub-Tickets" / "Subtickets" / "Sub tickets"
 *   - bold markers (`**Title**`) are optional
 *   - both ordered (`1.`) and unordered (`-`/`*`) bullets work
 */

export interface ParsedSubTicket {
  /** One-line title, stripped of bold markers and bullet prefix. */
  title: string;
  /** One-line scope after the separator; may be empty. */
  scope: string;
  /**
   * 0-based index into the sibling list this entry depends on, or null
   * if no dependency was declared. We trust the agent's claim; the
   * orchestrator does NOT enforce ordering at file-time. The index is
   * resolved from `Depends on: #N` (1-based in the source, normalized
   * to 0-based here).
   */
  depsOnIndex: number | null;
}

const SECTION_HEADER_RE = /^#{1,6}\s*sub[-\s]?tickets?\s*$/i;
const NEXT_HEADING_RE = /^#{1,6}\s+\S/;
// Accept ordered (`1.`/`1)`) and unordered (`-`/`*`) bullets.
const BULLET_RE = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/;
// Accept any of: " — " (em dash), " -- " (double dash), " - " (single
// dash) as the title/scope separator. The dash forms must be space-padded
// to avoid eating dashes inside a hyphenated title (e.g. "TX-444 follow-up").
const SEPARATOR_RE = /\s(?:—|--|-)\s/;
const DEPENDS_ON_RE = /^\s*(?:>\s*)?depends\s+on\s*:\s*(.+?)\s*$/i;
const DEPENDS_INDEX_RE = /#(\d+)/;

/**
 * Locate the `## Sub-tickets` section inside an RFC body and return the
 * raw lines that belong to it (header excluded; trailing blanks trimmed).
 * Returns null when the section is absent.
 */
function extractSection(rfcBody: string): string[] | null {
  const lines = rfcBody.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_HEADER_RE.test(lines[i] ?? "")) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (NEXT_HEADING_RE.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end);
}

function stripEmphasis(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/_(.+?)_/g, "$1");
}

/**
 * Parse the `## Sub-tickets` section into a list of structured entries.
 * Returns an empty array when the section is missing or contains no
 * recognizable entries — callers treat that as "no decomposition
 * requested" and proceed normally.
 */
export function parseSubTickets(rfcBody: string): ParsedSubTicket[] {
  const section = extractSection(rfcBody);
  if (!section) return [];

  const out: ParsedSubTicket[] = [];
  let current: { title: string; scope: string; depsOnIndex: number | null } | null = null;

  const flush = (): void => {
    if (!current) return;
    if (current.title.length === 0) {
      current = null;
      return;
    }
    out.push({ ...current });
    current = null;
  };

  for (const rawLine of section) {
    const line = rawLine ?? "";
    const bullet = line.match(BULLET_RE);
    if (bullet) {
      flush();
      const body = (bullet[1] ?? "").trim();
      const sepMatch = body.match(SEPARATOR_RE);
      let title: string;
      let scope: string;
      if (sepMatch && sepMatch.index !== undefined) {
        title = body.slice(0, sepMatch.index).trim();
        scope = body.slice(sepMatch.index + sepMatch[0].length).trim();
      } else {
        title = body;
        scope = "";
      }
      title = stripEmphasis(title).trim();
      scope = stripEmphasis(scope).trim();
      current = { title, scope, depsOnIndex: null };
      continue;
    }
    const dep = line.match(DEPENDS_ON_RE);
    if (dep && current) {
      const claim = (dep[1] ?? "").trim();
      if (/^(none|n\/a|-)$/i.test(claim)) {
        current.depsOnIndex = null;
      } else {
        const idxMatch = claim.match(DEPENDS_INDEX_RE);
        if (idxMatch && idxMatch[1]) {
          const oneBased = Number.parseInt(idxMatch[1], 10);
          if (Number.isFinite(oneBased) && oneBased >= 1) {
            current.depsOnIndex = oneBased - 1;
          }
        }
      }
      continue;
    }
    // Continuation line for a current entry — append to scope so a
    // multi-line scope stays attached.
    if (current && line.trim().length > 0 && !line.trim().startsWith(">")) {
      const trimmed = line.trim();
      current.scope = current.scope ? `${current.scope} ${trimmed}` : trimmed;
    }
  }
  flush();

  return out.filter((e) => e.title.length > 0);
}

/**
 * The marker that opts a ticket out of the
 * deliverable_missing guard. Must match `NO_PR_REQUIRED_MARKER_RE` in
 * `orchestrator.ts` exactly so the gate's regex finds it.
 */
const NO_PR_REQUIRED_MARKER = "<!-- symphony:no-pr-required -->";

/**
 * Heuristic for "this looks like a behavioural-probe ticket whose
 * deliverable is a Linear comment, not a PR". When the parent matches,
 * we propagate the marker to children automatically — saves the
 * operator from re-typing it on every probe sub-ticket and prevents
 * the deliverable-gate loop from reappearing on test-shaped sub-tickets.
 *
 * Two signals:
 *   1. Explicit: parent body already contains the marker.
 *   2. Implicit: parent title starts with `[TEST]` or `[PROBE]` —
 *      these are the documented prefixes for validation tickets per
 *      `docs/TEST_TICKETS.md`.
 *
 * Anything else: don't inject. The default-deny side errs toward
 * "let the deliverable_missing guard run normally" rather than
 * accidentally exempting real Implement tickets from the PR
 * requirement.
 */
const PROBE_TITLE_RE = /^\s*\[(TEST|PROBE)\b/i;

export function shouldInjectNoPrRequiredMarker(parent: {
  title: string;
  description: string | null;
}): boolean {
  if (parent.description?.includes("symphony:no-pr-required") ?? false) return true;
  if (PROBE_TITLE_RE.test(parent.title)) return true;
  return false;
}

/**
 * Render the description body for a child ticket. Format is intentionally
 * minimal so the human (or a downstream Refinement-stage agent) can flesh
 * it out — the parent's RFC is the canonical source of truth.
 *
 * When `noPrRequired` is true, the body trails with
 * `<!-- symphony:no-pr-required -->` so the deliverable-gate skips the
 * branch check on the child too. See `shouldInjectNoPrRequiredMarker`
 * above for when callers set this flag.
 */
export function renderChildDescription(args: {
  parentIdentifier: string;
  scope: string;
  depsOnTitle: string | null;
  noPrRequired?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(
    `_Sub-ticket of **${args.parentIdentifier}** — filed by Symphony from the parent RFC._`,
  );
  lines.push("");
  if (args.scope) {
    lines.push("## Scope");
    lines.push("");
    lines.push(args.scope);
    lines.push("");
  }
  if (args.depsOnTitle) {
    lines.push(`> **Depends on:** ${args.depsOnTitle}`);
    lines.push("");
  }
  lines.push(`_See ${args.parentIdentifier} for the full RFC and acceptance criteria._`);
  if (args.noPrRequired) {
    lines.push("");
    lines.push(NO_PR_REQUIRED_MARKER);
  }
  return lines.join("\n");
}
