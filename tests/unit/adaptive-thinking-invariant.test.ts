import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * B-4 invariant: Anthropic 2026 SDK rejects `thinking: { type: "enabled",
 * budget_tokens: N }` on Opus 4.7+ with a 400. Symphony MUST use the
 * adaptive variant (`thinking: { type: "adaptive", effort }`) per A-10.
 *
 * This test grep-scans `src/` for the literal `budget_tokens` and the
 * old enabled-thinking shape, failing CI if either reappears. Cheaper
 * than waiting for a runtime 400 to surface in production.
 */

const SRC_ROOT = join(process.cwd(), "src");

async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

describe("adaptive thinking invariant", () => {
  it("no `budget_tokens` literal anywhere under src/", async () => {
    const offenders: Array<{ path: string; line: number; text: string }> = [];
    for await (const path of walkTsFiles(SRC_ROOT)) {
      const text = await readFile(path, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.includes("budget_tokens")) {
          offenders.push({ path, line: i + 1, text: line.trim() });
        }
      });
    }
    expect(offenders, `found budget_tokens in: ${JSON.stringify(offenders, null, 2)}`).toEqual([]);
  });

  it('no `thinking: { type: "enabled" }` literal under src/', async () => {
    const offenders: Array<{ path: string; line: number; text: string }> = [];
    for await (const path of walkTsFiles(SRC_ROOT)) {
      const text = await readFile(path, "utf8");
      // Literal "type: \"enabled\"" within a few lines of `thinking` — be
      // generous and just look for the dangerous combination.
      if (/thinking[\s\S]{0,80}type:\s*"enabled"/.test(text)) {
        const lines = text.split(/\r?\n/);
        const idx = lines.findIndex((l) => l.includes('"enabled"'));
        offenders.push({ path, line: idx + 1, text: lines[idx]?.trim() ?? "" });
      }
    }
    expect(
      offenders,
      `found thinking.type="enabled" in: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });
});
