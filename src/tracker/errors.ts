/** Spec §11.4 — typed tracker error categories. */
export type TrackerErrorCode =
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "linear_api_request"
  | "linear_api_status"
  | "linear_graphql_errors"
  | "linear_unknown_payload"
  | "linear_missing_end_cursor"
  // Write-side categories used by the orchestrator-driven Linear writes
  // (createComment / transitionIssueToState). They sit alongside the
  // read-side codes above so call sites can choose to surface or swallow
  // a write outage without touching unrelated branches.
  | "linear_comment_create_failed"
  | "linear_state_not_found"
  | "linear_issue_update_failed"
  | "linear_issue_create_failed"
  | "linear_issue_archive_failed";

export class TrackerError extends Error {
  readonly code: TrackerErrorCode;
  constructor(code: TrackerErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.name = "TrackerError";
  }
}
