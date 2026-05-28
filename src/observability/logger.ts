import { createRequire } from "node:module";
import pino, { type Logger } from "pino";

/**
 * Spec §13 / §17.6 — structured logger with `issue_id`, `issue_identifier`,
 * `session_id` context fields. Emits JSON to stdout in production; pretty in
 * dev when `NODE_ENV !== "production"` and `pino-pretty` is available.
 */
const level = process.env.LOG_LEVEL ?? "info";
const isProd = process.env.NODE_ENV === "production";

function buildLogger(): Logger {
  const baseConfig = {
    level,
    base: { service: "symphony" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  if (isProd) return pino(baseConfig);
  // pino-pretty is a devDependency. Guard the transport so the daemon doesn't
  // crash if it ever runs in a non-production environment without pino-pretty
  // installed (e.g. some CI configurations).
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return pino({
      ...baseConfig,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, singleLine: false, translateTime: "HH:MM:ss.l" },
      },
    });
  } catch {
    return pino(baseConfig);
  }
}

export const logger: Logger = buildLogger();

export interface LogContext {
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string;
  attempt?: number | null;
  [key: string]: unknown;
}

export function withContext(ctx: LogContext): Logger {
  return logger.child(ctx);
}
