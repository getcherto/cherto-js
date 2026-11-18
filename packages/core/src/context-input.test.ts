import { describe, expect, it, vi } from "vitest";
import {
  attributesDigest,
  normalizeAttributes,
  normalizeContext,
  normalizeUnits,
} from "./context-input.js";

describe("normalizeUnits", () => {
  it("keeps string ids and converts integers and bigints to strings", () => {
    const warn = vi.fn();
    const units = normalizeUnits({ user: "u_1", account: 42, org: 12345678901234567890n }, warn);

    expect({ ...units }).toEqual({ user: "u_1", account: "42", org: "12345678901234567890" });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY])(
    "drops a number id of %s, which isn't a safe integer",
    (id) => {
      const warn = vi.fn();
      expect({ ...normalizeUnits({ user: id }, warn) }).toEqual({});
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        { unitTypeKey: "user" },
        'unit id for "user" is a number that isn\'t a safe integer, treating the unit as ' +
          "absent; pass the id as a string",
      );
    },
  );

  it.each([null, ""])("drops an empty id (%j) with a warning", (id) => {
    const warn = vi.fn();
    expect({ ...normalizeUnits({ user: id }, warn) }).toEqual({});
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { unitTypeKey: "user" },
      'unit id for "user" is empty, treating the unit as absent',
    );
  });
});

describe("normalizeAttributes", () => {
  it("keeps strings, finite numbers and booleans", () => {
    const warn = vi.fn();
    const attributes = normalizeAttributes({ plan: "pro", seats: 3, beta: false }, warn);

    expect({ ...attributes }).toEqual({ plan: "pro", seats: 3, beta: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null, "null"],
    ["NaN", Number.NaN, "number"],
    ["Infinity", Number.POSITIVE_INFINITY, "number"],
    ["an array", ["a"], "array"],
    ["an object", { a: 1 }, "object"],
    ["a Date", new Date(0), "object"],
  ])("drops %s with a warning naming its type", (_, value, type) => {
    const warn = vi.fn();
    expect({ ...normalizeAttributes({ secret: value }, warn) }).toEqual({});
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { attribute: "secret", type },
      'attribute "secret" isn\'t a string, finite number or boolean, treating it as absent',
    );
  });

  it("returns undefined for absent attributes", () => {
    expect(normalizeAttributes(undefined, vi.fn())).toBeUndefined();
    expect(normalizeAttributes(null, vi.fn())).toBeUndefined();
  });
});

describe("normalizeContext", () => {
  it("treats a non-object context as empty, with a warning", () => {
    const warn = vi.fn();
    const context = normalizeContext("u_1", warn);
    expect({ ...context.units }).toEqual({});
    expect(context.attributes).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { type: "string" },
      "context must be an object with units, treating it as empty",
    );
  });
});

describe("attributesDigest", () => {
  const of = (attributes: unknown) => attributesDigest(normalizeAttributes(attributes, vi.fn()));

  it("ignores key order and treats no attributes like empty ones", () => {
    expect(of({ x: 1, y: true })).toBe(of({ y: true, x: 1 }));
    expect(of(undefined)).toBe(of({}));
    expect(of({ x: undefined })).toBe(of({}));
  });

  it("keeps a string apart from a number, and one value apart from another", () => {
    expect(of({ n: 1 })).not.toBe(of({ n: "1" }));
    expect(of({ plan: "free" })).not.toBe(of({ plan: "premium" }));
  });
});
