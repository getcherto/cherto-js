import { describe, it, expect, vi } from "vitest";
import { experimentsByKey, parseConfig } from "./config.js";

const experiment = {
  key: "checkout-copy",
  status: "running",
  salt: "s",
  trafficPercentage: 100,
  unitTypeKey: "user",
  variants: [{ key: "control", allocationPercentage: 100 }],
};

const holdout = {
  key: "h1",
  salt: "s",
  unitTypeKey: "user",
  percentage: 5,
  startedAt: "2026-06-01T00:00:00.000Z",
  experimentKeys: ["checkout-copy"],
};

describe("parseConfig", () => {
  it("passes a well-formed config through", () => {
    const body = { version: 3, configHash: "abc", experiments: [experiment], holdouts: [holdout] };
    expect(parseConfig(body, vi.fn())).toEqual(body);
  });

  it.each([
    ["a non-object body", 42],
    ["a body with no experiments", { version: 2 }],
    ["a non-array experiments field", { version: 2, experiments: { key: "x" } }],
  ])("rejects %s as `bad_response`", (_, body) => {
    expect(() => parseConfig(body, vi.fn())).toThrow(
      expect.objectContaining({ name: "ChertoError", code: "bad_response" }),
    );
  });

  it("drops a malformed experiment with a warning and keeps the rest", () => {
    const warn = vi.fn();
    const config = parseConfig({ experiments: [{ ...experiment, key: "" }, experiment] }, warn);

    expect(config.experiments).toEqual([experiment]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ index: 0 }),
      "dropping a malformed experiment",
    );
  });
});

describe("parseConfig: invalid experiments", () => {
  it.each([
    [
      "a concluded experiment with no winner",
      { status: "concluded" },
      "concluded experiment names no winning variant, skipping it",
    ],
    [
      "a running experiment with no salt",
      { salt: undefined },
      "experiment has no bucketing salt, skipping it",
    ],
    [
      "allocations that sum to 60",
      {
        variants: [
          { key: "control", allocationPercentage: 30 },
          { key: "treatment", allocationPercentage: 30 },
        ],
      },
      "experiment's variant allocations don't sum to 100, skipping it",
    ],
  ])("skips %s, and warns", (_, overrides, message) => {
    const warn = vi.fn();
    const config = parseConfig({ experiments: [{ ...experiment, ...overrides }] }, warn);

    expect(config.experiments).toEqual([]);
    expect(config.skipped).toEqual(new Map([["checkout-copy", "invalid_experiment"]]));
    expect(warn).toHaveBeenCalledExactlyOnceWith({ experimentKey: "checkout-copy" }, message);
  });
});

describe("parseConfig: unsupported experiments", () => {
  const clause = { attribute: "plan", operator: "equals", values: ["pro"] };
  const targeting = (overrides: Record<string, unknown> = {}, version = 1) => ({
    version,
    rules: [{ segmentId: null, clauses: [{ ...clause, ...overrides }] }],
  });

  it.each([
    ["an unsupported envelope version", { targeting: targeting({}, 2) }],
    ["an unknown valueKind", { targeting: targeting({ operator: "notIn", valueKind: "geo" }) }],
    ["an unknown operator", { targeting: targeting({ operator: "startsWith" }) }],
  ])("skips an experiment whose targeting has %s", (_, overrides) => {
    const warn = vi.fn();
    const config = parseConfig({ experiments: [{ ...experiment, ...overrides }] }, warn);

    expect(config.experiments).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { experimentKey: "checkout-copy" },
      "experiment's targeting uses rules this SDK version can't evaluate, skipping it",
    );
  });

  it("skips an experiment with an unknown status", () => {
    const warn = vi.fn();
    const config = parseConfig({ experiments: [{ ...experiment, status: "ramping" }] }, warn);

    expect(config.experiments).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { experimentKey: "checkout-copy", status: "ramping" },
      "experiment has a status this SDK version doesn't support, skipping it",
    );
  });
});

describe("experimentsByKey", () => {
  it("indexes a config's experiments by key, once", () => {
    const other = { ...experiment, key: "other" };
    const config = parseConfig({ experiments: [experiment, other] }, vi.fn());
    const index = experimentsByKey(config);

    expect(experimentsByKey(config)).toBe(index);
    expect(index).toEqual(
      new Map([
        ["checkout-copy", experiment],
        ["other", other],
      ]),
    );
  });
});
