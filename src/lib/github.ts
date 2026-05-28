import { logger } from "../observability/logger.js";
import { buildIdentifier } from "./build-info.js";

/**
 * GitHub REST queries used by the orchestrator's deliverable check.
 *
 * Auth is delegated to `getInstallationToken` in `./github-auth.ts` — this
 * file deliberately stays free of credential plumbing so the queries can be
 * unit-tested by stubbing `globalThis.fetch` (the shared cached token
 * minter is harder to mock cleanly).
 *
 * Background: the orchestrator's auto-advance previously fired whenever a
 * turn returned `outcome=Succeeded`, regardless of whether the agent
 * actually pushed a branch / opened a PR. AGENT-441 and AGENT-439 reached
 * `Code Review` with empty branch state because their Validate-stage
 * agents converged on a no-op pattern and reported success. The
 * deliverable check below queries GitHub for branches matching the issue
 * identifier and lets the orchestrator block the auto-advance when no
 * branch exists.
 */

export interface GithubBranchSummary {
  name: string;
  /** SHA of the branch tip — useful when the caller wants to dedupe. */
  sha: string;
}

const GITHUB_API_BASE = "https://api.github.com";

export interface FetchBranchesOptions {
  owner?: string;
  repo?: string;
  perPage?: number;
  fetchImpl?: typeof fetch;
  /** Network timeout — short by default since this is in the dispatch hot path. */
  networkTimeoutMs?: number;
}

/**
 * GET /repos/{owner}/{repo}/branches?per_page=100
 *
 * Returns at most `perPage` branches (default 100, GitHub's hard cap). The
 * deliverable check needs to find ANY branch matching an issue identifier,
 * and the symphony fleet caps active branches well below 100, so single-page
 * pagination is fine. If we ever scale past that we'll add cursor support.
 *
 * Returns null on:
 *   - missing token (e.g. local dev without GH App env)
 *   - non-2xx response (logged at warn level — caller decides what to do)
 *   - network error / parse error
 *
 * The caller MUST treat `null` as "couldn't tell" — i.e. fail open and let
 * the orchestrator's existing auto-advance run. Failing closed on a
 * transient GitHub 503 would block every Validate-stage advance during a
 * GitHub outage, which is worse than the bug we're fixing.
 */
export async function fetchBranches(
  token: string,
  opts: FetchBranchesOptions = {},
): Promise<GithubBranchSummary[] | null> {
  const owner = opts.owner ?? "";
  const repo = opts.repo ?? "";
  const perPage = opts.perPage ?? 100;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.networkTimeoutMs ?? 15_000;

  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/branches?per_page=${perPage}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        // B-15: include version + sha so GitHub audit logs name the
        // exact running binary that made the call.
        "User-Agent": buildIdentifier(),
      },
      signal: ac.signal,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, owner, repo },
      "github.fetch_branches.network_error",
    );
    return null;
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    logger.warn(
      { status: res.status, body: body.slice(0, 300), owner, repo },
      "github.fetch_branches.http_error",
    );
    return null;
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "github.fetch_branches.parse_error");
    return null;
  }
  if (!Array.isArray(payload)) return null;
  const out: GithubBranchSummary[] = [];
  for (const entry of payload) {
    if (entry && typeof entry === "object") {
      const e = entry as { name?: unknown; commit?: { sha?: unknown } };
      const name = typeof e.name === "string" ? e.name : null;
      const sha = typeof e.commit?.sha === "string" ? e.commit.sha : null;
      if (name && sha) out.push({ name, sha });
    }
  }
  return out;
}

/**
 * Decide whether any branch in `branches` looks like a deliverable for the
 * issue with `identifier` (e.g. "AGENT-441"). We accept any of:
 *
 *   - `symphony/<identifier-lowercased>`  (symphony's canonical pattern)
 *   - `agent-<number>`                    (legacy fallback pattern, kept as
 *                                          graceful degradation)
 *   - any branch whose name CONTAINS the identifier (case-insensitive) —
 *     this catches Linear's auto-suggested branch names and human
 *     clone-and-push-from-laptop workflows.
 *
 * The check is intentionally generous: a false positive (we say "PR exists"
 * when it actually doesn't) only causes auto-advance to fire — same
 * behavior as today. A false negative (we say "no PR" when one DOES
 * exist) would block legitimate progress, so we err in the other direction.
 */
export function branchMatchesIdentifier(branchName: string, identifier: string): boolean {
  const lower = branchName.toLowerCase();
  const id = identifier.toLowerCase();
  if (lower === `symphony/${id}`) return true;
  if (lower.startsWith(`symphony/${id}-`)) return true;
  // `agent-441`, `agent-441-anything`, or `prefix/agent-441-anything`.
  const numMatch = identifier.match(/-(\d+)$/);
  if (numMatch) {
    const n = numMatch[1];
    if (lower === `agent-${n}` || lower.startsWith(`agent-${n}-`)) return true;
    if (lower.includes(`/agent-${n}-`) || lower.includes(`/agent-${n}/`)) return true;
  }
  // Catch-all: identifier appears as a substring (case-insensitive). This is
  // the most permissive rule — see the comment above for why we err
  // generous.
  return lower.includes(id);
}

/**
 * Find the most recent PR linked to a Linear issue identifier — used by the
 * orchestrator's Release-stage merge-verify guard.
 *
 * Background (2026-05-07 production cutover defect): the Release specialist
 * runs `gh pr merge --squash --delete-branch` to land the sub-issue's PR.
 * On rare-but-real paths (red CI on PR head; transient GitHub 5xx; agent
 * timed out before merge) the merge command DOESN'T succeed but the
 * specialist's LLM turn still returns `outcome=Succeeded` because the
 * agent posted a substantive comment + exited cleanly. The orchestrator
 * then auto-advances Release → Done per `state_transitions["Release"]`,
 * marking the sub Done with PR still open. Real symptom on STG-17.
 *
 * Fix: before auto-advancing Release → Done, the orchestrator queries
 * GitHub for the linked PR and confirms `merged_at` is non-null. If
 * merged: advance normally. If still open / closed-without-merge: route
 * the issue back to Pull request with a comment so the human can see
 * the gap.
 *
 * Endpoints used (in order):
 *
 *   1. `GET /search/issues?q=repo:{owner}/{repo} type:pr <ISSUE-ID> in:body`
 *      — finds PRs whose body contains the literal issue identifier.
 *      The `pulls` list endpoint accepts `?state=all` but NOT a
 *      "body contains" filter, so we use `/search/issues` with
 *      `type:pr` instead. Reliably picks up the PR because every
 *      sub-issue PR ends in `Closes <SUB-LINEAR-ID>` per AGENTS.md.
 *
 *   2. `GET /repos/{owner}/{repo}/pulls/{number}` — followed up to get
 *      `merged_at` + `head.sha` (the search result doesn't include
 *      head SHA). One extra API call per Release advance — cheap.
 *
 * Returns:
 *   - { number, mergedAt, state, headRefOid, htmlUrl }: PR found, with
 *     merge state. `mergedAt` non-null means the merge landed.
 *   - null: no PR found (caller should treat as "no merge happened" → bounce)
 *   - undefined: GitHub API failure (caller should fail open — let
 *     auto-advance proceed, don't block on a transient outage)
 */
export interface GithubPRStatus {
  number: number;
  mergedAt: string | null;
  state: "open" | "closed";
  headRefOid: string;
  htmlUrl: string;
}

/**
 * Per-call options for `fetchPullRequestForIssue`. Mirrors the shape of
 * `FetchBranchesOptions` for consistency, but lives in its own type so
 * call sites read self-explanatorily ("PR-status options" vs "branch
 * options"). Surfaced 2026-05-07 by Copilot review on PR #684.
 */
export interface FetchPullRequestOptions {
  owner?: string;
  repo?: string;
  fetchImpl?: typeof fetch;
  /** Network timeout — short by default since this is in the dispatch hot path. */
  networkTimeoutMs?: number;
}

export async function fetchPullRequestForIssue(
  token: string,
  issueIdentifier: string,
  opts: FetchPullRequestOptions = {},
): Promise<GithubPRStatus | null | undefined> {
  const owner = opts.owner ?? "";
  const repo = opts.repo ?? "";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.networkTimeoutMs ?? 15_000;

  // Search API: find PRs whose body includes the literal issue identifier.
  // The GitHub search syntax `<ID> in:body` matches PR bodies that contain
  // the substring. Per AGENTS.md "Symphony-driven prompts" rule, every
  // sub-issue PR ends in `Closes <SUB-LINEAR-ID>` — so this hit reliably.
  const q = encodeURIComponent(`repo:${owner}/${repo} type:pr ${issueIdentifier} in:body`);
  const url = `${GITHUB_API_BASE}/search/issues?q=${q}&per_page=10&sort=updated&order=desc`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": buildIdentifier(),
      },
      signal: ac.signal,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issueIdentifier },
      "fetchPullRequestForIssue: search request failed; treating as transient",
    );
    return undefined;
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) {
    logger.warn(
      { status: res.status, issueIdentifier },
      "fetchPullRequestForIssue: search returned non-2xx; treating as transient",
    );
    return undefined;
  }

  interface SearchBody {
    items?: Array<{
      number: number;
      pull_request?: { merged_at: string | null };
      state: string;
      html_url: string;
    }>;
  }
  let body: SearchBody;
  try {
    body = (await res.json()) as SearchBody;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issueIdentifier },
      "fetchPullRequestForIssue: response parse failed",
    );
    return undefined;
  }

  const items = body.items ?? [];
  // Take the most recently-updated PR (search API returns sorted by `updated`
  // when we asked above). For the orchestrator's purpose we want THE PR
  // that closes this issue; if multiple exist (e.g., a closed-without-merge
  // earlier attempt + a fresh one), the most recent is the one that matters.
  const pr = items[0];
  if (!pr) return null;

  // The search API doesn't include `head.sha` so we follow up with a single
  // pulls.get call to retrieve it. Cheap (1 extra API call per Release
  // advance) and necessary for the merge-verify CI check.
  //
  // The detail request gets the SAME timeout/AbortController treatment as
  // the search call above — without it a stalled GitHub backend could hang
  // the orchestrator's auto-advance path indefinitely. Surfaced by Copilot
  // review on PR #684. We also treat parse failures as `undefined`
  // (transient → fail open), matching the search-call contract.
  const detailUrl = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pr.number}`;
  const detailAc = new AbortController();
  const detailTimer = setTimeout(() => detailAc.abort(), timeoutMs);
  let detailRes: Response;
  try {
    detailRes = await fetchImpl(detailUrl, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": buildIdentifier(),
      },
      signal: detailAc.signal,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issueIdentifier, prNumber: pr.number },
      "fetchPullRequestForIssue: detail fetch failed",
    );
    return undefined;
  } finally {
    clearTimeout(detailTimer);
  }
  if (!detailRes.ok) {
    logger.warn(
      { status: detailRes.status, issueIdentifier, prNumber: pr.number },
      "fetchPullRequestForIssue: detail returned non-2xx; treating as transient",
    );
    return undefined;
  }
  let detail: {
    merged_at: string | null;
    state: string;
    head: { sha: string };
    html_url: string;
  };
  try {
    detail = (await detailRes.json()) as typeof detail;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, issueIdentifier, prNumber: pr.number },
      "fetchPullRequestForIssue: detail parse failed",
    );
    return undefined;
  }
  return {
    number: pr.number,
    mergedAt: detail.merged_at,
    state: (detail.state as "open" | "closed") ?? "open",
    headRefOid: detail.head.sha,
    htmlUrl: detail.html_url,
  };
}
