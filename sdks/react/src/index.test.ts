import { describe, it, expect } from "vitest";
import * as react from "./index.js";
import pkg from "../package.json" with { type: "json" };

describe("@cherto/react", () => {
  it("exports VERSION matching package.json", () => {
    expect(react.VERSION).toBe(pkg.version);
  });

  it("exports exactly its public values", () => {
    expect(Object.keys(react).sort()).toEqual([
      "ChertoProvider",
      "VERSION",
      "useChertoAssignment",
      "useChertoClient",
      "useChertoVariant",
      "useChertoVariantParam",
      "useChertoVariantValue",
    ]);
  });
});
