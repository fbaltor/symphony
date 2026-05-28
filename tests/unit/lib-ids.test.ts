import { describe, expect, it } from "vitest";
import { composeSessionId, normalizeStateName, sanitizeIdentifier } from "../../src/lib/ids.js";

describe("lib/ids", () => {
  it("sanitizeIdentifier preserves [A-Za-z0-9._-] and replaces the rest", () => {
    expect(sanitizeIdentifier("ABC-1")).toBe("ABC-1");
    expect(sanitizeIdentifier("ABC.1_x")).toBe("ABC.1_x");
    expect(sanitizeIdentifier("ABC/1?")).toBe("ABC_1_");
    expect(sanitizeIdentifier("../etc/passwd")).toBe(".._etc_passwd");
  });

  it("composeSessionId joins with dash", () => {
    expect(composeSessionId("t", "u")).toBe("t-u");
  });

  it("normalizeStateName lowercases", () => {
    expect(normalizeStateName("In Progress")).toBe("in progress");
  });
});
