import { describe, expect, it, vi } from "vitest";
import { copyJson, ifTypeMatches, paramOf } from "./values.js";

describe("paramOf", () => {
  it("reads own params, never inherited ones like toString", () => {
    const value = { color: "red" };
    expect(paramOf(value, "color")).toBe("red");
    expect(paramOf(value, "toString")).toBeUndefined();
    expect(paramOf(value, "constructor")).toBeUndefined();
    expect(paramOf(undefined, "color")).toBeUndefined();
  });
});

describe("copyJson", () => {
  it("copies nested objects and arrays", () => {
    const original = { a: { b: [1, { c: 2 }] } };
    const copy = copyJson(original);
    expect(copy).toEqual(original);
    (copy.a.b[1] as { c: number }).c = 3;
    expect(original.a.b[1]).toEqual({ c: 2 });
  });
});

describe("ifTypeMatches", () => {
  it("serves the value when a scalar default's type matches", () => {
    const warn = vi.fn();
    expect(ifTypeMatches("exp", "param", 3, 1, warn)).toBe(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("serves the default, with a warning, when it doesn't", () => {
    const warn = vi.fn();
    expect(ifTypeMatches("exp", 'param "size"', "big", 1, warn)).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      { experimentKey: "exp", expected: "number", actual: "string" },
      `param "size" doesn't match the type of the caller's default, serving the default`,
    );
  });

  it("trusts an object default", () => {
    expect(ifTypeMatches("exp", "value", [1], {}, vi.fn())).toEqual([1]);
  });
});
