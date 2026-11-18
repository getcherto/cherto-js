import { describe, it, expect } from "vitest";
import { parseSemver, compareSemver } from "./semver.js";

describe("parseSemver", () => {
  it("parses core versions, defaulting missing segments to 0", () => {
    expect(parseSemver("1.2.3")).toEqual({ main: [1, 2, 3], pre: null });
    expect(parseSemver("1.2")).toEqual({ main: [1, 2, 0], pre: null });
    expect(parseSemver("1")).toEqual({ main: [1, 0, 0], pre: null });
    expect(parseSemver("v2.0.0")).toEqual({ main: [2, 0, 0], pre: null });
  });

  it("captures prerelease and drops build metadata", () => {
    expect(parseSemver("1.0.0-rc.1")).toEqual({ main: [1, 0, 0], pre: ["rc", "1"] });
    expect(parseSemver("1.0.0+build.5")).toEqual({ main: [1, 0, 0], pre: null });
    expect(parseSemver("1.0.0-alpha+exp")).toEqual({ main: [1, 0, 0], pre: ["alpha"] });
  });

  it("rejects unparseable input", () => {
    for (const bad of ["", "  ", "abc", "1.2.3.4", "1.x", "1..2", "1.0.0-", 5, true, null]) {
      expect(parseSemver(bad)).toBeNull();
    }
  });
});

describe("compareSemver", () => {
  it("orders by numeric core precedence, not lexically", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemver("2.0.0", "10.0.0")).toBe(-1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
  });

  it("ranks a prerelease below its release", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("orders prereleases by their identifiers", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });

  it("returns null when either side is unparseable", () => {
    expect(compareSemver("1.0.0", "nope")).toBeNull();
    expect(compareSemver("nope", "1.0.0")).toBeNull();
  });
});
