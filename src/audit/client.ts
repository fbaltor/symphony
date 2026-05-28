import pg from "pg";
import { logger } from "../observability/logger.js";

/**
 * Postgres pool wrapper. Uses `DATABASE_URL` from process.env.
 * Runs all queries under the `symphony` schema.
 */

const { Pool: PgPool } = pg;

export type Client = pg.PoolClient;
export type PgPoolType = pg.Pool;

let cached: pg.Pool | null = null;
let cachedKey: string | null = null;

export interface PoolOptions {
  databaseUrl: string;
  schema: string;
  maxConnections?: number;
}

export function createPool(opts: PoolOptions): pg.Pool {
  // Avoid using the raw databaseUrl in the cache key (it'd leak into logs on
  // mismatch errors). Hash it via host + dbname extraction instead.
  const dbDigest = digestDatabaseUrl(opts.databaseUrl);
  const key = `${dbDigest}|${opts.schema}|${opts.maxConnections ?? 5}`;
  if (cached) {
    if (cachedKey === key) return cached;
    throw new Error(
      "createPool called with different options after pool was already created; audit rows could be misrouted (DB URL redacted)",
    );
  }
  cachedKey = key;
  // Set search_path via the libpq `options` startup parameter so it's bound
  // before the first user query. The previous `connect`-handler approach
  // raced against the first SELECT on a brand-new connection.
  const schema = escapeIdent(opts.schema);
  cached = new PgPool({
    connectionString: opts.databaseUrl,
    max: opts.maxConnections ?? 5,
    options: `-c search_path=${schema},public`,
  });
  cached.on("error", (err) => {
    logger.error({ err: err.message }, "pg pool error");
  });
  return cached;
}

export async function shutdownPool(): Promise<void> {
  if (!cached) return;
  await cached.end();
  cached = null;
  cachedKey = null;
}

function escapeIdent(s: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
    throw new Error(`invalid identifier: ${s}`);
  }
  return `"${s}"`;
}

/** Stable, password-free fingerprint for cache-key comparison. */
function digestDatabaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // Fall back to length+slice — never log the raw string.
    return `len=${raw.length}`;
  }
}
