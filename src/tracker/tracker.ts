import type { Issue } from "../types.js";

/**
 * Core tracker interface. Implement this to connect Symphony to any issue
 * tracker (Linear, Jira, GitHub Issues, etc.).
 *
 * The built-in implementation is `LinearTrackerClient` in `./linear.ts`.
 * Register your implementation in `main.ts` by constructing it and passing
 * it to `new Orchestrator({ tracker, ... })`.
 */

export interface ChildIssue {
  id: string;
  identifier: string;
  title: string;
  state: string;
  description: string | null;
  url: string | null;
}

export interface TrackerComment {
  createdAt: string;
  body: string;
  author: string;
}

export interface IssueTracker {
  // --- polling ---

  /** Return all issues in the given active states (used by the dispatch loop). */
  fetchCandidateIssues(activeStates: string[]): Promise<Issue[]>;

  /** Return minimal issue stubs (id + identifier + state) for the given states. Used at boot for workspace GC. */
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;

  /** Refresh the state field for a batch of known issue IDs. Used by reconciliation. */
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;

  /** Fetch the current description of a single issue. Returns null on not-found. */
  fetchIssueDescriptionById(id: string): Promise<string | null>;

  // --- comments ---

  /** Fetch the most recent `first` comments on an issue, oldest-first. */
  fetchIssueComments(issueId: string, first?: number): Promise<TrackerComment[]>;

  /**
   * Like `fetchIssueComments` but pre-filtered to substantive entries only
   * (strips lifecycle-telemetry comments the orchestrator posted itself).
   */
  fetchSubstantiveComments(
    issueId: string,
    opts?: { fetchLimit?: number; substantiveLimit?: number; bodyMaxChars?: number },
  ): Promise<TrackerComment[]>;

  // --- mutations ---

  /** Post a comment on an issue. Non-fatal at call sites — callers .catch + log. */
  createComment(issueId: string, body: string): Promise<{ id: string; url: string } | null>;

  /** Move an issue to a named state. Throws on state-not-found or API failure. */
  transitionIssueToState(
    issueId: string,
    stateName: string,
  ): Promise<{ identifier: string; state: string }>;

  // --- hierarchy ---

  /** Return all direct children of a parent issue. Used by cascade modules. */
  fetchChildIssues(parentId: string): Promise<ChildIssue[]>;

  // --- sub-ticketing extensions ---
  //
  // The orchestrator's post-Plan sub-ticket fan-out and the technical-plan
  // re-plan path call these through the `IssueTracker` type. They were
  // originally Linear-specific (hence the `linear_*` error codes in
  // `LinearTrackerClient`), but lifting them here lets an alternate tracker
  // (e.g. the in-memory `MemoryTracker`) drive the same decomposition flow.

  /**
   * Create a child issue under `parentId`, inheriting the parent's team and
   * (via `labelIds`) its label taxonomy. `priority` mirrors the tracker's
   * enum; pass null/undefined for the team default. Throws on failure.
   */
  createIssue(args: {
    teamId: string;
    title: string;
    description: string;
    parentId?: string | null;
    priority?: number | null;
    labelIds?: readonly string[];
  }): Promise<{ id: string; identifier: string; url: string }>;

  /**
   * Resolve normalized (lowercase) label names into tracker label ids so a
   * sub-ticket inherits its parent's taxonomy. Unknown names are skipped;
   * returns an empty array when there's nothing to resolve.
   */
  resolveLabelIds(lowercaseNames: readonly string[]): Promise<string[]>;

  /** Expose the configured team id so callers can pass it to `createIssue`. Null when unset. */
  getTeamId(): string | null;

  /** Soft-archive an issue (re-plan path). Throws on failure. */
  archiveIssue(issueId: string): Promise<void>;

  /** Update an issue's description in-place (re-plan path). Throws on failure. */
  updateIssueDescription(issueId: string, description: string): Promise<void>;

  // --- bot identity ---

  /**
   * Resolve the tracker user-id for the configured API key. Used by the
   * reconciler to distinguish bot-driven state moves from human moves.
   * Returns null on failure; reconciler falls back to legacy revert behavior.
   */
  fetchViewerId(): Promise<string | null>;

  /** Synchronous cached read of the viewer ID resolved by `fetchViewerId()`. */
  getViewerId(): string | null;

  // --- cache ---

  /**
   * Invalidate any cached workflow-state lookups. Called on WORKFLOW.md reload
   * so newly added states are picked up without restarting the daemon.
   */
  invalidateTeamStatesCache(): void;
}
