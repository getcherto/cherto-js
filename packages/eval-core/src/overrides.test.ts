import { describe, it, expect, vi } from "vitest";
import { resolveOverride, type VariantOverride } from "./overrides.js";
import type { TargetingEnvelope } from "./types.js";

const noopWarn = () => {};

/** A single-group envelope matching one attribute equality. */
function groupEnvelope(attribute: string, value: string | boolean): TargetingEnvelope {
  return {
    version: 1,
    rules: [{ segmentId: null, clauses: [{ attribute, operator: "equals", values: [value] }] }],
  };
}

function unitOverride(
  id: string,
  unitTypeKey: string,
  unitId: string,
  variantKey: string,
  position = 0,
): VariantOverride {
  return { id, match: { type: "unit_id", unitTypeKey, unitId }, variantKey, position };
}

function groupOverride(
  id: string,
  targetingGroupId: string,
  targeting: TargetingEnvelope | null,
  variantKey: string,
  position = 0,
): VariantOverride {
  return {
    id,
    match: { type: "targeting_group", targetingGroupId, targeting },
    variantKey,
    position,
  };
}

/** The caller's units: `{}` when `unitId` is undefined. */
function units(unitTypeKey: string, unitId: string | undefined): Record<string, string> {
  return unitId === undefined ? {} : { [unitTypeKey]: unitId };
}

describe("resolveOverride with no overrides", () => {
  it("returns null for null, undefined, and an empty list", () => {
    expect(resolveOverride(null, units("user", "u_1"), undefined, noopWarn)).toBeNull();
    expect(resolveOverride(undefined, units("user", "u_1"), undefined, noopWarn)).toBeNull();
    expect(resolveOverride([], units("user", "u_1"), undefined, noopWarn)).toBeNull();
  });
});

describe("resolveOverride unit_id matching", () => {
  const overrides = [unitOverride("o1", "user", "u_qa", "treatment")];

  it("forces the variant for a matching unit type and id", () => {
    expect(resolveOverride(overrides, units("user", "u_qa"), undefined, noopWarn)).toEqual({
      overrideId: "o1",
      variantKey: "treatment",
    });
  });

  it("doesn't match a different unit id", () => {
    expect(resolveOverride(overrides, units("user", "u_other"), undefined, noopWarn)).toBeNull();
  });

  it("doesn't match the same id sent under another unit type", () => {
    expect(resolveOverride(overrides, units("account", "u_qa"), undefined, noopWarn)).toBeNull();
  });

  it("matches its unit type among several the caller sends", () => {
    const multi = { anonymousId: "a_1", user: "u_qa" };
    expect(resolveOverride(overrides, multi, undefined, noopWarn)).toEqual({
      overrideId: "o1",
      variantKey: "treatment",
    });
  });

  it("matches the unit id exactly, without trimming or case folding", () => {
    expect(resolveOverride(overrides, units("user", "U_QA"), undefined, noopWarn)).toBeNull();
    expect(resolveOverride(overrides, units("user", " u_qa "), undefined, noopWarn)).toBeNull();
  });
});

describe("resolveOverride targeting_group matching", () => {
  const staff = groupEnvelope("isStaff", true);
  const overrides = [groupOverride("o1", "tg_staff", staff, "treatment")];

  it("forces the variant when the attributes match the group", () => {
    expect(resolveOverride(overrides, units("user", "u_1"), { isStaff: true }, noopWarn)).toEqual({
      overrideId: "o1",
      variantKey: "treatment",
    });
  });

  it("doesn't force when the attributes don't match", () => {
    expect(
      resolveOverride(overrides, units("user", "u_1"), { isStaff: false }, noopWarn),
    ).toBeNull();
  });

  it("doesn't force a caller that sends no attributes", () => {
    expect(resolveOverride(overrides, units("user", "u_1"), undefined, noopWarn)).toBeNull();
  });

  it("forces a caller with no unit id when the attributes match", () => {
    expect(
      resolveOverride(overrides, units("user", undefined), { isStaff: true }, noopWarn),
    ).toEqual({
      overrideId: "o1",
      variantKey: "treatment",
    });
  });
});

// Sorting into priority order is the caller's job; resolveOverride never reorders.
describe("resolveOverride order", () => {
  it("takes the first match in array order", () => {
    const unit = unitOverride("o_unit", "user", "u_qa", "treatment", 0);
    const group = groupOverride(
      "o_group",
      "tg_staff",
      groupEnvelope("isStaff", true),
      "control",
      99,
    );
    const attrs = { isStaff: true };
    expect(resolveOverride([unit, group], units("user", "u_qa"), attrs, noopWarn)).toEqual({
      overrideId: "o_unit",
      variantKey: "treatment",
    });
    expect(resolveOverride([group, unit], units("user", "u_qa"), attrs, noopWarn)).toEqual({
      overrideId: "o_group",
      variantKey: "control",
    });
  });
});

describe("resolveOverride fails closed", () => {
  it("forces nobody, with a warning, for a group with no conditions", () => {
    const warn = vi.fn();
    const overrides = [groupOverride("o1", "tg_empty", { version: 1, rules: [] }, "treatment")];

    expect(resolveOverride(overrides, units("user", "u_1"), { isStaff: true }, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("ignores an unknown match type, with a warning", () => {
    const warn = vi.fn();
    const bogus = {
      id: "o1",
      match: { type: "ip_range", cidr: "10.0.0.0/8" },
      variantKey: "treatment",
      position: 0,
    } as unknown as VariantOverride;
    expect(resolveOverride([bogus], units("user", "u_1"), undefined, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
