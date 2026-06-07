import type { Issue } from "../types.js";
import type { IssueTracker } from "./tracker.js";
import { logger } from "../observability/logger.js";
import {
  PR_OR_COMMIT_URL_RE,
  SUBSTANTIVE_HEADINGS,
  SYMPHONY_LIFECYCLE_MARKER_PREFIX,
  SYMPHONY_TURN_HEADING_RE,
} from "../lib/markers.js";
import { redactSecrets, redactStringsRecursive } from "../lib/redact.js";
import { TrackerError } from "./errors.js";
import { normalizeIssue } from "./normalize.js";

/**
 * Spec §11 — Linear-compatible tracker client.
 *
 * Three required operations:
 *   - fetchCandidateIssues(): issues in active states for the configured project
 *   - fetchIssueStatesByIds(): minimal state refresh for reconciliation
 *   - fetchIssuesByStates(): startup terminal-workspace cleanup
 *
 * Pagination is required (default page size 50, network timeout 30s).
 */

export interface LinearClientOptions {
  endpoint: string;
  apiKey: string;
  /**
   * Linear filter scope. At least one of `projectSlug` or `teamId` MUST be
   * set. When `teamId` is present, the tracker filters by team membership
   * (matching a team-scoped Linear setup, not a project);
   * otherwise it falls back to project filter (the spec's default
   * `tracker.project_slug` semantics).
   */
  projectSlug?: string;
  teamId?: string;
  fetchImpl?: typeof fetch;
  pageSize?: number;
  networkTimeoutMs?: number;
}

interface MinimalIssueNode {
  id: string;
  identifier: string;
  state?: { name?: string | null } | null;
}

interface MinimalIssuePage {
  issues: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: MinimalIssueNode[];
  };
}

function toMinimalIssue(node: MinimalIssueNode): Issue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: "",
    description: null,
    priority: null,
    state: node.state?.name ?? "",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

const ISSUE_FRAGMENT = `
  id
  identifier
  title
  description
  priority
  state { name }
  branchName
  url
  labels { nodes { name } }
  inverseRelations(first: 50) {
    nodes {
      type
      issue { id identifier state { name } }
    }
  }
  createdAt
  updatedAt
`;

// The candidate / terminal queries use a `$scope: IssueFilter!` variable so
// we can swap the filter shape (project vs team) without rewriting the query
// body. The orchestrator builds `scope` once at construction time.

const CANDIDATE_QUERY = /* GraphQL */ `
  query SymphonyCandidates($scope: IssueFilter!, $first: Int!, $after: String) {
    issues(first: $first, after: $after, filter: $scope) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FRAGMENT} }
    }
  }
`;

const TERMINAL_QUERY = /* GraphQL */ `
  query SymphonyTerminals($scope: IssueFilter!, $first: Int!, $after: String) {
    issues(first: $first, after: $after, filter: $scope) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        state {
          name
        }
      }
    }
  }
`;

const REFRESH_QUERY = /* GraphQL */ `
  query SymphonyRefresh($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }, first: 250) {
      nodes {
        id
        identifier
        state {
          name
        }
      }
    }
  }
`;

const CREATE_COMMENT_MUTATION = /* GraphQL */ `
  mutation SymphonyCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment {
        id
        url
      }
    }
  }
`;

// Lookup workflow-state ids for a team (used to translate state-name → id when
// the orchestrator wants to autonomously transition an issue forward in the
// pipeline). We cache the team's state map on first call to avoid hammering
// Linear's GraphQL API on every transition.
const TEAM_STATES_QUERY = /* GraphQL */ `
  query SymphonyTeamStates($teamId: String!) {
    team(id: $teamId) {
      id
      states {
        nodes {
          id
          name
          type
        }
      }
    }
  }
`;

// Lookup label ids for a team (used by sub-ticket filing — to
// translate `parent.labels` (lowercase names from the normalized Issue) into
// Linear-required `labelIds` so children inherit the parent's tag taxonomy).
// Same caching pattern as TEAM_STATES_QUERY; invalidated on WORKFLOW.md reload.
const TEAM_LABELS_QUERY = /* GraphQL */ `
  query SymphonyTeamLabels($teamId: String!) {
    team(id: $teamId) {
      id
      labels(first: 250) {
        nodes {
          id
          name
        }
      }
    }
  }
`;

const FETCH_COMMENTS_QUERY = /* GraphQL */ `
  query SymphonyFetchComments($issueId: String!, $first: Int!) {
    issue(id: $issueId) {
      identifier
      comments(first: $first, orderBy: createdAt) {
        nodes {
          createdAt
          body
          user {
            name
            displayName
          }
        }
      }
    }
  }
`;

const ISSUE_UPDATE_MUTATION = /* GraphQL */ `
  mutation SymphonyIssueUpdate($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue {
        id
        identifier
        state {
          name
        }
      }
    }
  }
`;

// Sub-ticketing: file children under a parent issue. Single $input variable so
// the payload can grow (labels, assignee, project) without a new mutation
// signature; we only need teamId/title/description/parentId/priority today.
const ISSUE_CREATE_MUTATION = /* GraphQL */ `
  mutation SymphonyIssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        url
      }
    }
  }
`;

// list a parent's sub-issues so cascade dispatch can
// fan-out the Development → "To implement (manual)" transition, the
// Cancel cascade, and the Sub-Done watcher.
const FETCH_CHILDREN_QUERY = /* GraphQL */ `
  query SymphonyFetchChildren($parentId: String!, $first: Int!, $after: String) {
    issue(id: $parentId) {
      id
      children(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          identifier
          title
          state { name }
          description
          url
        }
      }
    }
  }
`;

// Re-plan path: archive a sub-issue when the human's revised plan no
// longer needs it. Soft-archive (Linear keeps the issue + its history for
// reference; doesn't delete).
const ISSUE_ARCHIVE_MUTATION = /* GraphQL */ `
  mutation SymphonyIssueArchive($id: String!) {
    issueArchive(id: $id) {
      success
    }
  }
`;

// Re-plan path: update an existing sub-issue's description in-place so
// the section-manager helper can re-run on its existing template without
// duplicating sections.
const ISSUE_UPDATE_DESCRIPTION_MUTATION = /* GraphQL */ `
  mutation SymphonyIssueUpdateDescription($id: String!, $description: String!) {
    issueUpdate(id: $id, input: { description: $description }) {
      success
      issue {
        id
        identifier
      }
    }
  }
`;

export interface TeamState {
  id: string;
  name: string;
  type: string;
}

export class LinearTrackerClient implements IssueTracker {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly scope: Record<string, unknown>;
  private readonly teamId: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;
  private readonly networkTimeoutMs: number;
  private teamStatesCache: Map<string, TeamState> | null = null;
  // cached team labels map (lowercase name → id) for
  // sub-ticket filing. Invalidated alongside teamStatesCache on
  // WORKFLOW.md reload.
  private teamLabelsCache: Map<string, string> | null = null;
  // rate-limited fetchIssueComments failure tracking. We swallow
  // the error per-call so dispatch isn't blocked, but a sustained Linear
  // outage means agents run with no comment history and produce poor work.
  // Track recent failure timestamps; if >= 3 failures land in a 5-min
  // window AND we haven't warned in 5 min, log a warn so operators see it.
  private commentFetchFailureTimestampsMs: number[] = [];
  private commentFetchLastWarnAtMs = 0;
  /**
   * The bot's own Linear user ID, fetched once at
   * boot via `viewer { id }`. The reconciler uses it to distinguish moves
   * the agent made (actor.id === viewerId) from moves a human made
   * (actor.id !== viewerId). Read-only after fetchViewerId() resolves;
   * null until then or on lookup failure (caller treats null as "fail
   * open" — same revert behavior as before this task landed).
   */
  private viewerId: string | null = null;

  constructor(opts: LinearClientOptions) {
    if (!opts.apiKey) throw new TrackerError("missing_tracker_api_key", "tracker.api_key missing");
    if (!opts.projectSlug && !opts.teamId) {
      throw new TrackerError(
        "missing_tracker_project_slug",
        "at least one of tracker.project_slug or tracker.team_id must be set",
      );
    }
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.scope = buildScope(opts);
    this.teamId = opts.teamId ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pageSize = opts.pageSize ?? 50;
    this.networkTimeoutMs = opts.networkTimeoutMs ?? 30_000;
  }

  /**
   * One-shot lookup of the bot's own Linear user
   * ID. Called from `main.ts` boot AFTER the tracker is constructed but
   * BEFORE the orchestrator polls — the reconciler reads `getViewerId()`
   * to decide whether a state move was bot-driven or human-driven.
   *
   * Caching: only SUCCESSFUL lookups are memoized. On failure (network
   * error, Linear 5xx, or `viewer=null` in the response) we log + return
   * null and a subsequent call will retry. This is intentional —
   * memoizing failure would lock in the legacy revert behavior for the
   * lifetime of the process even after Linear recovers, which is worse
   * than a stray retry per orchestrator tick (the boot caller is the
   * dominant call site; retry cost is negligible). Surfaced 2026-05-07
   * by Copilot review.
   *
   * The query uses Linear's `viewer { id }` which returns the user
   * associated with the API key — for a personal API key that's the
   * human owner, for an OAuth Application install that's the
   * application's user record. Either way, this is the actor id we'll
   * see on webhook payloads when Symphony moves an issue.
   */
  async fetchViewerId(): Promise<string | null> {
    if (this.viewerId !== null) return this.viewerId;
    try {
      const data = await this.gql<{ viewer: { id: string } | null }>(
        `query SymphonyViewerLookup { viewer { id } }`,
        {},
      );
      const id = data.viewer?.id ?? null;
      if (id) {
        this.viewerId = id;
      }
      return id;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "fetchViewerId failed; reconciler will fall back to legacy revert behavior",
      );
      return null;
    }
  }

  /**
   * Synchronous accessor for the cached viewer ID. Returns null if
   * `fetchViewerId()` hasn't resolved yet (or failed). Used by the
   * reconciler on every tick — must be O(1).
   */
  getViewerId(): string | null {
    return this.viewerId;
  }

  /**
   * Post a Linear comment (markdown body). The orchestrator uses this to
   * announce dispatch start, turn outcomes, and lifecycle events on the
   * issue's thread — so the board reflects what symphony is doing even
   * when the agent itself doesn't reach for the Linear MCP.
   *
   * Errors are non-fatal at the call site: callers wrap with .catch and
   * log a warning instead of failing the dispatch — Linear write outages
   * shouldn't block agent work.
   */
  async createComment(issueId: string, body: string): Promise<{ id: string; url: string } | null> {
    // Scrub known-shape secrets out of free-text
    // bodies before they hit Linear. An agent that surfaced an
    // ANTHROPIC_API_KEY in command output (`env | head`, etc.) would
    // otherwise post the literal key into a Linear comment indexed by
    // Linear's search.
    const safeBody = redactSecrets(body);
    const data = await this.gql<{
      commentCreate: { success: boolean; comment: { id: string; url: string } | null };
    }>(CREATE_COMMENT_MUTATION, { issueId, body: safeBody });
    if (!data.commentCreate.success || !data.commentCreate.comment) {
      throw new TrackerError(
        "linear_comment_create_failed",
        "Linear commentCreate returned success=false",
      );
    }
    return data.commentCreate.comment;
  }

  /**
   * Create a Linear issue. Used by the orchestrator's post-Plan sub-ticketing
   * hook: when a Plan-stage RFC contains a `## Sub-tickets` section, each
   * entry is filed as a child of the parent (parentId = current issue id),
   * inheriting the same team. Children land in the team's default starting
   * state and re-enter the normal pipeline (Refinement → Plan → ...) so
   * each one gets dispatched independently.
   *
   * `priority` mirrors Linear's enum (0=none, 1=urgent, 2=high, 3=medium,
   * 4=low). Pass null/undefined to inherit the team default.
   *
   * Throws `linear_issue_create_failed` on API success=false; callers
   * are expected to catch + log per-child so a single parser hiccup
   * doesn't lose the rest of the batch.
   */
  async createIssue(args: {
    teamId: string;
    title: string;
    description: string;
    parentId?: string | null;
    priority?: number | null;
    /**
     * Linear label IDs — pass to inherit parent's tag taxonomy on sub-tickets.
     * Use `resolveLabelIds(parent.labels)` to translate normalized lowercase
     * names into IDs.
     */
    labelIds?: readonly string[];
  }): Promise<{ id: string; identifier: string; url: string }> {
    const input: Record<string, unknown> = {
      teamId: args.teamId,
      // scrub secrets from agent-surfaced text before it lands in
      // Linear. createIssue is on the post-Plan sub-ticket fan-out hot
      // path; titles + descriptions are derived from the agent's RFC.
      title: redactSecrets(args.title),
      description: redactSecrets(args.description),
    };
    if (args.parentId) input.parentId = args.parentId;
    if (typeof args.priority === "number") input.priority = args.priority;
    if (args.labelIds && args.labelIds.length > 0) input.labelIds = args.labelIds;
    const data = await this.gql<{
      issueCreate: {
        success: boolean;
        issue: { id: string; identifier: string; url: string } | null;
      };
    }>(ISSUE_CREATE_MUTATION, { input });
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new TrackerError(
        "linear_issue_create_failed",
        `Linear issueCreate returned success=false for "${args.title}"`,
      );
    }
    return data.issueCreate.issue;
  }

  /** Expose the configured team id so callers (sub-ticketing) can pass it to createIssue. */
  getTeamId(): string | null {
    return this.teamId;
  }

  /**
   * Fetch all sub-issues of a parent. Used by cascade
   * dispatch:
   *   - Development cascade: query subs in `Subtask drafted`, transition
   *     each → `To implement (manual)`.
   *   - Cancel cascade: query non-terminal subs, transition each → `Canceled`.
   *   - Sub-Done watcher: query all subs, check if all are in terminal
   *     states (Done / Canceled / Duplicate); if yes, parent → Validation
   *     (manual).
   *   - Re-plan diff: list existing subs to compare against the agent's
   *     proposed new decomposition.
   *
   * Returns each sub as a partial Issue (id, identifier, title, state,
   * description, url). Sub-issues lacking a state name are still returned
   * with state="" so the cascade can detect malformed responses.
   *
   * Errors propagate (no swallowing) — cascade callers MUST decide whether
   * to abort or retry. Linear list errors usually indicate a transient
   * outage; the caller's surrounding tick will re-run on the next poll.
   */
  async fetchChildIssues(parentId: string): Promise<
    Array<{
      id: string;
      identifier: string;
      title: string;
      state: string;
      description: string | null;
      url: string | null;
    }>
  > {
    interface ChildrenQueryNode {
      id: string;
      identifier: string;
      title: string;
      state: { name: string } | null;
      description: string | null;
      url: string | null;
    }
    interface ChildrenQueryResponse {
      issue: {
        id: string;
        children: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ChildrenQueryNode[];
        } | null;
      } | null;
    }
    const out: Array<{
      id: string;
      identifier: string;
      title: string;
      state: string;
      description: string | null;
      url: string | null;
    }> = [];
    let after: string | null = null;
    do {
      const data: ChildrenQueryResponse = await this.gql<ChildrenQueryResponse>(
        FETCH_CHILDREN_QUERY,
        { parentId, first: this.pageSize, after },
      );
      const childrenPage = data.issue?.children;
      if (!childrenPage) {
        // Parent doesn't exist or has no children entry — return empty rather
        // than throw so cascades can no-op safely.
        return out;
      }
      for (const node of childrenPage.nodes) {
        out.push({
          id: node.id,
          identifier: node.identifier,
          title: node.title,
          state: node.state?.name ?? "",
          description: node.description,
          url: node.url,
        });
      }
      if (childrenPage.pageInfo.hasNextPage) {
        if (!childrenPage.pageInfo.endCursor) {
          throw new TrackerError(
            "linear_missing_end_cursor",
            "fetchChildIssues hasNextPage=true but endCursor is null",
          );
        }
        after = childrenPage.pageInfo.endCursor;
      } else {
        after = null;
      }
    } while (after);
    return out;
  }

  /**
   * Soft-archive an issue. Used by the Technical plan agent's re-plan path
   * when the human's revised request no longer needs a previously-
   * filed sub-issue. Archiving preserves the sub's history (so its `## Scope`
   * and any human comments stay readable) but removes it from the team's
   * default views.
   *
   * `success: false` from Linear is converted to a TrackerError; the caller
   * can decide to log + continue (best-effort) or to fail the parent's turn.
   */
  async archiveIssue(issueId: string): Promise<void> {
    const data = await this.gql<{ issueArchive: { success: boolean } }>(
      ISSUE_ARCHIVE_MUTATION,
      { id: issueId },
    );
    if (!data.issueArchive.success) {
      throw new TrackerError(
        "linear_issue_archive_failed",
        `issueArchive returned success=false for issue ${issueId}`,
      );
    }
  }

  /**
   * Update an issue's description in-place. Used by the Technical plan
   * agent's re-plan path to re-write existing sub-issue descriptions
   * via the section-manager helper without duplicating sections.
   *
   * Wraps the new description with `redactSecrets` for the same reason
   * createIssue does (agent-surfaced text → Linear; scrub known-shape
   * secrets first).
   */
  async updateIssueDescription(issueId: string, description: string): Promise<void> {
    const safe = redactSecrets(description);
    const data = await this.gql<{
      issueUpdate: {
        success: boolean;
        issue: { id: string; identifier: string } | null;
      };
    }>(ISSUE_UPDATE_DESCRIPTION_MUTATION, { id: issueId, description: safe });
    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
      throw new TrackerError(
        "linear_issue_update_failed",
        `issueUpdate (description) returned success=false for issue ${issueId}`,
      );
    }
  }

  /**
   * Resolve a state-name (e.g. "Plan", "Code Review") to its workflow-state
   * id on the configured team, then issue a `issueUpdate` mutation. Caches
   * the team's full states map on first call so repeat transitions don't
   * pay the lookup.
   *
   * Throws `linear_state_not_found` if the requested state name doesn't
   * exist on the team — a typo or stale config rather than an outage.
   */
  async transitionIssueToState(
    issueId: string,
    stateName: string,
  ): Promise<{ identifier: string; state: string }> {
    if (!this.teamId) {
      throw new TrackerError(
        "missing_tracker_project_slug",
        "transitionIssueToState requires tracker.team_id",
      );
    }
    const states = await this.getTeamStates();
    // Compare case-insensitively — Linear state names are often inconsistent
    // ("RFC" vs "rfc", "Code Review" vs "code-review").
    const target = [...states.values()].find(
      (s) => s.name.toLowerCase() === stateName.toLowerCase(),
    );
    if (!target) {
      throw new TrackerError(
        "linear_state_not_found",
        `state "${stateName}" not found on team ${this.teamId}; known states: ${[...states.values()].map((s) => s.name).join(", ")}`,
      );
    }
    const data = await this.gql<{
      issueUpdate: {
        success: boolean;
        issue: { id: string; identifier: string; state: { name: string } } | null;
      };
    }>(ISSUE_UPDATE_MUTATION, { id: issueId, stateId: target.id });
    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
      throw new TrackerError(
        "linear_issue_update_failed",
        `issueUpdate returned success=false for issue ${issueId} → state ${stateName}`,
      );
    }
    return {
      identifier: data.issueUpdate.issue.identifier,
      state: data.issueUpdate.issue.state.name,
    };
  }

  /**
   * Fetch the most recent N comments on an issue, oldest-first. Used by the
   * orchestrator to inject prior-stage context (Refinement's `## Requirements`,
   * Plan's `## RFC`, etc.) into the next dispatch's prompt — without this,
   * each stage's agent only sees the issue title + body and re-derives
   * context from scratch every turn.
   *
   * `first` is capped at 50 by Linear's API (and 50 is plenty: a busy
   * team's tickets have ~30 comments end-to-end). Returns the empty
   * array on any failure so the prompt can render without history rather
   * than blocking dispatch on a Linear read outage.
   */
  async fetchIssueComments(
    issueId: string,
    first: number = 25,
  ): Promise<Array<{ createdAt: string; body: string; author: string }>> {
    try {
      const data = await this.gql<{
        issue: {
          identifier: string;
          comments: {
            nodes: Array<{
              createdAt: string;
              body: string;
              user: { name?: string | null; displayName?: string | null } | null;
            }>;
          };
        } | null;
      }>(FETCH_COMMENTS_QUERY, { issueId, first });
      // Successful fetch — clear the rate-limit window so the next failure
      // burst gets a fresh count instead of inheriting stale entries.
      if (this.commentFetchFailureTimestampsMs.length > 0) {
        this.commentFetchFailureTimestampsMs = [];
      }
      if (!data.issue) return [];
      return data.issue.comments.nodes.map((n) => ({
        createdAt: n.createdAt,
        body: n.body,
        author: n.user?.displayName ?? n.user?.name ?? "(unknown)",
      }));
    } catch (err) {
      // Don't block dispatch on a Linear read failure — return empty so
      // the agent at least gets the title + body. The dispatch's
      // orchestrator-driven "turn started" comment will document the
      // missing context.
      this.recordCommentFetchFailure(issueId, err);
      return [];
    }
  }

  /**
   * emit a rate-limited warn after >=3 fetchIssueComments failures
   * inside a 5-minute rolling window, then again at-most every 5 minutes
   * while the burst persists. Operators get visibility on a sustained Linear
   * read outage without log spam from a single transient blip.
   */
  private recordCommentFetchFailure(issueId: string, err: unknown): void {
    const FAILURE_WINDOW_MS = 5 * 60 * 1000;
    const FAILURE_THRESHOLD = 3;
    const WARN_INTERVAL_MS = 5 * 60 * 1000;

    const now = Date.now();
    this.commentFetchFailureTimestampsMs = this.commentFetchFailureTimestampsMs.filter(
      (t) => now - t <= FAILURE_WINDOW_MS,
    );
    this.commentFetchFailureTimestampsMs.push(now);

    if (
      this.commentFetchFailureTimestampsMs.length >= FAILURE_THRESHOLD &&
      now - this.commentFetchLastWarnAtMs >= WARN_INTERVAL_MS
    ) {
      this.commentFetchLastWarnAtMs = now;
      logger.warn(
        {
          issueId,
          err: err instanceof Error ? err.message : String(err),
          failureCount: this.commentFetchFailureTimestampsMs.length,
          windowMs: FAILURE_WINDOW_MS,
        },
        "fetchIssueComments failures sustained — agents are running without comment history",
      );
    }
  }

  /**
   * Fetch + filter prior comments down to the SUBSTANTIVE ones the next
   * dispatch's agent actually needs. Wraps `fetchIssueComments` so existing
   * callers stay untouched.
   *
   * Why: hot-patch #5 (commit `a4f947ee`) injects up to 25 prior comments
   * verbatim into every dispatch's prompt. Multi-stage tickets accumulate
   * ~100 comments over Refinement → Plan → Validate → Implement → Open PR
   * → Reviewed → Test → Deploy → Monitoring → Done. By Implement-stage
   * the prompt token cost grows ~quadratically per dispatch — observed on
   *  at ~$0.30/turn just on comment-history input.
   *
   * The vast majority of those comments are *lifecycle telemetry* the
   * orchestrator itself posts (turn-started/turn-finished, with cost +
   * tokens + wall-time). The agent doesn't need to read its own past
   * footprints to do the next stage; it needs the deliverables (the
   * `## Requirements` / `## RFC` / `## RCA` blocks) and any free-form
   * human reply.
   *
   * Filter rules — see `selectSubstantiveComments` (exported below) for
   * the canonical implementation; this method just plumbs the fetch
   * through it. Bumps the underlying fetch cap to 50 (Linear's max) so
   * the post-filter window has the freshest 5 substantive entries even
   * when there's a long lifecycle-telemetry tail.
   */
  async fetchSubstantiveComments(
    issueId: string,
    opts: { fetchLimit?: number; substantiveLimit?: number; bodyMaxChars?: number } = {},
  ): Promise<Array<{ createdAt: string; body: string; author: string }>> {
    const fetchLimit = opts.fetchLimit ?? 50;
    const all = await this.fetchIssueComments(issueId, fetchLimit);
    return selectSubstantiveComments(all, {
      substantiveLimit: opts.substantiveLimit ?? 5,
      bodyMaxChars: opts.bodyMaxChars ?? 1500,
    });
  }

  /**
   * Invalidate the cached team-states map. Called by the orchestrator on
   * WORKFLOW.md reload so a freshly-added
   * Linear workflow state is picked up without restarting the daemon.
   * Safe to call when no cache is populated.
   */
  invalidateTeamStatesCache(): void {
    this.teamStatesCache = null;
    // invalidate label cache on the same hook so a freshly-added
    // Linear label is picked up by the next sub-ticket file.
    this.teamLabelsCache = null;
  }

  /**
   * Resolve `parent.labels` (lowercase name array from the normalized Issue)
   * into Linear `labelIds` so a sub-ticket inherits its parent's taxonomy
   *. Names that don't exist on the team's label catalog are
   * silently skipped — a typo or stale label shouldn't fail the whole
   * sub-ticket file.
   *
   * Returns an empty array when:
   *   - `lowercaseNames` is empty
   *   - `teamId` isn't configured (sub-ticket filing also no-ops in that case)
   *   - the labels query fails (caller falls back to no labels rather than
   *     blocking ticket creation on a Linear read outage)
   */
  async resolveLabelIds(lowercaseNames: readonly string[]): Promise<string[]> {
    if (lowercaseNames.length === 0 || !this.teamId) return [];
    let labels: Map<string, string>;
    try {
      labels = await this.getTeamLabels();
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of lowercaseNames) {
      const id = labels.get(name);
      if (id) out.push(id);
    }
    return out;
  }

  private async getTeamLabels(): Promise<Map<string, string>> {
    if (this.teamLabelsCache) return this.teamLabelsCache;
    if (!this.teamId) {
      throw new TrackerError(
        "missing_tracker_project_slug",
        "getTeamLabels requires tracker.team_id",
      );
    }
    const data = await this.gql<{
      team: { id: string; labels: { nodes: Array<{ id: string; name: string }> } } | null;
    }>(TEAM_LABELS_QUERY, { teamId: this.teamId });
    if (!data.team) {
      throw new TrackerError(
        "linear_unknown_payload",
        `team ${this.teamId} not found while fetching labels`,
      );
    }
    const map = new Map<string, string>();
    for (const l of data.team.labels.nodes) {
      map.set(l.name.toLowerCase(), l.id);
    }
    this.teamLabelsCache = map;
    return map;
  }

  private async getTeamStates(): Promise<Map<string, TeamState>> {
    if (this.teamStatesCache) return this.teamStatesCache;
    if (!this.teamId) {
      throw new TrackerError(
        "missing_tracker_project_slug",
        "getTeamStates requires tracker.team_id",
      );
    }
    const data = await this.gql<{
      team: { id: string; states: { nodes: TeamState[] } } | null;
    }>(TEAM_STATES_QUERY, { teamId: this.teamId });
    if (!data.team) {
      throw new TrackerError(
        "linear_unknown_payload",
        `team ${this.teamId} not found while fetching states`,
      );
    }
    const map = new Map<string, TeamState>();
    for (const s of data.team.states.nodes) map.set(s.id, s);
    this.teamStatesCache = map;
    return map;
  }

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    return this.paginateIssues(CANDIDATE_QUERY, {
      scope: this.candidateScope(activeStates),
    });
  }

  /**
   * Spec §11.1 — terminal-state cleanup. The tracker query selects only
   * id/identifier/state. We normalize to a minimal Issue (rather than calling
   * the full normalizer, which would leave `title` etc. as undefined and
   * leak through type guarantees).
   */
  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    if (!states.length) return [];
    const out: Issue[] = [];
    let after: string | null = null;
    do {
      const data: MinimalIssuePage = await this.gql<MinimalIssuePage>(TERMINAL_QUERY, {
        scope: this.candidateScope(states),
        first: this.pageSize,
        after,
      });
      const page: MinimalIssuePage["issues"] = data.issues;
      for (const node of page.nodes) out.push(toMinimalIssue(node));
      if (page.pageInfo.hasNextPage) {
        if (!page.pageInfo.endCursor) {
          throw new TrackerError(
            "linear_missing_end_cursor",
            "hasNextPage=true but endCursor is null",
          );
        }
        after = page.pageInfo.endCursor;
      } else {
        after = null;
      }
    } while (after);
    return out;
  }

  /**
   * Fetch a single issue's description (post-agent-write fresh value) so the
   * orchestrator's auto-advance can read the agent's `## <Report>` Decision
   * line via `parseDecisionOverride`.
   *
   * Returns null on 404 / not-found; bubbles other errors. Kept minimal —
   * only `description` is read by the caller, but we ask for `id` too so
   * the response shape matches Linear's GraphQL contract.
   */
  async fetchIssueDescriptionById(id: string): Promise<string | null> {
    const data = await this.gql<{
      issue: { id: string; description: string | null } | null;
    }>(
      /* GraphQL */ `
        query SymphonyFetchDescription($id: String!) {
          issue(id: $id) {
            id
            description
          }
        }
      `,
      { id },
    );
    if (!data.issue) return null;
    return data.issue.description ?? "";
  }

  /**
   * Spec §11.1 — minimal state refresh. Returns Issues with only id,
   * identifier, and state populated; orchestrator only reads `state` from
   * these to decide terminal / non-active transitions.
   *
   * REFRESH_QUERY hard-codes `first: 250` per Linear's filter limit, so we
   * chunk the input id list in batches of that size to avoid silently
   * dropping the tail when reconciliation has many running issues.
   */
  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (!ids.length) return [];
    const REFRESH_BATCH = 250;
    const out: Issue[] = [];
    for (let i = 0; i < ids.length; i += REFRESH_BATCH) {
      const batch = ids.slice(i, i + REFRESH_BATCH);
      const data = await this.gql<{ issues: { nodes: MinimalIssueNode[] } }>(REFRESH_QUERY, {
        ids: batch,
      });
      for (const n of data.issues.nodes) out.push(toMinimalIssue(n));
    }
    return out;
  }

  /* ----------------------------- internals ----------------------------- */

  /** Compose the candidate-fetch IssueFilter with `state.name in [...]`. */
  private candidateScope(states: string[]): Record<string, unknown> {
    return { ...this.scope, state: { name: { in: states } } };
  }

  private async paginateIssues(query: string, baseVars: Record<string, unknown>): Promise<Issue[]> {
    const out: Issue[] = [];
    let after: string | null = null;
    do {
      const vars: Record<string, unknown> = { ...baseVars, first: this.pageSize, after };
      const data = await this.gql<{
        issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] };
      }>(query, vars);
      const page = data.issues;
      if (!page) {
        throw new TrackerError("linear_unknown_payload", "missing issues field in response");
      }
      for (const node of page.nodes)
        out.push(normalizeIssue(node as Parameters<typeof normalizeIssue>[0]));
      if (page.pageInfo.hasNextPage) {
        if (!page.pageInfo.endCursor) {
          throw new TrackerError(
            "linear_missing_end_cursor",
            "hasNextPage=true but endCursor is null",
          );
        }
        after = page.pageInfo.endCursor;
      } else {
        after = null;
      }
    } while (after);
    return out;
  }

  /**
   * Public GraphQL caller — exposed for the in-process `linear_graphql` MCP
   * tool. Spec §10.5 says agents that hold this tool MUST
   * reuse the orchestrator's configured tracker auth rather than reading
   * raw tokens themselves; this method is the canonical surface.
   *
   * Spec §10.5 constraints (enforced here):
   *   - exactly one GraphQL operation per call (Linear's GraphQL endpoint
   *     enforces this; the underlying gqlOnce passes through to Linear
   *     and surfaces validation errors)
   *   - top-level GraphQL `errors[]` returns success=false with the body
   *     preserved (TrackerError code `linear_graphql_errors`)
   *   - transport / 5xx errors get the same retry treatment as internal
   *     callers
   */
  async runGraphqlForAgent<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    // Coverage-gap fix: scrub secret-shaped values from
    // every string field in `variables` before forwarding to Linear's
    // GraphQL endpoint. The orchestrator's own posts go through
    // `LinearTrackerClient.createComment` which already wraps `body`
    // in `redactSecrets` — but agent-side posts via the in-process
    // `linear_graphql` MCP land here directly. Without this, a model
    // that surfaces a credential-shaped string in its output would
    // post it literally to Linear (a real agent-side leak).
    //
    // Walks the variables object recursively so `commentCreate.input.body`,
    // `issueCreate.input.description`, multi-step batch payloads etc. all
    // get scrubbed. Non-string values (numbers, booleans, IDs) pass through
    // unchanged.
    return this.gql<T>(query, redactStringsRecursive(variables) as Record<string, unknown>);
  }

  /**
   * GraphQL caller with retry on transient transport errors.
   *
   * Retries 3 attempts with 100 → 500 → 2000 ms backoff (+ ±20% jitter) on:
   *   - `linear_api_request` — network errors / abort / timeout
   *   - `linear_api_status` with HTTP 5xx — Linear server-side hiccup
   *
   * Does NOT retry on:
   *   - 4xx (client errors: malformed query, auth, missing scope)
   *   - `linear_graphql_errors` (logic errors in the query payload)
   *   - `linear_unknown_payload` (response parse failures)
   *
   * Without this, a single 502 during reconciliation could falsely mark an
   * issue as terminal (state-refresh failure → `keeping workers running`
   * fallback) and slow downstream auto-retries.
   */
  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const MAX_ATTEMPTS = 3;
    const BASE_DELAYS_MS = [100, 500, 2000];
    let lastErr: TrackerError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.gqlOnce<T>(query, variables);
      } catch (err) {
        if (!(err instanceof TrackerError)) throw err;
        if (!isRetryableTrackerError(err) || attempt === MAX_ATTEMPTS) throw err;
        lastErr = err;
        // Apply +/-20% jitter so a thundering herd of retries doesn't all
        // hit Linear at the same wall-clock instant.
        const base = BASE_DELAYS_MS[attempt - 1] ?? 2000;
        const jitter = base * 0.2 * (Math.random() * 2 - 1);
        const delay = Math.max(0, Math.round(base + jitter));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    // Unreachable: the loop either returns or throws, but TS can't see that
    // through the cumulative-throw pattern.
    throw lastErr ?? new TrackerError("linear_unknown_payload", "gql exhausted retries");
  }

  private async gqlOnce<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.networkTimeoutMs);
    let res: Response;
    try {
      // Linear personal API keys (lin_api_*) are passed bare; OAuth tokens /
      // PATs require a `Bearer ` prefix. See Linear docs.
      const auth = this.apiKey.startsWith("lin_api_") ? this.apiKey : `Bearer ${this.apiKey}`;
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: auth,
        },
        body: JSON.stringify({ query, variables }),
        signal: ac.signal,
      });
    } catch (err) {
      throw new TrackerError(
        "linear_api_request",
        `Linear API request failed: ${(err as Error).message}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await safeText(res);
      throw new TrackerError(
        "linear_api_status",
        `Linear API returned status ${res.status}: ${body}`,
      );
    }

    let payload: { data?: T; errors?: unknown[] };
    try {
      payload = (await res.json()) as typeof payload;
    } catch (err) {
      throw new TrackerError(
        "linear_unknown_payload",
        `failed to parse Linear response: ${(err as Error).message}`,
      );
    }

    if (payload.errors && payload.errors.length > 0) {
      throw new TrackerError(
        "linear_graphql_errors",
        `Linear returned GraphQL errors: ${JSON.stringify(payload.errors)}`,
      );
    }
    if (!payload.data) {
      throw new TrackerError("linear_unknown_payload", "Linear response missing 'data' field");
    }
    return payload.data;
  }
}

/**
 * Classifies a TrackerError as retryable for the gql() retry loop.
 * Only transient transport / server errors retry; logic errors propagate
 * immediately so callers see them on the first try.
 */
export function isRetryableTrackerError(err: TrackerError): boolean {
  if (err.code === "linear_api_request") return true;
  if (err.code === "linear_api_status") {
    // Extract the status from the error message ("Linear API returned status 503: ...").
    const m = /returned status (\d{3})/.exec(err.message);
    if (m && m[1]) {
      const status = Number(m[1]);
      return status >= 500 && status < 600;
    }
  }
  return false;
}

/**
 * Build the IssueFilter scope from the configured options. Team filter takes
 * precedence over project filter so an org can use Symphony against a
 * Linear *team* (a team-scoped setup) without having to invent a
 * dedicated Linear project for it.
 */
function buildScope(opts: LinearClientOptions): Record<string, unknown> {
  if (opts.teamId && opts.teamId.length > 0) {
    return { team: { id: { eq: opts.teamId } } };
  }
  if (opts.projectSlug && opts.projectSlug.length > 0) {
    return { project: { slugId: { eq: opts.projectSlug } } };
  }
  // Constructor already validates this, but keep a defensive throw so a future
  // refactor can't silently produce an empty filter (which would scan org-wide).
  throw new TrackerError(
    "missing_tracker_project_slug",
    "buildScope called without project_slug or team_id",
  );
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

export interface SymphonyComment {
  createdAt: string;
  body: string;
  author: string;
}

export interface SelectSubstantiveCommentsOptions {
  /** Max number of substantive comments to keep (most-recent-first). Default 5. */
  substantiveLimit?: number;
  /** Per-comment body cap; longer bodies truncated with a `…[truncated, X chars total]` suffix. Default 1500. */
  bodyMaxChars?: number;
}

// Lifecycle markers + heading constants moved to `src/lib/markers.ts`
// so they're shared with `orchestrator/reconcile.ts` etc.

/**
 * Filter a chronologically-ordered comment list (oldest-first, as
 * `fetchIssueComments` returns) down to the most-recent N substantive
 * entries. See `LinearTrackerClient.fetchSubstantiveComments` for context.
 *
 * "Substantive" — comment body matches at least one of:
 *   - one of the SUBSTANTIVE_HEADINGS
 *   - a PR or commit URL
 *   - free-form human comment (no symphony lifecycle markers,
 *     not matching SYMPHONY_TURN_HEADING_RE)
 *
 * Body cap: each kept comment trimmed to `bodyMaxChars`, suffixed with
 * `…[truncated, X chars total]`. Output ordering: oldest-first.
 */
export function selectSubstantiveComments(
  comments: ReadonlyArray<SymphonyComment>,
  opts: SelectSubstantiveCommentsOptions = {},
): SymphonyComment[] {
  const limit = opts.substantiveLimit ?? 5;
  const bodyMax = opts.bodyMaxChars ?? 1500;
  const newestFirst = [...comments].reverse();
  const kept: SymphonyComment[] = [];
  for (const c of newestFirst) {
    if (kept.length >= limit) break;
    if (!isSubstantiveBody(c.body)) continue;
    kept.push({ ...c, body: truncateBody(c.body, bodyMax) });
  }
  return kept.reverse();
}

function isSubstantiveBody(body: string): boolean {
  if (!body) return false;
  if (body.includes(SYMPHONY_LIFECYCLE_MARKER_PREFIX)) return false;
  const firstLine = body.trimStart().split("\n", 1)[0] ?? "";
  if (SYMPHONY_TURN_HEADING_RE.test(firstLine)) return false;
  for (const h of SUBSTANTIVE_HEADINGS) {
    if (body.includes(h)) return true;
  }
  if (PR_OR_COMMIT_URL_RE.test(body)) return true;
  return true;
}

function truncateBody(body: string, max: number): string {
  if (body.length <= max) return body;
  const head = body.slice(0, max);
  return `${head}…[truncated, ${body.length} chars total]`;
}
