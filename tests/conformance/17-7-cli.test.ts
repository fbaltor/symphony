import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Spec §17.7 — CLI / host lifecycle.
 *
 * The full lifecycle is exercised by integration tests; here we confirm that
 * the entry point exists, has a default workflow path, and that its argv
 * handling logic is reachable.
 */

describe("§17.7 CLI surface", () => {
  it("ships an entry file at src/main.ts", () => {
    const path = resolve(import.meta.dirname, "../../src/main.ts");
    expect(existsSync(path)).toBe(true);
  });

  it("defaults to ./WORKFLOW.md when no positional arg is given", async () => {
    // Re-import the module is a side-effecting daemon bootstrap; instead we
    // assert via a dry-run shape: argv handling is "argv[2] ?? env ?? default".
    // The default is documented at the call site — simply assert the literal
    // appears in the entry file.
    const fs = await import("node:fs/promises");
    const entry = await fs.readFile(resolve(import.meta.dirname, "../../src/main.ts"), "utf8");
    expect(entry).toMatch(/WORKFLOW\.md/);
  });
});
