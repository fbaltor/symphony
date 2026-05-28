/**
 * Specialist Capability Matrix — encodes each kind of work Symphony does
 *
 * Goal — encode each "kind of work" Symphony does (analysis, planning,
 * writing code, delivering a PR) as a profile that declares:
 *
 *   - which Anthropic tools are needed (`tools`),
 *   - whether the agent must be allowed to write source files (`writes`),
 *   - which MCPs are appropriate (`mcps`),
 *   - one Rule-of-Two posture per stage (`untrustedInputs`,
 *     `sensitiveAccess`, `externalWrite`) so a future
 *     `assertRuleOfTwo(profile)` call can refuse to dispatch a state that
 *     simultaneously hits all three.
 *
 * For now, this module is **declarative only** — it doesn't yet gate the
 * orchestrator. The point of landing it early is:
 *
 *   1. We have a place to grow the matrix as we add more state-driven
 *      behaviors (per-state MCP allowlists, per-state turn budgets, ...).
 *   2. Invariant tests in `tests/unit/capability-matrix.test.ts` catch
 *      drift if a future contributor adds a profile and forgets a field.
 *   3. WORKFLOW.md doesn't have to change for existing deployments — the
 *      `agent.profile_by_state` field added below is optional.
 *
 * The Cerebro precedent (`SPECIALIST_CAPABILITY_MATRIX`) declares one
 * entry per specialist (research, plan, refinement, implementer, ops,
 * larry). Symphony's analogue is one entry per **canonical stage profile**
 * — multiple Linear states can map to the same profile via
 * `agent.profile_by_state`. That separates "what the work IS" from "what
 * the operator named the workflow column."
 */

/** Rule-of-Two property. `present: true` ⇒ the property is fully
 *  exercised by this profile and a deployment-level mitigation must be
 *  documented (or accepted as exception). */
export interface CapabilityEntry {
  readonly present: boolean;
  /** Free-text source — what specifically grants this property. */
  readonly source: string;
  /** Mitigations applied when `present: true`. Empty when `present: false`. */
  readonly mitigations: readonly string[];
}

export interface StateCapabilityProfile {
  /** Stable canonical key, kebab-case. Referenced from
   *  `agent.profileByState` in WORKFLOW.md. */
  readonly key: string;
  /** One-line operator-facing summary. */
  readonly summary: string;
  /** Anthropic tools needed in this stage. Used for `disallowedTools`
   *  in the Claude Agent SDK call. Empty ⇒ tools are unrestricted. */
  readonly allowedTools: readonly string[];
  /** Workspace subpaths the agent may write to. `undefined` ⇒ no
   *  per-stage restriction (default workspace-wide rule); `[]` ⇒ no
   *  file writes allowed at all. Mirrors the schema used by
   *  `agent.writeCwdsByState` (B-12). */
  readonly writeCwds: readonly string[] | undefined;
  /** MCP server names this stage uses. Drives a future `disallowedMcpServers`
   *  filter; today purely descriptive. */
  readonly mcps: readonly string[];
  /** Rule-of-Two: untrusted-input axis. */
  readonly untrustedInputs: CapabilityEntry;
  /** Rule-of-Two: sensitive-access axis (Bash, Read on credentials, ...) */
  readonly sensitiveAccess: CapabilityEntry;
  /** Rule-of-Two: external-write axis (Edit/Write/MultiEdit, network egress). */
  readonly externalWrite: CapabilityEntry;
  /** Required when all three Rule-of-Two axes are `present: true`. */
  readonly acceptedExceptionReason?: string;
}

/**
 * The matrix. Add a new profile here when Symphony grows a new kind of
 * stage. The invariant tests will refuse to compile / pass until each new
 * profile has all four Rule-of-Two fields populated.
 *
 * Today the matrix has three entries — one for the canonical Cerebro-style
 * pipeline phases (analysis-only, write-and-test, deliver-pr). Operators
 * map their Linear state names to these via WORKFLOW.md
 * `agent.profile_by_state`.
 */
export const STATE_CAPABILITY_PROFILES: Readonly<Record<string, StateCapabilityProfile>> = {
  "analysis-only": {
    key: "analysis-only",
    summary: "Read repo + write Linear comments. No file writes, no shell egress.",
    allowedTools: ["Read", "Grep", "Glob"],
    writeCwds: [], // explicit empty ⇒ no file writes
    mcps: ["linear", "linear_graphql"],
    untrustedInputs: {
      present: true,
      source: "user-authored Linear issue body + comments",
      mitigations: ["downstream Linear comment write is canary-scanned (when wired)"],
    },
    sensitiveAccess: {
      present: true,
      source: "Read tool on repo (no Bash, no shell)",
      mitigations: ["no Bash ⇒ no env-var exfil path"],
    },
    externalWrite: {
      present: false,
      source: "writeCwds: [] enforces zero Edit/Write/MultiEdit; no Bash either",
      mitigations: [],
    },
  },

  "write-and-test": {
    key: "write-and-test",
    summary:
      "Read + write source files in apps/ packages/ scripts/. Bash limited by canUseTool guard.",
    allowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "Bash"],
    writeCwds: ["apps", "packages", "scripts", "tests"],
    mcps: ["linear", "linear_graphql", "github"],
    untrustedInputs: {
      present: true,
      source: "user-authored Linear issue body + plan from previous stage",
      mitigations: ["B-9 secret redactor scans agent output before commit/push"],
    },
    sensitiveAccess: {
      present: true,
      source: "Read tool unbounded; Bash filtered by B-12 guard",
      mitigations: [
        "Self-edit lock blocks independent/symphony/* writes",
        "Bash patterns block sudo/curl/wget/nc/ssh/cd-root/rm-rf/fork-bomb",
      ],
    },
    externalWrite: {
      present: true,
      source: "Edit/Write/MultiEdit on workspace, plus git push via hooks",
      mitigations: [
        "writeCwds restricts blast radius to declared subdirectories",
        "after_run hook signs commits + opens PR (gated by GitHub branch protection)",
      ],
    },
    acceptedExceptionReason:
      "All three Rule-of-Two axes are intrinsic to 'an agent writing a PR' — the stage is unsafe to run on a multi-tenant workspace and is mitigated by per-issue ephemeral workspace + branch protection requiring human merge.",
  },

  "deliver-pr": {
    key: "deliver-pr",
    summary:
      "PR assembly only — squash commits, write PR description, post Linear comment. Tight write scope.",
    allowedTools: ["Read", "Grep", "Glob", "Edit", "Bash"],
    writeCwds: [], // no source edits — PR-time stage edits are via git commands
    mcps: ["linear", "linear_graphql", "github"],
    untrustedInputs: {
      present: true,
      source: "diff to be summarized + prior stage Linear comments",
      mitigations: ["B-9 secret redactor catches accidental key inclusion in PR description"],
    },
    sensitiveAccess: {
      present: true,
      source: "git via Bash; PR description posted to GitHub MCP",
      mitigations: [
        "Bash guard restricts dangerous patterns",
        "writeCwds: [] denies any source-file edits at this stage",
      ],
    },
    externalWrite: {
      present: false,
      source: "no Edit/Write/MultiEdit (writeCwds: []); only git operations via Bash",
      mitigations: [],
    },
  },
};

/**
 * Assert a profile entry is internally consistent. Called from invariant
 * tests + (future) from the orchestrator at startup to fail-fast on a
 * malformed matrix entry.
 */
export function assertProfileShape(profile: StateCapabilityProfile): void {
  if (!profile.key || profile.key.length === 0) {
    throw new Error("capability-matrix: profile missing key");
  }
  if (
    profile.untrustedInputs.present &&
    profile.untrustedInputs.mitigations.length === 0 &&
    profile.untrustedInputs.source.length === 0
  ) {
    throw new Error(`capability-matrix(${profile.key}): untrustedInputs present but no source`);
  }
  if (profile.sensitiveAccess.present && profile.sensitiveAccess.mitigations.length === 0) {
    throw new Error(
      `capability-matrix(${profile.key}): sensitiveAccess present but no mitigations`,
    );
  }
  if (profile.externalWrite.present && profile.externalWrite.mitigations.length === 0) {
    throw new Error(`capability-matrix(${profile.key}): externalWrite present but no mitigations`);
  }
  // Rule-of-Two: when all three are present, an accepted-exception reason is required.
  if (
    profile.untrustedInputs.present &&
    profile.sensitiveAccess.present &&
    profile.externalWrite.present &&
    !profile.acceptedExceptionReason
  ) {
    throw new Error(
      `capability-matrix(${profile.key}): Rule-of-Two violation — all three axes present without acceptedExceptionReason`,
    );
  }
}

/** Look up a profile by its canonical key. Returns undefined for unknown. */
export function getCapabilityProfile(key: string): StateCapabilityProfile | undefined {
  return STATE_CAPABILITY_PROFILES[key];
}
