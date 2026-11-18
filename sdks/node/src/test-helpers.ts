import type { BootstrapV1, ChertoContext } from "@cherto/core";
import { afterEach, beforeEach, vi, type Mock } from "vitest";
import { ChertoClient } from "./client.js";
import type { Config } from "./types.js";

/**
 * Three experiments: `checkout-copy` (running, per user), `premium-banner` (running, per
 * company, premium plans only) and `concluded-exp` (concluded on `treatment`).
 */
export const MOCK_CONFIG: Config = {
  version: 7,
  configHash: "deadbeef",
  experiments: [
    {
      key: "checkout-copy",
      status: "running",
      salt: "org:checkout-copy",
      trafficPercentage: 100,
      unitTypeKey: "user",
      variants: [
        { key: "control", allocationPercentage: 50 },
        { key: "treatment", allocationPercentage: 50 },
      ],
    },
    {
      key: "premium-banner",
      status: "running",
      salt: "org:premium-banner",
      trafficPercentage: 100,
      unitTypeKey: "company",
      targeting: {
        version: 1,
        rules: [
          {
            segmentId: null,
            clauses: [{ attribute: "plan", operator: "equals", values: ["premium"] }],
          },
        ],
      },
      variants: [
        { key: "control", allocationPercentage: 50 },
        { key: "treatment", allocationPercentage: 50 },
      ],
    },
    {
      key: "concluded-exp",
      status: "concluded",
      concludedVariant: "treatment",
      salt: "org:concluded-exp",
      trafficPercentage: 50,
      unitTypeKey: "user",
      variants: [
        { key: "control", allocationPercentage: 50, customValue: { theme: "default" } },
        { key: "treatment", allocationPercentage: 50, customValue: { theme: "dark" } },
      ],
    },
  ],
};

/** `forced-exp` has no traffic, so only its override for user `u_qa` assigns anyone. */
export const OVERRIDE_CONFIG: Config = {
  version: 8,
  configHash: "cafebabe",
  experiments: [
    {
      key: "forced-exp",
      status: "running",
      salt: "org:forced-exp",
      trafficPercentage: 0,
      unitTypeKey: "user",
      variantOverrides: [
        {
          id: "ovr-1",
          match: { type: "unit_id", unitTypeKey: "user", unitId: "u_qa" },
          variantKey: "treatment",
          position: 0,
        },
      ],
      variants: [
        { key: "control", allocationPercentage: 50 },
        { key: "treatment", allocationPercentage: 50 },
      ],
    },
  ],
};

/** MOCK_CONFIG with a 5% holdout over `checkout-copy` and `concluded-exp`. */
export const CONFIG_WITH_HOLDOUT: Config = {
  ...MOCK_CONFIG,
  experiments: MOCK_CONFIG.experiments.map((exp) =>
    exp.key === "checkout-copy" || exp.key === "concluded-exp"
      ? { ...exp, controlVariantKey: "control" }
      : exp,
  ),
  holdouts: [
    {
      key: "h2-holdout",
      salt: "002a000000000000",
      unitTypeKey: "user",
      percentage: 5,
      startedAt: "2026-06-01T00:00:00.000Z",
      experimentKeys: ["checkout-copy", "concluded-exp"],
    },
  ],
};

/** A user the holdout in CONFIG_WITH_HOLDOUT holds out. */
export const HELD_OUT_UNIT = "user-4";
/** A user the holdout in CONFIG_WITH_HOLDOUT releases. */
export const RELEASED_UNIT = "user-1";

/** A fetch that serves `config` and accepts enrollment events, passing each POST to `onEvents`. */
export function stubFetch(
  config: Config,
  onEvents?: (url: string, init?: RequestInit) => void,
): Mock<(url: string, init?: RequestInit) => Promise<Response>> {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.includes("/v1/events")) {
      onEvents?.(url, init);
      return Promise.resolve(
        new Response(JSON.stringify({ accepted: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(config), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: `W/"org-${config.version}"`,
        },
      }),
    );
  });
}

/** The wire form behind a context's opaque bootstrap. */
export function wireOf(ctx: ChertoContext): BootstrapV1 {
  return ctx.getBootstrap() as BootstrapV1;
}

/** Closes every client a test opens, and restores mocks and timers, after each test. */
export function closeClientsAfterEach(): void {
  const openClients: ChertoClient[] = [];
  const realInit = ChertoClient.init.bind(ChertoClient);

  beforeEach(() => {
    vi.spyOn(ChertoClient, "init").mockImplementation(async (opts) => {
      const client = await realInit(opts);
      openClients.push(client);
      return client;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(openClients.splice(0).map((client) => client.close()));
  });
}
