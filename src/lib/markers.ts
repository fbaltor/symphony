/**
 * Shared lifecycle marker constants + formatter for Linear-comment metadata.
 *
 * Symphony posts orchestrator-driven Linear comments with HTML-comment
 * markers like `<!-- symphony:event=dispatch_started state=Plan -->` so the
 * substantive-comment filter (used to seed prompt context for the next
 * dispatch) can drop lifecycle telemetry. The constants and regexes below
 * were duplicated across `tracker/linear.ts` and `orchestrator/reconcile.ts`
 * + `orchestrator.ts`. Centralized here so
 * a future change to the marker format only touches one file.
 */

/** Substring marker for any orchestrator-emitted comment. */
export const SYMPHONY_LIFECYCLE_MARKER_PREFIX = "<!-- symphony:event=";

/**
 * Regex that matches the heading line of a Symphony "turn started"/"turn
 * <outcome>" comment when the comment was posted by an older Symphony
 * version that didn't include the `<!-- symphony:event= -->` marker.
 * Matches forms like:
 *   "🤖 **Symphony — Plan turn started**"
 *   "✅ **Symphony — Implement turn succeeded**"
 */
export const SYMPHONY_TURN_HEADING_RE = /^\s*\S*\s*Symphony\s*[—–-]\s*.+\bturn\b/i;

/**
 * Description-section headings that mark a comment as substantive (i.e.
 * carries deliverables we want the next agent dispatch to read).
 *
 * Update when adding a new managed section.
 */
export const SUBSTANTIVE_HEADINGS: readonly string[] = [
  "## Requirements",
  "## RFC",
  "## RCA",
  "## Implementer's checklist",
];

/**
 * Match a GitHub PR or commit URL anywhere in a comment body. Used by
 * `selectSubstantiveComments` to keep PR/commit-link comments in scope.
 */
export const PR_OR_COMMIT_URL_RE =
  /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|commit)\/[A-Za-z0-9._-]+/i;

/**
 * Build a lifecycle-marker tag for orchestrator-driven Linear comments.
 * Emits `<!-- symphony:event=<event> attr1=v1 attr2=v2 -->`.
 *
 * Values are interpolated as-is (callers should not pass strings with
 * embedded `>` or `--` sequences — the marker is metadata, not user
 * content). Keeps the format stable across emitters so the substring
 * filter in `tracker/linear.ts` and any future `lifecycle-marker.test.ts`
 * can rely on a single canonical shape.
 */
export function formatLifecycleMarker(
  event: string,
  attrs?: Record<string, string | number>,
): string {
  const attrPart = attrs
    ? Object.entries(attrs)
        .map(([k, v]) => ` ${k}=${v}`)
        .join("")
    : "";
  return `<!-- symphony:event=${event}${attrPart} -->`;
}
