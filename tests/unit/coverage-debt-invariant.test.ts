/**
 * Coverage-debt catalog ↔ source-marker invariant.
 *
 * Validates that every `// COVERAGE-DEBT: <slug>` marker in `src/` has a
 * matching `## \`<slug>\`` section in `docs/coverage-debt.md` and vice-versa.
 *
 * Why this test exists — see `docs/coverage-debt.md` "Why keep a catalog?"
 *
 * The catalog is intentionally empty until the first marker lands in src/.
 * The invariant test still runs and provides drift-prevention from day one.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const CATALOG_PATH = resolve(REPO_ROOT, "docs", "coverage-debt.md");
const SRC_ROOT = resolve(REPO_ROOT, "src");

// Slug character class: lowercase letters, digits, hyphens.
const SLUG_RE = /^[a-z0-9-]+$/;

// Source-side marker — anchor on literal `// COVERAGE-DEBT:` so
// narrative prose mentioning "coverage debt" doesn't match.
const SOURCE_MARKER_RE = /\/\/\s*COVERAGE-DEBT:\s*([a-z0-9-]+)/g;

// Catalog section header. Backticks on the slug are load-bearing —
// they distinguish entry headers from narrative `## Why` / `## Status`
// sections that should NOT be parsed as entries.
const CATALOG_ENTRY_RE = /^##\s+`([a-z0-9-]+)`\s*$/;

/** Walk `src/` recursively, returning absolute paths to every `.ts` /
 *  `.tsx` file. Symphony has no test or generated TS in `src/` so we
 *  don't need exclude lists. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

interface SourceMarker {
  file: string;
  slug: string;
  line: number;
}

function collectSourceMarkers(): SourceMarker[] {
  const out: SourceMarker[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      SOURCE_MARKER_RE.lastIndex = 0;
      const line = lines[i]!;
      let m: RegExpExecArray | null;
      while ((m = SOURCE_MARKER_RE.exec(line)) !== null) {
        out.push({
          file: relative(REPO_ROOT, file),
          slug: m[1]!,
          line: i + 1,
        });
      }
    }
  }
  return out;
}

function collectCatalogEntries(): Array<{ slug: string; line: number }> {
  const source = readFileSync(CATALOG_PATH, "utf8");
  const out: Array<{ slug: string; line: number }> = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(CATALOG_ENTRY_RE);
    if (m) {
      out.push({ slug: m[1]!, line: i + 1 });
    }
  }
  return out;
}

describe("coverage-debt invariant — marker ↔ catalog match", () => {
  it("catalog file exists and is non-empty", () => {
    const stat = statSync(CATALOG_PATH);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("every source marker has a matching catalog entry", () => {
    const markers = collectSourceMarkers();
    const catalogSlugs = new Set(collectCatalogEntries().map((e) => e.slug));

    const orphanMarkers = markers.filter((m) => !catalogSlugs.has(m.slug));

    expect(
      orphanMarkers,
      orphanMarkers.length > 0
        ? [
            "Found COVERAGE-DEBT marker(s) in src/ without a matching catalog entry in docs/coverage-debt.md.",
            "Each orphan below needs a `## `<slug>`` section in docs/coverage-debt.md explaining the gap, OR the marker should be removed.",
            "",
            ...orphanMarkers.map((o) => `  - ${o.file}:${o.line} slug="${o.slug}"`),
          ].join("\n")
        : "",
    ).toEqual([]);
  });

  it("every catalog entry has a matching source marker", () => {
    const entries = collectCatalogEntries();
    const markerSlugs = new Set(collectSourceMarkers().map((m) => m.slug));

    const orphanEntries = entries.filter((e) => !markerSlugs.has(e.slug));

    expect(
      orphanEntries,
      orphanEntries.length > 0
        ? [
            "Found catalog entry(s) in docs/coverage-debt.md without a matching COVERAGE-DEBT marker in src/.",
            "Each orphan below should be removed from docs/coverage-debt.md (defense was dropped?), OR a matching `// COVERAGE-DEBT: <slug>` marker added to the source.",
            "",
            ...orphanEntries.map((o) => `  - docs/coverage-debt.md:${o.line} slug="${o.slug}"`),
          ].join("\n")
        : "",
    ).toEqual([]);
  });
});

describe("coverage-debt invariant — structural hygiene", () => {
  it("no slug is duplicated in src/ markers", () => {
    const markers = collectSourceMarkers();
    const seen = new Map<string, Array<{ file: string; line: number }>>();
    for (const m of markers) {
      const arr = seen.get(m.slug) ?? [];
      arr.push({ file: m.file, line: m.line });
      seen.set(m.slug, arr);
    }
    const dups = [...seen.entries()].filter(([, locs]) => locs.length > 1);

    expect(
      dups,
      dups.length > 0
        ? [
            "Found COVERAGE-DEBT slug(s) used at multiple source locations.",
            "Each slug must identify a unique defensive region. If two regions share the same defense, give them distinct slugs (e.g., `-a` / `-b`) OR merge them into one.",
            "",
            ...dups.flatMap(([slug, locs]) => [
              `  - slug="${slug}":`,
              ...locs.map((l) => `      ${l.file}:${l.line}`),
            ]),
          ].join("\n")
        : "",
    ).toEqual([]);
  });

  it("no slug is duplicated in catalog entries", () => {
    const entries = collectCatalogEntries();
    const seen = new Map<string, number[]>();
    for (const e of entries) {
      const arr = seen.get(e.slug) ?? [];
      arr.push(e.line);
      seen.set(e.slug, arr);
    }
    const dups = [...seen.entries()].filter(([, lines]) => lines.length > 1);

    expect(
      dups,
      dups.length > 0
        ? [
            "Found duplicate slug(s) in docs/coverage-debt.md.",
            "Each slug should appear in exactly one `## `<slug>`` section header. Consolidate or rename.",
            "",
            ...dups.flatMap(([slug, lines]) => [
              `  - slug="${slug}":`,
              ...lines.map((l) => `      docs/coverage-debt.md:${l}`),
            ]),
          ].join("\n")
        : "",
    ).toEqual([]);
  });

  it("all slugs match the kebab-case convention", () => {
    const markers = collectSourceMarkers();
    const entries = collectCatalogEntries();
    for (const m of markers) {
      expect(
        SLUG_RE.test(m.slug),
        `source marker at ${m.file}:${m.line} has slug "${m.slug}" — must match /^[a-z0-9-]+$/`,
      ).toBe(true);
    }
    for (const e of entries) {
      expect(
        SLUG_RE.test(e.slug),
        `catalog entry at docs/coverage-debt.md:${e.line} has slug "${e.slug}" — must match /^[a-z0-9-]+$/`,
      ).toBe(true);
    }
  });

  // No floor assertion yet — add one when the first debt entry lands to
  // lock in the new baseline and prevent silent removal.
});
