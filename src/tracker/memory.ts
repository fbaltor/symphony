import type { Issue } from "../types.js";
import type { ChildIssue, IssueTracker, TrackerComment } from "./tracker.js";
import { selectSubstantiveComments } from "./linear.js";
import { TrackerError } from "./errors.js";

/**
 * In-memory `IssueTracker` (zero-dep E2E plan, Phase A — decision in §2 item
 * 1). Backs a full poll→dispatch→transition→reconcile cycle with NO Linear:
 * reads reflect prior writes, sub-issue decomposition is observable, and no
 * network is touched.
 *
 * It mirrors `LinearTrackerClient`'s observable contract — including the
 * sub-ticketing extensions (`createIssue`, `resolveLabelIds`, `getTeamId`,
 * `archiveIssue`, `updateIssueDescription`) — but DELIBERATELY does not
 * implement `AgentToolProvider`: a MemoryTracker has no agent GraphQL tool, so
 * `buildMcpServers` omits `linear_graphql` for it (decision 1c).
 *
 * State is held in plain `Map`s keyed by issue id; mutations write through to
 * the same `Issue` records the read methods return, so a transition or a
 * posted comment is immediately visible on the next read.
 */
export class MemoryTracker implements IssueTracker {
  /** Issue records keyed by id. Mutated in place by transitions / updates. */
  private readonly issues = new Map<string, Issue>();
  /** Comment lists keyed by issue id, oldest-first (insertion order). */
  private readonly comments = new Map<string, TrackerComment[]>();
  /** Parent id → ordered child ids. Built as `createIssue` files children. */
  private readonly children = new Map<string, string[]>();
  /** Archived issue ids — hidden from candidate / state reads. */
  private readonly archived = new Set<string>();
  /**
   * Label name (lowercase) → synthetic label id, and the reverse. Seed issues'
   * labels register on construction; `resolveLabelIds` / `createIssue`
   * round-trip through these so a child inherits its parent's taxonomy and the
   * names are readable back via the full-issue view.
   */
  private readonly labelIdByName = new Map<string, string>();
  private readonly labelNameById = new Map<string, string>();

  /** Configured team id. Non-null so the sub-ticketing path resolves a team. */
  private readonly teamId: string;
  /** Monotonic counters for synthetic ids / identifiers. */
  private seq = 0;
  /** Cached viewer id, mirroring the Linear client's bot-identity surface. */
  private viewerId: string | null = "memory-viewer";

  constructor(seed: Issue[] = [], opts: { teamId?: string } = {}) {
    this.teamId = opts.teamId ?? "memory-team";
    for (const issue of seed) {
      // Clone so external mutation of the seed array doesn't bleed into our
      // store, and vice versa.
      this.issues.set(issue.id, { ...issue, labels: [...issue.labels] });
      for (const label of issue.labels) this.registerLabel(label);
    }
  }

  /** Register a label name, minting a synthetic id on first sight. */
  private registerLabel(name: string): string {
    const existing = this.labelIdByName.get(name);
    if (existing) return existing;
    const id = `label-${this.labelIdByName.size + 1}`;
    this.labelIdByName.set(name, id);
    this.labelNameById.set(id, name);
    return id;
  }

  // --- polling ---

  async fetchCandidateIssues(activeStates: string[]): Promise<Issue[]> {
    const want = new Set(activeStates);
    return this.liveIssues()
      .filter((i) => want.has(i.state))
      .map(cloneIssue);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    if (states.length === 0) return [];
    const want = new Set(states);
    return this.liveIssues()
      .filter((i) => want.has(i.state))
      .map(cloneIssue);
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    const out: Issue[] = [];
    for (const id of ids) {
      const issue = this.issues.get(id);
      if (issue) out.push(cloneIssue(issue));
    }
    return out;
  }

  async fetchIssueDescriptionById(id: string): Promise<string | null> {
    const issue = this.issues.get(id);
    if (!issue) return null;
    return issue.description ?? "";
  }

  // --- comments ---

  async fetchIssueComments(issueId: string, first: number = 25): Promise<TrackerComment[]> {
    const all = this.comments.get(issueId) ?? [];
    // Mirror Linear's "most recent `first`, oldest-first" semantics.
    return all.slice(Math.max(0, all.length - first)).map((c) => ({ ...c }));
  }

  async fetchSubstantiveComments(
    issueId: string,
    opts: { fetchLimit?: number; substantiveLimit?: number; bodyMaxChars?: number } = {},
  ): Promise<TrackerComment[]> {
    const all = await this.fetchIssueComments(issueId, opts.fetchLimit ?? 50);
    return selectSubstantiveComments(all, {
      substantiveLimit: opts.substantiveLimit ?? 5,
      bodyMaxChars: opts.bodyMaxChars ?? 1500,
    });
  }

  // --- mutations ---

  async createComment(issueId: string, body: string): Promise<{ id: string; url: string } | null> {
    const list = this.comments.get(issueId) ?? [];
    const id = `comment-${++this.seq}`;
    list.push({
      createdAt: new Date(0).toISOString(),
      body,
      author: "memory-bot",
    });
    this.comments.set(issueId, list);
    return { id, url: `memory://comment/${id}` };
  }

  async transitionIssueToState(
    issueId: string,
    stateName: string,
  ): Promise<{ identifier: string; state: string }> {
    const issue = this.issues.get(issueId);
    if (!issue) {
      throw new TrackerError(
        "linear_state_not_found",
        `transitionIssueToState: unknown issue ${issueId}`,
      );
    }
    // Write through to the stored record so subsequent polls / refreshes see
    // the new state immediately.
    issue.state = stateName;
    return { identifier: issue.identifier, state: issue.state };
  }

  // --- hierarchy ---

  async fetchChildIssues(parentId: string): Promise<ChildIssue[]> {
    const ids = this.children.get(parentId) ?? [];
    const out: ChildIssue[] = [];
    for (const id of ids) {
      const issue = this.issues.get(id);
      if (!issue || this.archived.has(id)) continue;
      out.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        state: issue.state,
        description: issue.description,
        url: issue.url,
      });
    }
    return out;
  }

  // --- bot identity ---

  async fetchViewerId(): Promise<string | null> {
    return this.viewerId;
  }

  getViewerId(): string | null {
    return this.viewerId;
  }

  // --- cache ---

  invalidateTeamStatesCache(): void {
    // No cached lookups to invalidate — state names are stored verbatim.
  }

  // --- sub-ticketing extensions ---

  async createIssue(args: {
    teamId: string;
    title: string;
    description: string;
    parentId?: string | null;
    priority?: number | null;
    labelIds?: readonly string[];
  }): Promise<{ id: string; identifier: string; url: string }> {
    const n = ++this.seq;
    const id = `mem-${n}`;
    const identifier = `MEM-${n + 1000}`;
    // Translate inherited label ids back into names so the child carries its
    // parent's taxonomy in the normalized `Issue.labels` view.
    const labels: string[] = [];
    for (const labelId of args.labelIds ?? []) {
      const name = this.labelNameById.get(labelId);
      if (name) labels.push(name);
    }
    const child: Issue = {
      id,
      identifier,
      title: args.title,
      description: args.description,
      priority: typeof args.priority === "number" ? args.priority : null,
      state: "Active",
      branchName: null,
      url: `memory://issue/${id}`,
      labels,
      blockedBy: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: null,
    };
    this.issues.set(id, child);
    if (args.parentId) {
      const siblings = this.children.get(args.parentId) ?? [];
      siblings.push(id);
      this.children.set(args.parentId, siblings);
    }
    return { id: child.id, identifier: child.identifier, url: child.url as string };
  }

  async resolveLabelIds(lowercaseNames: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const name of lowercaseNames) {
      // Register on demand so a parent label that wasn't in the seed set still
      // round-trips (mirrors how a Linear team's catalog would already hold it).
      out.push(this.registerLabel(name));
    }
    return out;
  }

  getTeamId(): string | null {
    return this.teamId;
  }

  async archiveIssue(issueId: string): Promise<void> {
    if (!this.issues.has(issueId)) {
      throw new TrackerError("linear_issue_archive_failed", `archiveIssue: unknown issue ${issueId}`);
    }
    this.archived.add(issueId);
  }

  async updateIssueDescription(issueId: string, description: string): Promise<void> {
    const issue = this.issues.get(issueId);
    if (!issue) {
      throw new TrackerError(
        "linear_issue_update_failed",
        `updateIssueDescription: unknown issue ${issueId}`,
      );
    }
    issue.description = description;
  }

  /* ----------------------------- internals ----------------------------- */

  /** Stored issues excluding archived ones (the candidate/terminal views). */
  private liveIssues(): Issue[] {
    return [...this.issues.values()].filter((i) => !this.archived.has(i.id));
  }
}

/** Defensive clone so callers can't mutate our stored record by reference. */
function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blockedBy: issue.blockedBy.map((b) => ({ ...b })),
  };
}
