/**
 * Phase C — behavior 3 guard: specialists and the orchestrator no longer
 * reference `pg.Pool` directly; they receive the abstract stores instead.
 *
 * Two complementary, falsifiable checks:
 *
 *   1. Type-level — `SpecialistContext` exposes a `store: MetadataStore`
 *      (and the orchestrator's deps expose the stores), and a value of the
 *      store type is assignable into that field. This compiles only once the
 *      seam is wired; if the field is still `pool: pg.Pool`, the test file
 *      fails to type-check / the assignment is rejected.
 *
 *   2. Static source scan — the specialist modules and the orchestrator no
 *      longer import the `pg` package or type-annotate against `pg.Pool`.
 *      This is a grep-style assertion over the real source files, so it is
 *      falsifiable and will go RED today (the seam isn't wired yet) and stay
 *      GREEN only after the pool reference is removed.
 *
 * Scope note: domain code = the four specialists + their shared
 * `src/agents/types.ts` + the orchestrator. The composition root
 * (`src/main.ts`) and the concrete Postgres store impls
 * (`src/audit/store-postgres.ts`) are EXPECTED to still touch `pg`, so they
 * are deliberately excluded.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { SpecialistContext } from "../../src/agents/types.js";
import type { OrchestratorDeps } from "../../src/orchestrator/orchestrator.js";
import type { MetadataStore } from "../../src/audit/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../src");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}

describe("behavior 3 — no raw pg.Pool in domain code (type-level)", () => {
  it("SpecialistContext exposes a MetadataStore-typed store the specialists use", () => {
    // Compile-time contract: a MetadataStore value is assignable to
    // SpecialistContext['store']. If the field is missing or still typed as
    // pg.Pool, this assignment fails to type-check.
    type StoreField = SpecialistContext["store"];
    const accept = (s: StoreField): StoreField => s;
    // The runtime body is incidental; the TYPE of the parameter is the test.
    const probe = (store: MetadataStore): StoreField => accept(store);
    expect(typeof probe).toBe("function");
  });

  it("OrchestratorDeps exposes the abstract stores (metadata/audit/budget), not a pg.Pool", () => {
    // At least the metadata store must be reachable from the orchestrator's
    // deps. Asserting the keyed type is a MetadataStore is a compile-time
    // guard; we touch it at runtime so the test is non-empty.
    type DepStore = OrchestratorDeps["store"];
    const accept = (s: DepStore): DepStore => s;
    const probe = (store: MetadataStore): DepStore => accept(store);
    expect(typeof probe).toBe("function");
  });
});

describe("behavior 3 — no raw pg.Pool in domain code (static scan)", () => {
  const DOMAIN_FILES = [
    "agents/types.ts",
    "agents/prioritized/index.ts",
    "agents/technical-plan/index.ts",
    "agents/pr-validation/index.ts",
    "agents/release/index.ts",
    "orchestrator/orchestrator.ts",
  ];

  it.each(DOMAIN_FILES)("%s does not import the pg package", (rel) => {
    const src = read(rel);
    // Catches both `import pg from "pg"` and `import type pg from "pg"` plus
    // named imports from the pg package.
    expect(src).not.toMatch(/from\s+["']pg["']/);
  });

  it.each(DOMAIN_FILES)("%s does not type-annotate against pg.Pool", (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/pg\.Pool/);
  });
});
