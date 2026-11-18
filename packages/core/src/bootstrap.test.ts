import { describe, expect, it } from "vitest";
import { createBootstrap, parseBootstrap, type BootstrapV1 } from "./bootstrap.js";
import { attributesDigest } from "./context-input.js";

const STARTED_AT = "2026-01-01T00:00:00.000Z";

function valid(): BootstrapV1 {
  return {
    v: 1,
    generatedAt: "2026-10-01T12:00:00.000Z",
    units: { user: "u_1" },
    attributesDigest: attributesDigest({ plan: "pro" }),
    experiments: [
      {
        key: "checkout-copy",
        unitTypeKey: "user",
        unitId: "u_1",
        assignment: { variant: "treatment", startedAt: STARTED_AT },
      },
      {
        key: "pricing-page",
        unitTypeKey: "user",
        unitId: "u_1",
        assignment: {
          variant: "control",
          customValue: { headline: "Save 20%" },
          startedAt: STARTED_AT,
        },
        reason: "override",
        trackEnrollment: false,
      },
    ],
    holdouts: [
      {
        key: "h1",
        variant: "released",
        unitTypeKey: "user",
        startedAt: STARTED_AT,
        experimentKeys: ["checkout-copy"],
      },
    ],
    enrolled: ["checkout-copy"],
    enrolledHoldouts: ["h1"],
  };
}

describe("createBootstrap", () => {
  it("builds a version 1 bootstrap for the context", () => {
    const bootstrap = createBootstrap({
      units: { user: "u_1" },
      attributes: { plan: "pro" },
      experiments: valid().experiments,
      now: new Date("2026-10-01T12:00:00.000Z"),
    });

    expect(bootstrap).toEqual({
      v: 1,
      generatedAt: "2026-10-01T12:00:00.000Z",
      units: { user: "u_1" },
      attributesDigest: attributesDigest({ plan: "pro" }),
      experiments: valid().experiments,
    });
  });

  it("round-trips through JSON and parseBootstrap", () => {
    const { units, experiments, holdouts, generatedAt } = valid();
    const bootstrap = createBootstrap({
      units,
      experiments,
      holdouts,
      enrolled: new Set(["checkout-copy"]),
      now: new Date(generatedAt),
    });
    const parsed = parseBootstrap(JSON.parse(JSON.stringify(bootstrap)));

    expect(parsed).toEqual({ ok: true, value: bootstrap });
  });
});

describe("parseBootstrap", () => {
  it("accepts a valid bootstrap", () => {
    expect(parseBootstrap(valid())).toEqual({ ok: true, value: valid() });
  });

  it("ignores fields it doesn't know", () => {
    const withExtras = {
      ...valid(),
      futureField: { anything: true },
      experiments: valid().experiments.map((e) => ({ ...e, futureEntryField: 1 })),
    };
    expect(parseBootstrap(withExtras)).toEqual({ ok: true, value: valid() });
  });

  it.each<[string, unknown, RegExp]>([
    ["JSON text", JSON.stringify(valid()), /pass the parsed object/],
    ["null", null, /isn't an object/],
    ["a newer version", { ...valid(), v: 2 }, /version isn't supported/],
    ["no units", { ...valid(), units: undefined }, /units isn't an object/],
    ["no experiments", { ...valid(), experiments: null }, /experiments isn't an array/],
  ])("rejects %s with a reason", (_, input, reason) => {
    const result = parseBootstrap(input);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(reason);
  });
});
