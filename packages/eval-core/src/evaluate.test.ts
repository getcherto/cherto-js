import { describe, it, expect } from "vitest";
import {
  evaluateExperiment,
  experimentProblem,
  problemErrorCode,
  resolveHoldouts,
  type EvaluationPolicy,
  type ExperimentSpec,
  type HoldoutSpec,
} from "./evaluate.js";
import {
  evaluationCases,
  expectationsFor,
  type EvaluationCase,
  type ExpectedEvaluation,
  type ExpectedHoldout,
} from "./conformance.js";
import type { VariantOverride } from "./overrides.js";

const OPEN: EvaluationPolicy = { failClosed: false };
const CLOSED: EvaluationPolicy = { failClosed: true };

/** Evaluates a shared case the way a reader does, in the shape its expectations use. */
function run(testCase: EvaluationCase, policy: EvaluationPolicy) {
  const holdouts = resolveHoldouts(
    testCase.holdouts as unknown as HoldoutSpec[] | undefined,
    testCase.units,
    policy,
  );
  const input = { units: testCase.units, attributes: testCase.attributes, holdouts };
  const experiments: Record<string, ExpectedEvaluation> = {};
  const exposures: Record<string, ExpectedHoldout> = Object.fromEntries(
    holdouts.arms.map(({ holdout, arm }) => [holdout.key, { arm, exposures: [] }]),
  );

  for (const exp of testCase.experiments as unknown as ExperimentSpec[]) {
    const result = evaluateExperiment(exp, input, policy);
    experiments[exp.key] = {
      variant: result.variantKey,
      reason: result.reason,
      ...(result.errorCode !== undefined && { errorCode: result.errorCode }),
      ...(result.variantKey !== null && !result.trackEnrollment && { trackEnrollment: false }),
    };
    for (const { holdout } of result.exposedHoldouts)
      exposures[holdout.key]!.exposures.push(exp.key);
  }
  for (const holdout of Object.values(exposures)) holdout.exposures.sort();

  return { experiments, holdouts: exposures };
}

describe.each([OPEN, CLOSED])("shared evaluation cases, failClosed: $failClosed", (policy) => {
  it.each(evaluationCases)("$name", (testCase) => {
    expect(run(testCase, policy)).toEqual(expectationsFor(testCase, policy.failClosed));
  });
});

// unit-1 allocates treatment on `salt-alpha`, falls outside a 50% traffic gate, and is held
// out by a 50% holdout on `salt-hold`; unit-2 is released by it.
function exp(overrides: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    key: "exp-a",
    status: "running",
    salt: "salt-alpha",
    trafficPercentage: 100,
    unitTypeKey: "user",
    variants: [
      { key: "control", allocationPercentage: 50 },
      { key: "treatment", allocationPercentage: 50 },
    ],
    ...overrides,
  };
}

function holdout(overrides: Partial<HoldoutSpec> = {}): HoldoutSpec {
  return {
    key: "hold-a",
    salt: "salt-hold",
    unitTypeKey: "user",
    percentage: 50,
    experimentKeys: ["exp-a"],
    ...overrides,
  };
}

const PREMIUM = {
  version: 1,
  rules: [
    {
      segmentId: null,
      clauses: [{ attribute: "plan", operator: "equals" as const, values: ["premium"] }],
    },
  ],
};

const forceUnit1 = (variantKey: string): VariantOverride => ({
  id: "ovr-1",
  match: { type: "unit_id", unitTypeKey: "user", unitId: "unit-1" },
  variantKey,
  position: 0,
});

describe("evaluateExperiment", () => {
  const units = { user: "unit-1" };

  it.each<[string, Partial<ExperimentSpec>, string | null, string]>([
    ["assigns a variant by hash", {}, "treatment", "assigned"],
    ["skips a unit outside the traffic gate", { trafficPercentage: 50 }, null, "not_in_traffic"],
    ["skips a unit the targeting doesn't match", { targeting: PREMIUM }, null, "not_eligible"],
    [
      "skips an experiment on a unit type not sent",
      { unitTypeKey: "company" },
      null,
      "unit_missing",
    ],
    ["skips a draft", { status: "draft" }, null, "not_running"],
    [
      "serves a concluded experiment's winner",
      { status: "concluded", concludedVariant: "control" },
      "control",
      "concluded",
    ],
  ])("%s", (_, overrides, variantKey, reason) => {
    const result = evaluateExperiment(
      exp(overrides),
      { units, attributes: { plan: "free" } },
      OPEN,
    );

    expect(result).toMatchObject({ variantKey, reason });
  });

  it("reports the override that forced a variant", () => {
    expect(
      evaluateExperiment(exp({ variantOverrides: [forceUnit1("control")] }), { units }, OPEN),
    ).toEqual({
      variantKey: "control",
      reason: "override",
      overrideId: "ovr-1",
      trackEnrollment: false,
      exposedHoldouts: [],
      warnings: [],
    });
  });

  it("serves control to a held-out unit and names the holdout", () => {
    const holdouts = resolveHoldouts([holdout()], units, OPEN);
    const result = evaluateExperiment(
      exp({ controlVariantKey: "control" }),
      { units, holdouts },
      OPEN,
    );
    expect(result).toMatchObject({
      variantKey: "control",
      reason: "holdout",
      holdoutKey: "hold-a",
    });
    expect(result.exposedHoldouts).toEqual([holdouts.arms[0]]);
  });
});

describe("resolveHoldouts", () => {
  it("hashes each holdout whose unit is present, in order", () => {
    const resolved = resolveHoldouts(
      [holdout(), holdout({ key: "hold-b", unitTypeKey: "company" }), holdout({ key: "hold-c" })],
      { user: "unit-2" },
      OPEN,
    );
    expect(resolved.arms.map(({ holdout: h, arm }) => [h.key, arm])).toEqual([
      ["hold-a", "released"],
      ["hold-c", "released"],
    ]);
    expect(resolved.warnings).toEqual([]);
  });
});

describe("experimentProblem", () => {
  it("accepts what it can serve", () => {
    expect(experimentProblem(exp())).toBeNull();
    expect(experimentProblem(exp({ status: "draft", salt: "", variants: [] }))).toBeNull();
    expect(
      experimentProblem(exp({ status: "concluded", concludedVariant: "control", salt: null })),
    ).toBeNull();
  });

  it("maps a problem to its error code", () => {
    expect(problemErrorCode({ code: "unsupported_targeting" })).toBe("unsupported");
    expect(problemErrorCode({ code: "missing_salt" })).toBe("invalid_experiment");
    expect(problemErrorCode({ code: "malformed_holdout" })).toBe("invalid_experiment");
  });
});
