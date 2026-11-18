import { describe, it, expect, vi } from "vitest";
import type { ChertoEnrollmentEvent } from "@cherto/core";
import { ChertoClient } from "./client.js";
import {
  CONFIG_WITH_HOLDOUT,
  HELD_OUT_UNIT,
  MOCK_CONFIG,
  OVERRIDE_CONFIG,
  RELEASED_UNIT,
  closeClientsAfterEach,
  stubFetch,
  wireOf,
} from "./test-helpers.js";
import type { ChertoClientOptions, Config } from "./types.js";

closeClientsAfterEach();

const USER = { units: { user: "u_1" } };

/** A client on `config` whose "custom" enrollment logger records each event in `events`. */
async function trackingClient(config: Config = MOCK_CONFIG) {
  vi.stubGlobal("fetch", stubFetch(config));
  const events: ChertoEnrollmentEvent[] = [];
  const client = await ChertoClient.init({
    serverKey: "sk_test",
    enrollmentTracking: { mode: "custom", logger: (event) => void events.push(event) },
  });
  return { client, events };
}

/** A client in the default "cherto" mode, with `posts` called for each request to /v1/events. */
async function chertoClient(options: Partial<ChertoClientOptions> = {}) {
  const posts = vi.fn<(url: string, init?: RequestInit) => void>();
  vi.stubGlobal("fetch", stubFetch(MOCK_CONFIG, posts));
  const client = await ChertoClient.init({ serverKey: "sk_test", ...options });
  const sent = () =>
    posts.mock.calls.flatMap(
      ([, init]) => (JSON.parse(init!.body as string) as { events: unknown[] }).events,
    );
  return { client, posts, sent };
}

describe("enrollment", () => {
  it("getVariant enrolls the unit in its variant", async () => {
    const { client, events } = await trackingClient();

    client.context(USER).getVariant("concluded-exp", "control");
    await client.flush();

    expect(events).toEqual([
      expect.objectContaining({
        experimentKey: "concluded-exp",
        variantKey: "treatment",
        unitId: "u_1",
      }),
    ]);
  });

  it("doesn't enroll with { track: false }", async () => {
    const { client, events } = await trackingClient();

    client.context(USER).getVariant("concluded-exp", "control", { track: false });
    await client.flush();

    expect(events).toEqual([]);
  });

  it("enrolls once per context", async () => {
    const { client, events } = await trackingClient();
    const ctx = client.context(USER);

    ctx.getVariant("concluded-exp", "control");
    ctx.getVariant("concluded-exp", "control");
    await client.flush();

    expect(events).toHaveLength(1);
  });

  it("enrolls again from a fresh context", async () => {
    const { client, events } = await trackingClient();

    client.context(USER).getVariant("concluded-exp", "control");
    client.context(USER).getVariant("concluded-exp", "control");
    await client.flush();

    expect(events).toHaveLength(2);
  });

  it("never enrolls from getAssignment, getAllAssignments or getAssignmentDetail", async () => {
    const { client, events } = await trackingClient();
    const ctx = client.context(USER);

    ctx.getAssignment("checkout-copy");
    ctx.getAllAssignments();
    ctx.getAssignmentDetail("checkout-copy");
    await client.flush();

    expect(events).toEqual([]);
  });
});

describe("trackEnrollment", () => {
  it("enrolls without a read", async () => {
    const { client, events } = await trackingClient();

    await client.context(USER).trackEnrollment("concluded-exp");

    expect(events).toEqual([expect.objectContaining({ experimentKey: "concluded-exp" })]);
  });
});

describe("getEnrollmentPayloads", () => {
  it("builds the event without sending it", async () => {
    const { client, events } = await trackingClient();
    const ctx = client.context(USER);

    const payloads = ctx.getEnrollmentPayloads("concluded-exp");

    expect(payloads).toEqual([
      expect.objectContaining({
        experimentKey: "concluded-exp",
        variantKey: "treatment",
        unitId: "u_1",
        startedAt: ctx.getAssignment("concluded-exp")!.startedAt,
      }),
    ]);
    expect(events).toEqual([]);
  });

  it("is empty when there is no assignment", async () => {
    const { client } = await trackingClient();

    const payloads = client
      .context({ units: { company: "c_1" } })
      .getEnrollmentPayloads("checkout-copy");

    expect(payloads).toEqual([]);
  });
});

describe("enrollment tracking modes", () => {
  it('"cherto", the default, posts events to /v1/events with the server key', async () => {
    const { client, posts, sent } = await chertoClient();

    client.context(USER).getVariant("concluded-exp", "control");
    await client.flush();

    expect(posts).toHaveBeenCalledOnce();
    const [url, init] = posts.mock.calls[0];
    expect(url).toBe("https://api.getcherto.com/v1/events");
    expect(init!.headers).toMatchObject({ authorization: "Bearer sk_test" });
    expect(sent()).toEqual([
      {
        eventId: expect.any(String),
        experimentKey: "concluded-exp",
        variantKey: "treatment",
        unitId: "u_1",
        startedAt: "1970-01-01T00:00:00.000Z",
        occurredAt: expect.any(String),
      },
    ]);
  });

  it('"cherto" batches enrollments from many contexts into one request', async () => {
    const { client, posts, sent } = await chertoClient();

    for (let i = 0; i < 20; i++) {
      client.context({ units: { user: `u_${i}` } }).getVariant("concluded-exp", "control");
    }
    await client.flush();

    expect(posts).toHaveBeenCalledOnce();
    expect(sent()).toHaveLength(20);
  });

  it('"cherto" records a unit\'s enrollment once across contexts', async () => {
    const { client, sent } = await chertoClient();

    for (let i = 0; i < 3; i++) {
      const ctx = client.context(USER);
      ctx.getVariant("concluded-exp", "control");
      await ctx.trackEnrollment("concluded-exp");
    }
    await client.flush();

    expect(sent()).toHaveLength(1);
  });

  it('"none" sends nothing', async () => {
    const { client, posts } = await chertoClient({ enrollmentTracking: { mode: "none" } });

    client.context(USER).getVariant("concluded-exp", "control");
    await client.flush();

    expect(posts).not.toHaveBeenCalled();
  });
});

describe("flush and close", () => {
  it("flush() delivers queued enrollment without waiting for the next interval", async () => {
    const { client, posts } = await chertoClient({ eventBuffer: { flushIntervalMs: 60_000 } });

    client.context(USER).getVariant("concluded-exp", "control");
    expect(posts).not.toHaveBeenCalled();
    await client.flush();

    expect(posts).toHaveBeenCalledOnce();
  });

  it("close() delivers queued enrollment", async () => {
    const { client, posts } = await chertoClient({ eventBuffer: { flushIntervalMs: 60_000 } });

    client.context(USER).getVariant("concluded-exp", "control");
    await client.close();

    expect(posts).toHaveBeenCalledOnce();
  });

  it("a closed client still serves variants, but records no enrollment", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, events } = await trackingClient();
    await client.close();
    const ctx = client.context(USER);

    expect(ctx.getVariant("concluded-exp", "control")).toBe("treatment");
    await ctx.trackEnrollment("checkout-copy");

    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[cherto] the client is closed, so enrollment is no longer recorded",
      {},
    );
  });
});

describe("getBootstrap", () => {
  it("lists the experiments the context has enrolled", async () => {
    const { client, events } = await trackingClient();
    const ctx = client.context(USER);

    ctx.getVariant("checkout-copy", "control");
    const bootstrap = wireOf(ctx);
    await client.flush();

    expect(bootstrap.enrolled).toEqual(["checkout-copy"]);
    expect(events).toEqual([expect.objectContaining({ experimentKey: "checkout-copy" })]);
  });

  it("lists none after reads that don't enroll", async () => {
    const { client } = await trackingClient();
    const ctx = client.context(USER);

    ctx.getAssignment("checkout-copy");
    ctx.getAllAssignments();

    expect(wireOf(ctx).enrolled).toBeUndefined();
  });

  it('lists none in "none" mode, leaving enrollment to the browser SDK', async () => {
    vi.stubGlobal("fetch", stubFetch(MOCK_CONFIG));
    const client = await ChertoClient.init({
      serverKey: "sk_test",
      enrollmentTracking: { mode: "none" },
    });
    const ctx = client.context(USER);

    ctx.getVariant("checkout-copy", "control");
    await ctx.trackEnrollment("concluded-exp");

    expect(wireOf(ctx).enrolled).toBeUndefined();
  });
});

describe("variant overrides", () => {
  it("serve the forced variant without enrolling", async () => {
    const { client, events } = await trackingClient(OVERRIDE_CONFIG);

    const variant = client.context({ units: { user: "u_qa" } }).getVariant("forced-exp", "control");
    await client.flush();

    expect(variant).toBe("treatment");
    expect(events).toEqual([]);
  });

  it("leave other units to be assigned and enrolled as usual", async () => {
    const { client, events } = await trackingClient({
      ...OVERRIDE_CONFIG,
      experiments: [{ ...OVERRIDE_CONFIG.experiments[0]!, trafficPercentage: 100 }],
    });

    client.context({ units: { user: "u_normal" } }).getVariant("forced-exp", "control");
    await client.flush();

    expect(events).toHaveLength(1);
  });
});

describe("holdouts", () => {
  const recorded = (events: ChertoEnrollmentEvent[]) =>
    events.map((e) => [e.experimentKey, e.variantKey]).sort();

  it("serve control to a held-out unit and record only the holdout", async () => {
    const { client, events } = await trackingClient(CONFIG_WITH_HOLDOUT);
    const ctx = client.context({ units: { user: HELD_OUT_UNIT } });

    expect(ctx.getVariant("checkout-copy", "fallback")).toBe("control");
    expect(ctx.getVariant("concluded-exp", "fallback")).toBe("control");
    await client.flush();

    expect(recorded(events)).toEqual([["h2-holdout", "holdout"]]);
  });

  it("record a released unit in both the experiment and the holdout", async () => {
    const { client, events } = await trackingClient(CONFIG_WITH_HOLDOUT);

    client.context({ units: { user: RELEASED_UNIT } }).getVariant("checkout-copy", "fallback");
    await client.flush();

    expect(recorded(events)).toEqual([
      ["checkout-copy", expect.any(String)],
      ["h2-holdout", "released"],
    ]);
  });
});
