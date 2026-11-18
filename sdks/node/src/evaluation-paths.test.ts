import { afterEach, describe, expect, it } from "vitest";
import { ChertoClient } from "./client.js";
import type { ConfigExperiment, ConfigHoldout } from "./types.js";

const STARTED_AT = "2026-03-01T00:00:00.000Z";

// Bucketing is deterministic: on these salts, unit-1 allocates to treatment, falls outside
// a 50% traffic gate and is held out; unit-2 allocates to treatment and passes both.
function experiment(overrides: Partial<ConfigExperiment> = {}): ConfigExperiment {
  return {
    key: "checkout-copy",
    status: "running",
    salt: "salt-alpha",
    startedAt: STARTED_AT,
    trafficPercentage: 100,
    unitTypeKey: "user",
    controlVariantKey: "control",
    variants: [
      { key: "control", allocationPercentage: 50 },
      { key: "treatment", allocationPercentage: 50 },
    ],
    ...overrides,
  };
}

const HOLDOUT: ConfigHoldout = {
  key: "q1-holdout",
  salt: "salt-hold",
  unitTypeKey: "user",
  percentage: 50,
  startedAt: "2026-02-01T00:00:00.000Z",
  experimentKeys: ["checkout-copy"],
};

const PREMIUM_ONLY = {
  version: 1,
  rules: [
    {
      segmentId: null,
      clauses: [{ attribute: "plan", operator: "equals" as const, values: ["premium"] }],
    },
  ],
};

const clients: ChertoClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function contextFor(
  config: { experiments: ConfigExperiment[]; holdouts?: ConfigHoldout[] },
  user: string,
  attributes?: Record<string, string>,
) {
  const client = await ChertoClient.init({
    serverKey: "",
    offline: true,
    initialConfig: { version: 1, configHash: "hash", ...config },
  });
  clients.push(client);
  return client.context({ units: { user }, attributes });
}

describe("evaluating an experiment", () => {
  it("assigns a unit the same variant on every read", async () => {
    const config = { experiments: [experiment()] };

    const first = await contextFor(config, "unit-1");
    const second = await contextFor(config, "unit-1");

    expect(first.getAssignmentDetail("checkout-copy")).toEqual({
      assignment: { variant: "treatment", startedAt: STARTED_AT },
      reason: "assigned",
    });
    expect(second.getAssignment("checkout-copy")).toEqual(first.getAssignment("checkout-copy"));
  });

  it("serves the assigned variant's custom value", async () => {
    const withValue = experiment({
      variants: [
        { key: "control", allocationPercentage: 50 },
        { key: "treatment", allocationPercentage: 50, customValue: { cta: "Buy now" } },
      ],
    });
    const ctx = await contextFor({ experiments: [withValue] }, "unit-1");

    expect(ctx.getVariantValue("checkout-copy", { cta: "Buy" })).toEqual({ cta: "Buy now" });
  });

  it("leaves out a unit the traffic percentage excludes", async () => {
    const config = { experiments: [experiment({ trafficPercentage: 50 })] };

    const excluded = await contextFor(config, "unit-1");
    const included = await contextFor(config, "unit-2");

    expect(excluded.getAssignmentDetail("checkout-copy")).toEqual({
      assignment: null,
      reason: "not_in_traffic",
    });
    expect(included.getAssignmentDetail("checkout-copy").reason).toBe("assigned");
  });

  it("leaves out a unit the targeting rules exclude", async () => {
    const config = { experiments: [experiment({ targeting: PREMIUM_ONLY })] };

    const free = await contextFor(config, "unit-1", { plan: "free" });
    const premium = await contextFor(config, "unit-1", { plan: "premium" });

    expect(free.getAssignmentDetail("checkout-copy")).toEqual({
      assignment: null,
      reason: "not_eligible",
    });
    expect(premium.getAssignmentDetail("checkout-copy").reason).toBe("assigned");
  });

  it("reports a context without the experiment's unit type", async () => {
    const config = { experiments: [experiment({ unitTypeKey: "company" })] };
    const ctx = await contextFor(config, "unit-1");

    expect(ctx.getAssignmentDetail("checkout-copy")).toEqual({
      assignment: null,
      reason: "unit_missing",
    });
  });

  it("serves nothing for an experiment that isn't running", async () => {
    const ctx = await contextFor({ experiments: [experiment({ status: "paused" })] }, "unit-1");

    expect(ctx.getAssignmentDetail("checkout-copy")).toEqual({
      assignment: null,
      reason: "not_running",
    });
    expect(ctx.getVariant("checkout-copy", "control")).toBe("control");
  });

  it("serves a concluded experiment's winner to everyone", async () => {
    const concluded = experiment({ status: "concluded", concludedVariant: "control" });
    const ctx = await contextFor({ experiments: [concluded] }, "unit-1");

    expect(ctx.getAssignmentDetail("checkout-copy")).toEqual({
      assignment: { variant: "control", startedAt: STARTED_AT },
      reason: "concluded",
    });
  });

  it("serves the variant an override forces, whatever the traffic", async () => {
    const forced = experiment({
      trafficPercentage: 0,
      variantOverrides: [
        {
          id: "qa",
          match: { type: "unit_id", unitTypeKey: "user", unitId: "unit-1" },
          variantKey: "control",
          position: 0,
        },
      ],
    });
    const ctx = await contextFor({ experiments: [forced] }, "unit-1");

    expect(ctx.getAssignmentDetail("checkout-copy")).toEqual({
      assignment: { variant: "control", startedAt: STARTED_AT },
      reason: "override",
    });
  });

  it("serves a held-out unit the control variant", async () => {
    const config = { experiments: [experiment()], holdouts: [HOLDOUT] };

    const heldOut = await contextFor(config, "unit-1");
    const released = await contextFor(config, "unit-2");

    expect(heldOut.getAssignmentDetail("checkout-copy")).toEqual({
      assignment: { variant: "control", startedAt: STARTED_AT },
      reason: "holdout",
    });
    expect(released.getAssignmentDetail("checkout-copy")).toEqual({
      assignment: { variant: "treatment", startedAt: STARTED_AT },
      reason: "assigned",
    });
  });
});
