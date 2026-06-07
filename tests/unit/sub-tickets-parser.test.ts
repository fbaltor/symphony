import { describe, expect, it } from "vitest";
import {
  parseSubTickets,
  renderChildDescription,
  shouldInjectNoPrRequiredMarker,
} from "../../src/orchestrator/sub-tickets.js";

describe("parseSubTickets", () => {
  it("happy path — parses the canonical PROJ-444 5-sub-ticket layout", () => {
    const rfc = `## RFC

Some plan body. Files. Tests. Etc.

## Sub-tickets

1. **Schema for assignee column** — add nullable letterAssignee column to Letter
   Depends on: (none)
2. **Backend mutation** — expose updateLetterAssignee tRPC procedure
   Depends on: #1
3. **Frontend assignee picker UI** — dropdown bound to updateLetterAssignee
   Depends on: #2
4. **Migration backfill** — backfill assignee from owning attorney
   Depends on: #1
5. **Audit log entry** — emit AssigneeChanged audit row
   Depends on: #2
`;
    const parsed = parseSubTickets(rfc);
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toEqual({
      title: "Schema for assignee column",
      scope: "add nullable letterAssignee column to Letter",
      depsOnIndex: null,
    });
    expect(parsed[1]).toEqual({
      title: "Backend mutation",
      scope: "expose updateLetterAssignee tRPC procedure",
      depsOnIndex: 0,
    });
    expect(parsed[4]).toEqual({
      title: "Audit log entry",
      scope: "emit AssigneeChanged audit row",
      depsOnIndex: 1,
    });
  });

  it("returns [] when there's no Sub-tickets section", () => {
    const rfc = `## RFC

Just a plan, no decomposition needed.

## Test plan

Run the suite.`;
    expect(parseSubTickets(rfc)).toEqual([]);
  });

  it("malformed: missing Depends-on lines and bare title (no separator)", () => {
    const rfc = `## Sub-tickets

1. **Just a title with no scope**
2. **Another title** — with a real scope but no deps line
`;
    const parsed = parseSubTickets(rfc);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.title).toBe("Just a title with no scope");
    expect(parsed[0]?.scope).toBe("");
    expect(parsed[0]?.depsOnIndex).toBeNull();
    expect(parsed[1]).toEqual({
      title: "Another title",
      scope: "with a real scope but no deps line",
      depsOnIndex: null,
    });
  });

  it("malformed: section uses dashes/asterisks instead of numbers and varied separator", () => {
    const rfc = `## Sub-Tickets

- First thing -- short scope here
  Depends on: lol idk
- *Second thing* -- another scope
  Depends on: #1
* Third bare title
`;
    const parsed = parseSubTickets(rfc);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      title: "First thing",
      scope: "short scope here",
      depsOnIndex: null,
    });
    expect(parsed[1]).toEqual({
      title: "Second thing",
      scope: "another scope",
      depsOnIndex: 0,
    });
    expect(parsed[2]).toEqual({
      title: "Third bare title",
      scope: "",
      depsOnIndex: null,
    });
  });

  it("malformed: header is followed by prose then list — list still picked up", () => {
    const rfc = `## sub tickets

These are the tickets. Read them carefully.

1. **A** — alpha
2. **B** — beta
   Depends on: #1
`;
    const parsed = parseSubTickets(rfc);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.title.length).toBeGreaterThan(0);
    expect(parsed[1]?.title).toBe("B");
    expect(parsed[1]?.depsOnIndex).toBe(0);
  });

  it("malformed: section is empty or contains only the heading", () => {
    expect(parseSubTickets(`## Sub-tickets\n`)).toEqual([]);
    expect(parseSubTickets(`## Sub-tickets\n\n\n`)).toEqual([]);
    expect(parseSubTickets(`## Sub-tickets\n\n## Risks\n- something else`)).toEqual([]);
  });

  it("stops at the next heading and ignores later sections", () => {
    const rfc = `## Sub-tickets

1. **Only this one** — gets picked up

## Risks

1. **Not a sub-ticket** — this lives under Risks
`;
    const parsed = parseSubTickets(rfc);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.title).toBe("Only this one");
  });

  it("strips bold and italic markers from titles", () => {
    const rfc = `## Sub-tickets
- **bold title** — scope a
- *italic title* — scope b
- _underscore italic_ — scope c
`;
    const parsed = parseSubTickets(rfc);
    expect(parsed.map((p) => p.title)).toEqual(["bold title", "italic title", "underscore italic"]);
  });
});

describe("renderChildDescription", () => {
  it("includes scope and dependency block when both provided", () => {
    const body = renderChildDescription({
      parentIdentifier: "PROJ-444",
      scope: "add nullable letterAssignee column",
      depsOnTitle: "Schema for assignee column",
    });
    expect(body).toContain("Sub-ticket of **PROJ-444**");
    expect(body).toContain("## Scope");
    expect(body).toContain("add nullable letterAssignee column");
    expect(body).toContain("Depends on:** Schema for assignee column");
  });

  it("omits sections when their inputs are missing", () => {
    const body = renderChildDescription({
      parentIdentifier: "PROJ-444",
      scope: "",
      depsOnTitle: null,
    });
    expect(body).not.toContain("## Scope");
    expect(body).not.toContain("Depends on");
    expect(body).toContain("PROJ-444");
  });

  it("appends the no-pr-required marker when noPrRequired is true", () => {
    const body = renderChildDescription({
      parentIdentifier: "PROJ-444",
      scope: "redaction probe",
      depsOnTitle: null,
      noPrRequired: true,
    });
    expect(body).toContain("<!-- symphony:no-pr-required -->");
    // Marker must be at the end, not in the middle of normal content.
    expect(body.trimEnd().endsWith("<!-- symphony:no-pr-required -->")).toBe(true);
  });

  it("does NOT append the marker when noPrRequired is false / undefined", () => {
    const noFlag = renderChildDescription({
      parentIdentifier: "PROJ-444",
      scope: "real change",
      depsOnTitle: null,
    });
    const explicitFalse = renderChildDescription({
      parentIdentifier: "PROJ-444",
      scope: "real change",
      depsOnTitle: null,
      noPrRequired: false,
    });
    expect(noFlag).not.toContain("symphony:no-pr-required");
    expect(explicitFalse).not.toContain("symphony:no-pr-required");
  });
});

/**
 * Propagate `<!-- symphony:no-pr-required -->` from
 * behavioural-probe parents to their sub-tickets so the deliverable_missing
 * guard exempts them too. Without this propagation, multi-probe
 * test plans hit the deliverable-gate loop on every child.
 */
describe("shouldInjectNoPrRequiredMarker", () => {
  it("propagates when parent body contains the marker", () => {
    expect(
      shouldInjectNoPrRequiredMarker({
        title: "Add date period to facts",
        description: "Background … <!-- symphony:no-pr-required --> … rest",
      }),
    ).toBe(true);
  });

  it("propagates when parent title starts with [TEST]", () => {
    expect(
      shouldInjectNoPrRequiredMarker({
        title: "[TEST] sub-ticket gating",
        description: null,
      }),
    ).toBe(true);
  });

  it("propagates when parent title starts with [PROBE]", () => {
    expect(
      shouldInjectNoPrRequiredMarker({
        title: "[PROBE] redaction smoke",
        description: "no marker in body",
      }),
    ).toBe(true);
  });

  it("propagates with case-insensitive title prefix", () => {
    expect(
      shouldInjectNoPrRequiredMarker({
        title: "[test] lowercase prefix",
        description: null,
      }),
    ).toBe(true);
  });

  it("does NOT propagate for normal feature tickets", () => {
    expect(
      shouldInjectNoPrRequiredMarker({
        title: "Add date period to facts",
        description: "Background — feature work, real PR expected.",
      }),
    ).toBe(false);
  });

  it("does NOT propagate when description is null and title isn't a probe prefix", () => {
    expect(
      shouldInjectNoPrRequiredMarker({
        title: "Tighten up the legal-admin sidemenu",
        description: null,
      }),
    ).toBe(false);
  });

  it("does NOT propagate when 'TEST' appears mid-title (not as a leading bracket)", () => {
    expect(
      shouldInjectNoPrRequiredMarker({
        title: "Refactor TEST coverage for billing",
        description: null,
      }),
    ).toBe(false);
  });
});
