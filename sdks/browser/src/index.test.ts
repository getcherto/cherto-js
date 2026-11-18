import { describe, expect, expectTypeOf, it } from "vitest";
import * as browser from "./index.js";
import { ChertoClient, ChertoError, VERSION, isChertoError } from "./index.js";
import type {
  ChertoAssignment,
  ChertoAssignmentDetail,
  ChertoBootstrap,
  ChertoClientOptions,
  ChertoClientStatus,
  ChertoContextInput,
  ChertoEnrollmentEvent,
  ChertoInitResult,
} from "./index.js";
import pkg from "../package.json" with { type: "json" };

describe("@cherto/browser", () => {
  it("exports VERSION matching package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("exports exactly its public values", () => {
    expect(Object.keys(browser).sort()).toEqual([
      "ChertoClient",
      "ChertoError",
      "VERSION",
      "isChertoError",
    ]);
    expect(isChertoError(new ChertoError("network", "x"))).toBe(true);
    expect(ChertoClient).toBeTypeOf("function");
  });

  it("exports its public types", () => {
    expectTypeOf<
      [
        ChertoAssignment,
        ChertoAssignmentDetail,
        ChertoBootstrap,
        ChertoClientOptions,
        ChertoClientStatus,
        ChertoContextInput,
        ChertoEnrollmentEvent,
        ChertoInitResult,
      ]
    >().not.toBeAny();
  });
});
