import { describe, expect, it } from "vitest";

import {
  MANAGED_SECTIONS,
  getSection,
  listSections,
  parseDecisionOverride,
  parseDescription,
  removeSection,
  serializeDescription,
  updateSection,
} from "../../src/lib/section-manager.js";

describe("section-manager", () => {
  describe("parseDescription / serializeDescription round-trip", () => {
    it("returns identical bytes for an empty description", () => {
      const desc = "";
      expect(serializeDescription(parseDescription(desc))).toBe(desc);
    });

    it("returns identical bytes for a description with only a prelude", () => {
      const desc = "Some prose without sections.\nA second line.\n";
      expect(serializeDescription(parseDescription(desc))).toBe(desc);
    });

    it("returns identical bytes for a single managed section", () => {
      const desc = "## Goals\n\nFix the typo.\n";
      expect(serializeDescription(parseDescription(desc))).toBe(desc);
    });

    it("returns identical bytes for prelude + multiple sections", () => {
      const desc = [
        "Original request from the human.",
        "",
        "## Goals",
        "",
        "Fix the typo.",
        "",
        "## Context",
        "",
        "Found in `apps/frontend/legal-admin/...`.",
        "",
        "## Questions",
        "",
        "1. Should I check siblings?",
        "",
      ].join("\n");
      expect(serializeDescription(parseDescription(desc))).toBe(desc);
    });

    it("preserves trailing newline absence", () => {
      const desc = "## Goals\n\nFix it.";
      expect(serializeDescription(parseDescription(desc))).toBe(desc);
    });

    it("preserves CRLF line endings", () => {
      const desc = "## Goals\r\n\r\nFix it.\r\n## Context\r\n\r\nWhatever.\r\n";
      const parsed = parseDescription(desc);
      expect(parsed.newline).toBe("\r\n");
      expect(serializeDescription(parsed)).toBe(desc);
    });
  });

  describe("getSection", () => {
    it("returns the section body when present", () => {
      const desc = "## Goals\n\nFix the typo.\n\n## Context\n\nFound it.\n";
      expect(getSection(desc, "Goals")).toBe("\nFix the typo.\n");
    });

    it("returns null when the section is absent", () => {
      const desc = "## Goals\n\nFix it.\n";
      expect(getSection(desc, "Context")).toBeNull();
    });

    it("returns null on an empty description", () => {
      expect(getSection("", "Goals")).toBeNull();
    });

    it("throws when given an unmanaged section name", () => {
      expect(() => getSection("", "Notes" as never)).toThrowError(
        /not a managed section/,
      );
    });
  });

  describe("updateSection — insert path", () => {
    it("appends a new section to an empty description", () => {
      const result = updateSection("", "Goals", "Fix the typo.");
      expect(result).toBe("\n## Goals\n\nFix the typo.\n");
    });

    it("appends a new section to a description with prelude only", () => {
      const desc = "Original human request body.\n";
      const result = updateSection(desc, "Goals", "Fix the typo.");
      expect(result).toBe(
        "Original human request body.\n\n## Goals\n\nFix the typo.\n",
      );
    });

    it("appends a new section after existing managed sections", () => {
      const desc = "## Goals\n\nFix it.\n";
      const result = updateSection(desc, "Context", "Found it.");
      expect(result).toBe(
        "## Goals\n\nFix it.\n\n## Context\n\nFound it.\n",
      );
    });

    it("does not double up blank lines if the prior section already ends with one", () => {
      const desc = "## Goals\n\nFix it.\n";
      const result = updateSection(desc, "Context", "Found it.");
      expect(result.split("\n\n## Context").length).toBe(2);
    });
  });

  describe("updateSection — replace path", () => {
    it("replaces an existing section's body", () => {
      const desc = "## Goals\n\nOld goal.\n";
      const result = updateSection(desc, "Goals", "New goal.");
      expect(result).toBe("## Goals\n\nNew goal.\n");
    });

    it("preserves the heading line verbatim (e.g., trailing whitespace)", () => {
      // Note: HEADING_RE allows trailing whitespace, so `## Goals   ` parses
      // as section "Goals" but the heading text retains its spaces.
      const desc = "## Goals   \n\nOld.\n";
      const result = updateSection(desc, "Goals", "New.");
      expect(result).toBe("## Goals   \n\nNew.\n");
    });

    it("preserves other sections when replacing one", () => {
      const desc =
        "## Goals\n\nFix it.\n\n## Context\n\nFound it.\n\n## Questions\n\n1. Why?\n";
      const result = updateSection(desc, "Context", "Refound it.");
      expect(result).toBe(
        "## Goals\n\nFix it.\n\n## Context\n\nRefound it.\n\n## Questions\n\n1. Why?\n",
      );
    });

    it("preserves human-written unmanaged sections", () => {
      const desc =
        "## Goals\n\nFix it.\n\n## Notes\n\nHuman wrote this.\n\n## Context\n\nFound it.\n";
      const result = updateSection(desc, "Goals", "Fix it differently.");
      expect(result).toContain("## Notes\n\nHuman wrote this.");
      expect(result).toContain("## Goals\n\nFix it differently.");
    });

    it("only updates the first match when duplicate sections exist", () => {
      // Edge case: a pre-helper agent might have written ## Goals twice.
      // The helper updates the first; the second is left alone for a human
      // to clean up.
      const desc = "## Goals\n\nFirst.\n\n## Goals\n\nSecond.\n";
      const result = updateSection(desc, "Goals", "Updated.");
      expect(result).toContain("## Goals\n\nUpdated.\n");
      expect(result).toContain("## Goals\n\nSecond.\n");
    });
  });

  describe("idempotency", () => {
    it("update of identical content is a fixed point", () => {
      const desc = "Original.\n";
      const once = updateSection(desc, "Goals", "Fix.");
      const twice = updateSection(once, "Goals", "Fix.");
      expect(twice).toBe(once);
    });

    it("repeated updates with different content always produce one section", () => {
      let desc = "Original.\n";
      desc = updateSection(desc, "Goals", "v1");
      desc = updateSection(desc, "Goals", "v2");
      desc = updateSection(desc, "Goals", "v3");
      const occurrences = desc.match(/^## Goals$/gm);
      expect(occurrences).toHaveLength(1);
      expect(getSection(desc, "Goals")?.trim()).toBe("v3");
    });
  });

  describe("removeSection", () => {
    it("removes the section and preserves siblings", () => {
      const desc =
        "## Goals\n\nFix it.\n\n## Context\n\nFound it.\n\n## Questions\n\n1. Why?\n";
      const result = removeSection(desc, "Context");
      expect(result).toBe(
        "## Goals\n\nFix it.\n\n## Questions\n\n1. Why?\n",
      );
    });

    it("returns the description unchanged when the section is absent", () => {
      const desc = "## Goals\n\nFix it.\n";
      expect(removeSection(desc, "Context")).toBe(desc);
    });
  });

  describe("listSections", () => {
    it("returns sections in document order", () => {
      const desc =
        "## Goals\n\nFix it.\n\n## Context\n\nFound it.\n\n## Questions\n\n1. Why?\n";
      const list = listSections(desc);
      expect(list.map((s) => s.name)).toEqual(["Goals", "Context", "Questions"]);
    });

    it("includes unmanaged sections (so callers can detect human input)", () => {
      const desc = "## Goals\n\nFix it.\n\n## Notes\n\nHuman.\n";
      const list = listSections(desc);
      expect(list.map((s) => s.name)).toContain("Notes");
    });

    it("returns an empty list for a prelude-only description", () => {
      expect(listSections("Just prose, no sections.\n")).toEqual([]);
    });
  });

  describe("interplay: prelude + sub-headings inside section bodies", () => {
    it("does not treat ### or #### as section boundaries", () => {
      const desc = [
        "## Implementation steps",
        "",
        "1. Step one.",
        "",
        "### Example",
        "",
        "```",
        "code",
        "```",
        "",
        "2. Step two.",
        "",
        "## Tests to pass",
        "",
        "pnpm test",
        "",
      ].join("\n");
      const steps = getSection(desc, "Implementation steps");
      expect(steps).toContain("### Example");
      expect(steps).toContain("Step two.");
      // Round-trip preserves the structure
      expect(serializeDescription(parseDescription(desc))).toBe(desc);
    });
  });

  describe("MANAGED_SECTIONS catalogue", () => {
    it("contains all 13 §8 specialist-owned sections", () => {
      // Snapshot — adding/removing should be a deliberate spec change.
      expect(MANAGED_SECTIONS).toEqual([
        "Goals",
        "Context",
        "Questions",
        "Scope",
        "Files to change",
        "Implementation steps",
        "Tests to pass",
        "Branch",
        "PR title + body",
        "Exit criteria",
        "PR validation report",
        "Release report",
        "Error",
      ]);
    });
  });

  describe("parseDecisionOverride", () => {
    it("returns null on an empty description", () => {
      expect(parseDecisionOverride("")).toBeNull();
    });

    it("returns null when no Decision line is present", () => {
      const desc = [
        "## PR validation report",
        "",
        "Iteration: 1 of 5 — clean.",
        "PR: foo/bar#1 (head abc1234)",
        "All checks green.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBeNull();
    });

    it("returns null on the default-path 'Advancing to Release.' line", () => {
      // Default state_transitions handles this — no override needed.
      const desc = [
        "## PR validation report",
        "",
        "Iteration: 1 of 5 — clean.",
        "Advancing to Release.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBeNull();
    });

    it("returns null on the default-path 'Advancing to Done.' line", () => {
      const desc = [
        "## Release report",
        "",
        "PR #1234 merged.",
        "Advancing to Done.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBeNull();
    });

    it("returns 'Pull request' on the bounce decision", () => {
      const desc = [
        "## PR validation report",
        "",
        "Iteration: 2 of 5 — bouncing back to Pull request.",
        "Bouncing to Pull request.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBe("Pull request");
    });

    // Regression (2026-05-07): the live PR validation specialist
    // emitted ONLY the natural-language form (no "Bouncing to Pull request."
    // strict line) — `"Iteration: 1 of 5 — bouncing back to Pull request."`.
    // The original strict regex `\bBouncing to Pull request\.?/i` rejected
    // this, the orchestrator missed the override, and PROJ-17 advanced to
    // Release per the default state_transitions instead of bouncing. The
    // regex was loosened to `\bBounc(?:e|ing)\b[^\n]*?\bto\s+Pull request`.
    it("returns 'Pull request' for the natural 'bouncing back to' phrasing alone (2026-05-07 regression)", () => {
      const desc = [
        "## PR validation report",
        "",
        "Iteration: 1 of 5 — bouncing back to Pull request.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBe("Pull request");
    });

    it("returns 'Error (manual)' on the cap escalation", () => {
      const desc = [
        "## Error",
        "",
        "PR validation iteration cap reached after 6 bounces.",
        "Escalating to Error (manual).",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBe("Error (manual)");
    });

    it("returns 'Error (manual)' on Release-error escalation", () => {
      const desc = [
        "## Error",
        "",
        "Main CI failed after squash-merge.",
        "Escalating to Error (manual).",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBe("Error (manual)");
    });

    it("accepts the legacy 'Escalated to Error (manual).' synonym", () => {
      // Earlier prompt drafts used "Escalated"; backward-compat regex.
      const desc = [
        "## PR validation report",
        "",
        "Iteration: 6 of 5 — cap reached.",
        "Escalated to Error (manual).",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBe("Error (manual)");
    });

    it("ignores Decision-like lines outside specialist report sections", () => {
      // A human's `## Notes` cannot redirect routing.
      const desc = [
        "## Notes",
        "",
        "I think the agent should be Bouncing to Pull request.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBeNull();
    });

    it("ignores Decision-like prose inside the same specialist section that doesn't match an exact line", () => {
      // We require the line to BE a decision line, not contain decision-ish words.
      const desc = [
        "## PR validation report",
        "",
        "While reviewing, I noticed the bouncing-checks variant might fail.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBeNull();
    });

    it("takes the LAST Decision line when multiple sections exist", () => {
      // Stale `## Error` next to a fresh `## PR validation report` — the last
      // section in document order wins (re-runs override earlier turns).
      const desc = [
        "## Error",
        "",
        "Old escalation.",
        "Escalating to Error (manual).",
        "",
        "## PR validation report",
        "",
        "Iteration: 2 of 5 — bouncing.",
        "Bouncing to Pull request.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBe("Pull request");
    });

    it("takes the LAST matching line within a single section", () => {
      // Should not happen on a well-formed turn, but guards against an
      // accidental dual-decision body — newest wins.
      const desc = [
        "## PR validation report",
        "",
        "Initial assessment: Advancing to Release.",
        "After re-check: Bouncing to Pull request.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBe("Pull request");
    });

    it("is case-insensitive on the Decision line phrasing", () => {
      const desc = [
        "## PR validation report",
        "",
        "BOUNCING TO PULL REQUEST.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBe("Pull request");
    });

    it("works when the Decision line is the only content in the section", () => {
      const desc = [
        "## PR validation report",
        "",
        "Bouncing to Pull request.",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBe("Pull request");
    });

    it("tolerates Decision lines without a trailing period", () => {
      // The regex makes the period optional so an LLM that drops it doesn't
      // misroute the ticket.
      const desc = [
        "## Error",
        "",
        "Escalating to Error (manual)",
        "",
      ].join("\n");
      expect(parseDecisionOverride(desc)).toBe("Error (manual)");
    });
  });
});
