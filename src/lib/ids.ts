/**
 * Spec §4.2 / §9.5 invariant 3 — workspace key sanitization.
 *
 * Replace any character outside `[A-Za-z0-9._-]` with `_`. Used to map a
 * tracker identifier (e.g. `ABC-123`) to an on-disk directory name.
 */
export function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Spec §4.2 — `<thread_id>-<turn_id>` session id composer. */
export function composeSessionId(threadId: string, turnId: string): string {
  return `${threadId}-${turnId}`;
}

/** Lowercase normalization used for state comparisons (spec §4.2). */
export function normalizeStateName(name: string): string {
  return name.toLowerCase();
}
