import { describe, it, expect, vi } from "vitest";
import { ChertoClient } from "./client.js";
import { MOCK_CONFIG, closeClientsAfterEach, stubFetch, wireOf } from "./test-helpers.js";

closeClientsAfterEach();

const STARTED_AT = "1970-01-01T00:00:00.000Z";
const USER = { units: { user: "u_1" } };
const COMPANY = { units: { company: "c_1" } };

/** A client serving MOCK_CONFIG that records no enrollment. */
async function initClient() {
  vi.stubGlobal("fetch", stubFetch(MOCK_CONFIG));
  const logger = { warn: vi.fn(), error: vi.fn() };
  const client = await ChertoClient.init({
    serverKey: "sk_test",
    enrollmentTracking: { mode: "none" },
    logger,
  });
  return { client, logger };
}

describe("getVariant", () => {
  it("returns the assigned variant key", async () => {
    const { client } = await initClient();

    expect(client.context(USER).getVariant("concluded-exp", "control")).toBe("treatment");
  });

  it("returns the default when there is no assignment", async () => {
    const { client } = await initClient();

    expect(client.context(COMPANY).getVariant("checkout-copy", "control")).toBe("control");
  });
});

describe("getVariantValue", () => {
  it("returns the variant's custom value", async () => {
    const { client } = await initClient();

    const value = client.context(USER).getVariantValue("concluded-exp", { theme: "default" });

    expect(value).toEqual({ theme: "dark" });
  });

  it("returns the default when there is no assignment", async () => {
    const { client } = await initClient();

    const value = client.context(COMPANY).getVariantValue("checkout-copy", { theme: "default" });

    expect(value).toEqual({ theme: "default" });
  });
});

describe("getVariantParam", () => {
  it("returns one param of the custom value", async () => {
    const { client } = await initClient();

    expect(client.context(USER).getVariantParam("concluded-exp", "theme", "default")).toBe("dark");
  });

  it("returns the default for a param the value doesn't have", async () => {
    const { client } = await initClient();

    const param = client.context(USER).getVariantParam("concluded-exp", "no-such-param", "none");

    expect(param).toBe("none");
  });

  it("returns the default, with a warning, when the param's type differs from it", async () => {
    const { client, logger } = await initClient();

    expect(client.context(USER).getVariantParam("concluded-exp", "theme", 5)).toBe(5);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "[cherto] param \"theme\" doesn't match the type of the caller's default, serving the default",
      expect.objectContaining({ experimentKey: "concluded-exp", expected: "number" }),
    );
  });
});

describe("getAssignment", () => {
  it("returns the unit's assignment", async () => {
    const { client } = await initClient();

    expect(client.context(USER).getAssignment("checkout-copy")).toEqual({
      variant: "control",
      startedAt: STARTED_AT,
    });
  });

  it.each([
    ["an unknown experiment", "no-such-exp", USER],
    ["an absent unit type", "checkout-copy", COMPANY],
    ["a unit targeting excludes", "premium-banner", { ...COMPANY, attributes: { plan: "free" } }],
  ])("returns null for %s", async (_label, key, input) => {
    const { client } = await initClient();

    expect(client.context(input).getAssignment(key)).toBeNull();
  });

  it("returns a concluded experiment's winner with its custom value", async () => {
    const { client } = await initClient();

    expect(client.context(USER).getAssignment("concluded-exp")).toEqual({
      variant: "treatment",
      startedAt: STARTED_AT,
      customValue: { theme: "dark" },
    });
  });
});

describe("getAllAssignments", () => {
  it("returns every assignment, keyed by experiment", async () => {
    const { client } = await initClient();
    const ctx = client.context({
      units: { user: "u_1", company: "c_1" },
      attributes: { plan: "premium" },
    });

    expect(ctx.getAllAssignments()).toEqual({
      "checkout-copy": { variant: "control", startedAt: STARTED_AT },
      "premium-banner": { variant: "treatment", startedAt: STARTED_AT },
      "concluded-exp": {
        variant: "treatment",
        startedAt: STARTED_AT,
        customValue: { theme: "dark" },
      },
    });
  });

  it("omits experiments the context has no assignment for", async () => {
    const { client } = await initClient();

    const all = client.context(USER).getAllAssignments();

    expect(Object.keys(all)).toEqual(["checkout-copy", "concluded-exp"]);
  });
});

describe("getAssignmentDetail", () => {
  it.each([
    ["assigned", "checkout-copy", USER],
    ["concluded", "concluded-exp", USER],
    ["not_eligible", "premium-banner", USER],
    ["unit_missing", "checkout-copy", COMPANY],
    ["unknown_experiment", "no-such-exp", USER],
  ])("pairs the assignment with the reason %s", async (reason, key, input) => {
    const { client } = await initClient();
    const ctx = client.context(input);

    expect(ctx.getAssignmentDetail(key)).toEqual({ assignment: ctx.getAssignment(key), reason });
  });

  it("reports not_ready before the client has a config", async () => {
    const client = await ChertoClient.init({ serverKey: "", offline: true });

    expect(client.context(USER).getAssignmentDetail("checkout-copy")).toEqual({
      assignment: null,
      reason: "not_ready",
    });
  });
});

describe("getBootstrap", () => {
  it("is plain JSON with the context's units and when it was generated", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00.000Z"), toFake: ["Date"] });
    const { client } = await initClient();

    const bootstrap = wireOf(client.context({ units: { user: 42, device: undefined } }));

    expect(bootstrap.v).toBe(1);
    expect(bootstrap.generatedAt).toBe("2026-10-01T12:00:00.000Z");
    expect(bootstrap.units).toEqual({ user: "42" });
    expect(JSON.parse(JSON.stringify(bootstrap))).toEqual(bootstrap);
  });

  it("includes every assignment with its unit id", async () => {
    const { client } = await initClient();

    const bootstrap = wireOf(client.context(USER));

    expect(bootstrap.experiments.map((e) => [e.key, e.unitId])).toEqual([
      ["checkout-copy", "u_1"],
      ["concluded-exp", "u_1"],
    ]);
  });
});
