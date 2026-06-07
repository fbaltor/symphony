import { resolveGitHubToken } from "./github-auth.js";
import {
  fetchBranches,
  fetchPullRequestForIssue,
  type GithubBranchSummary,
  type GithubPRStatus,
} from "./github.js";

/**
 * Phase D (zero-dep E2E) — the `DeliverableSource` seam.
 *
 * The orchestrator's deliverable gate (`pr_required_states`) and Release-stage
 * merge-verify guard ask GitHub whether a branch / PR exists for an issue
 * identifier. Today they call the module-level `fetchBranches` /
 * `fetchPullRequestForIssue` directly (minting a token via
 * `getInstallationToken`). This interface lets the gate read that data from an
 * injectable source instead, so the zero-dependency E2E profile can script
 * branches / PRs in-memory with no token and no network.
 *
 * The two impls:
 *   - `GithubDeliverableSource` — wraps the existing GitHub functions
 *     unchanged. It resolves the installation token the same way the
 *     orchestrator does today and drops `{ owner, repo }` into each call, so
 *     the `kind=linear` profile behaves byte-for-byte as before.
 *   - `MemoryDeliverableSource` — returns scripted branches / PRs with no
 *     network and no token.
 *
 * The branch-presence decision stays the pure `branchMatchesIdentifier` util
 * (`./github.ts`); callers run it over `fetchBranches()`. It is deliberately
 * NOT a method on this interface — keeping it a free function means both the
 * GitHub-backed and scripted paths share one matcher and a refactor can't
 * silently fork the logic.
 */
export interface DeliverableSource {
  /**
   * Branches the deliverable gate scans for a match against the issue
   * identifier. `null` means "couldn't tell" (no token / transient GitHub
   * failure) — the caller fails open. Mirrors `fetchBranches`' contract.
   */
  fetchBranches(): Promise<GithubBranchSummary[] | null>;
  /**
   * The most recent PR linked to `issueIdentifier`, used by the Release-stage
   * merge-verify guard. `null` => no PR found (caller bounces); `undefined` =>
   * GitHub API failure (caller fails open). Mirrors
   * `fetchPullRequestForIssue`' contract.
   */
  fetchPullRequestForIssue(
    issueIdentifier: string,
  ): Promise<GithubPRStatus | null | undefined>;
}

export interface GithubDeliverableSourceOptions {
  /**
   * Repo coordinates from WORKFLOW.md `github.owner` / `github.repo`. Typed as
   * optional to mirror `FetchBranchesOptions` (preflightValidate guarantees
   * they're set at boot; the wrapped fns default a missing value to `""`).
   */
  owner: string | undefined;
  repo: string | undefined;
  /** Resolve the GH App installation token. Defaults to the real minter. */
  tokenProvider?: () => Promise<string | null>;
}

/**
 * Real, GitHub-backed source. Thin wrapper: resolves the installation token
 * (as the orchestrator does today) and delegates to the unchanged
 * `fetchBranches` / `fetchPullRequestForIssue`.
 */
export class GithubDeliverableSource implements DeliverableSource {
  private readonly owner: string | undefined;
  private readonly repo: string | undefined;
  private readonly tokenProvider: () => Promise<string | null>;

  constructor(opts: GithubDeliverableSourceOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.tokenProvider = opts.tokenProvider ?? resolveGitHubToken;
  }

  async fetchBranches(): Promise<GithubBranchSummary[] | null> {
    const token = await this.tokenProvider();
    // No GH App token (local dev / placeholder env) => "couldn't tell" so the
    // gate fails open, matching the orchestrator's prior inline behavior.
    if (!token) return null;
    return fetchBranches(token, { owner: this.owner, repo: this.repo });
  }

  async fetchPullRequestForIssue(
    issueIdentifier: string,
  ): Promise<GithubPRStatus | null | undefined> {
    const token = await this.tokenProvider();
    // No token => fail open on the Release merge-verify path (the orchestrator
    // treats a missing token as "skip the guard"). `undefined` is the
    // fail-open signal.
    if (!token) return undefined;
    return fetchPullRequestForIssue(token, issueIdentifier, {
      owner: this.owner,
      repo: this.repo,
    });
  }
}

export interface MemoryDeliverableSourceScript {
  /**
   * Scripted branches. `null` simulates the GitHub-backed "couldn't tell"
   * (no token / transient 5xx) so the gate's fail-open branch is exercisable
   * without the network.
   */
  branches: GithubBranchSummary[] | null;
  /**
   * Scripted PRs keyed by issue identifier. A present `GithubPRStatus` => PR
   * found; an explicit `undefined` value => GitHub API failure (fail open); a
   * missing key => no PR found (`null`).
   */
  prsByIssue?: Record<string, GithubPRStatus | undefined>;
}

/**
 * Scripted, network-free source for the zero-dependency E2E profile (and the
 * deliverable-gate unit tests). Constructed with pre-loaded branches / PRs;
 * returns them verbatim. No token, no `fetch`.
 */
export class MemoryDeliverableSource implements DeliverableSource {
  private readonly branches: GithubBranchSummary[] | null;
  private readonly prsByIssue: Record<string, GithubPRStatus | undefined>;

  constructor(script: MemoryDeliverableSourceScript) {
    this.branches = script.branches;
    this.prsByIssue = script.prsByIssue ?? {};
  }

  async fetchBranches(): Promise<GithubBranchSummary[] | null> {
    return this.branches;
  }

  async fetchPullRequestForIssue(
    issueIdentifier: string,
  ): Promise<GithubPRStatus | null | undefined> {
    // Distinguish three scripted states:
    //   - key present with a value      => that PR
    //   - key present with `undefined`  => API failure (fail open)
    //   - key absent                    => no PR found (`null`)
    if (Object.prototype.hasOwnProperty.call(this.prsByIssue, issueIdentifier)) {
      return this.prsByIssue[issueIdentifier];
    }
    return null;
  }
}
