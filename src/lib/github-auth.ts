import { createSign } from "node:crypto";
import { logger } from "../observability/logger.js";
import { buildIdentifier } from "./build-info.js";

/**
 * GitHub App installation-token minter.
 *
 * Two-step flow per GitHub docs:
 *   1. Sign an RS256 JWT with our App's private key (10-min lifetime).
 *   2. POST to `/app/installations/<id>/access_tokens` to exchange the JWT
 *      for a short-lived installation access token (~1h lifetime).
 *
 * The token is cached until ~60s before expiry. Used by:
 *   - workspace hook execution: injects `GITHUB_TOKEN` env so the
 *     `git clone` / `git fetch` calls in WORKFLOW.md hooks can reach
 *     private repos.
 *   - the agent's MCP layer: GitHub MCP server takes the same token.
 *
 */

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cached: CachedToken | undefined;

export interface GitHubAppCredentials {
  appId: string;
  installationId: string;
  privateKeyPem: string;
}

/**
 * Read GH App creds from process.env. Returns null when any are missing —
 * symphony's hooks then run without injecting GITHUB_TOKEN, and the agent's
 * GitHub MCP is skipped. This lets the daemon boot in environments without
 * GH App config (local dev / first-deploy placeholder state).
 */
export function readCredsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GitHubAppCredentials | null {
  const appId = (env.GITHUB_APP_ID ?? "").trim();
  const installationId = (env.GITHUB_APP_INSTALLATION_ID ?? "").trim();
  const rawPem = env.GITHUB_APP_PRIVATE_KEY ?? "";
  if (!appId || !installationId || !rawPem) return null;
  return {
    appId,
    installationId,
    privateKeyPem: normalizePrivateKey(rawPem),
  };
}

/**
 * Normalize a private key that may have been pasted with literal `\n`
 * sequences instead of real newlines (common when a PEM is round-tripped
 * through env vars or .env files).
 */
export function normalizePrivateKey(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

/**
 * Build an RS256 JWT for a GitHub App. Hand-rolled so we don't pull a JWT
 * library; algorithm and `iat` skew follow the standard GitHub App JWT recipe.
 */
export function buildAppJwt(appId: string, privateKeyPem: string): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // 60s clock-skew tolerance
    exp: now + 600, // 10 min max per GitHub docs
    iss: appId,
  };

  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const signingInput = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer
    .sign(privateKeyPem)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${signingInput}.${signature}`;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
  repository_selection?: string;
  permissions?: Record<string, string>;
}

/**
 * Mint (or return cached) a GitHub App installation access token.
 * Returns null when GH App env vars are missing.
 *
 * retries 3 times on transient transport errors (network failure or
 * HTTP 5xx) with 100 → 500 → 2000 ms backoff + ±20% jitter. Without this,
 * a single GitHub API blip (`502 Bad Gateway`, `503 Service Unavailable`)
 * caused the whole turn's GitHub MCP wiring to skip + before_run hook to
 * fail (no `GITHUB_TOKEN` env in the workspace, so `git clone` 401s).
 *
 * Permanent failures (4xx, missing creds, malformed JSON response) are
 * NOT retried — caller still gets `null` and skips the GitHub MCP for
 * that dispatch.
 */
const RETRYABLE_DELAYS_MS = [100, 500, 2000] as const;

export async function getInstallationToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const creds = readCredsFromEnv(env);
  if (!creds) return null;

  if (cached && cached.expiresAtMs - Date.now() > 60_000) {
    return cached.token;
  }

  const jwt = buildAppJwt(creds.appId, creds.privateKeyPem);
  const url = `https://api.github.com/app/installations/${creds.installationId}/access_tokens`;

  for (let attempt = 1; attempt <= RETRYABLE_DELAYS_MS.length + 1; attempt++) {
    const result = await tryMintInstallationToken(url, jwt);
    if (result.kind === "ok") {
      cached = result.cached;
      logger.info(
        {
          expires_at: result.payload.expires_at,
          repository_selection: result.payload.repository_selection,
          permission_count: Object.keys(result.payload.permissions ?? {}).length,
          attempt,
        },
        "github.installation_token.refreshed",
      );
      return cached.token;
    }
    if (!result.retryable || attempt > RETRYABLE_DELAYS_MS.length) {
      // No retry budget left; the inner attempt already logged the error.
      return null;
    }
    const base = RETRYABLE_DELAYS_MS[attempt - 1] ?? 2000;
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(0, Math.round(base + jitter));
    logger.warn(
      { attempt, nextDelayMs: delay, status: result.status },
      "github.installation_token.retrying",
    );
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

interface MintOk {
  kind: "ok";
  cached: CachedToken;
  payload: InstallationTokenResponse;
}
interface MintFail {
  kind: "fail";
  retryable: boolean;
  status?: number;
}

async function tryMintInstallationToken(url: string, jwt: string): Promise<MintOk | MintFail> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        // include version + sha so GitHub audit logs identify the
        // exact running binary that minted this installation token.
        "User-Agent": buildIdentifier(),
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "github.installation_token.network_error");
    return { kind: "fail", retryable: true };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    logger.error(
      { status: res.status, body: body.slice(0, 500) },
      "github.installation_token.http_error",
    );
    // 5xx is transient (GitHub server-side); 4xx is permanent (auth /
    // missing app / installation revoked) — no retry budget for those.
    return { kind: "fail", retryable: res.status >= 500 && res.status < 600, status: res.status };
  }

  let payload: InstallationTokenResponse;
  try {
    payload = (await res.json()) as InstallationTokenResponse;
  } catch (err) {
    logger.error({ err: (err as Error).message }, "github.installation_token.parse_error");
    return { kind: "fail", retryable: false };
  }
  return {
    kind: "ok",
    payload,
    cached: {
      token: payload.token,
      expiresAtMs: new Date(payload.expires_at).getTime(),
    },
  };
}

/** Test-only — flush the in-memory token cache between tests. */
export function _resetGithubAuthCache(): void {
  cached = undefined;
}
