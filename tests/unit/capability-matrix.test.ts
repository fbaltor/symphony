import { describe, expect, it } from "vitest";
import {
  STATE_CAPABILITY_PROFILES,
  assertProfileShape,
  getCapabilityProfile,
  type StateCapabilityProfile,
} from "../../src/agent/capability-matrix.js";

describe("capability matrix — B-10 invariants", () => {
  it("every profile passes assertProfileShape (full Rule-of-Two coverage)", () => {
    for (const profile of Object.values(STATE_CAPABILITY_PROFILES)) {
      expect(() => assertProfileShape(profile)).not.toThrow();
    }
  });

  it("every profile's `key` matches its Record key (typo-prevention)", () => {
    for (const [key, profile] of Object.entries(STATE_CAPABILITY_PROFILES)) {
      expect(profile.key).toBe(key);
    }
  });

  it("getCapabilityProfile returns the same object as the matrix lookup", () => {
    for (const key of Object.keys(STATE_CAPABILITY_PROFILES)) {
      const direct = STATE_CAPABILITY_PROFILES[key];
      const via = getCapabilityProfile(key);
      expect(via).toBe(direct);
    }
  });

  it("getCapabilityProfile returns undefined for unknown keys", () => {
    expect(getCapabilityProfile("absolutely-not-a-real-key")).toBeUndefined();
  });

  it("rejects malformed profiles — Rule-of-Two violation without exception reason", () => {
    const bad: StateCapabilityProfile = {
      key: "bad",
      summary: "all-three present without justification",
      allowedTools: [],
      writeCwds: undefined,
      mcps: [],
      untrustedInputs: { present: true, source: "x", mitigations: ["y"] },
      sensitiveAccess: { present: true, source: "x", mitigations: ["y"] },
      externalWrite: { present: true, source: "x", mitigations: ["y"] },
      // intentionally NO acceptedExceptionReason
    };
    expect(() => assertProfileShape(bad)).toThrow(/Rule-of-Two violation/);
  });

  it("rejects profiles where externalWrite=true has no mitigations", () => {
    const bad: StateCapabilityProfile = {
      key: "no-mitigation",
      summary: "external write without mitigations",
      allowedTools: [],
      writeCwds: undefined,
      mcps: [],
      untrustedInputs: { present: false, source: "", mitigations: [] },
      sensitiveAccess: { present: false, source: "", mitigations: [] },
      externalWrite: { present: true, source: "Edit/Write", mitigations: [] },
    };
    expect(() => assertProfileShape(bad)).toThrow(/externalWrite present but no mitigations/);
  });

  it("write-and-test carries the only accepted Rule-of-Two exception", () => {
    const profile = STATE_CAPABILITY_PROFILES["write-and-test"];
    expect(profile?.acceptedExceptionReason).toBeTruthy();
    // analysis-only must NOT have all three axes ⇒ no reason needed.
    const analysis = STATE_CAPABILITY_PROFILES["analysis-only"];
    expect(analysis?.externalWrite.present).toBe(false);
  });
});
