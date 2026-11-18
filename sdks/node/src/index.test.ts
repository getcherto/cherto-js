import { describe, it, expect } from "vitest";
import { VERSION, ChertoClient, ChertoError, isChertoError } from "./index.js";
import pkg from "../package.json" with { type: "json" };

describe("@cherto/node", () => {
  it("exports VERSION matching package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("exports ChertoClient, ChertoError and isChertoError", () => {
    expect(ChertoClient.init).toBeTypeOf("function");
    expect(isChertoError(new ChertoError("network", "x"))).toBe(true);
  });
});
