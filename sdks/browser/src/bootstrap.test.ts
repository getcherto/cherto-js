import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assigned,
  bootstrapOf,
  exp,
  makeClient,
  memoryStorage,
  primeCache,
} from "./test-helpers.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bootstrap", () => {
  it("serves assignments with no request, enrolling only what the server didn't", async () => {
    const { client, server, events } = makeClient({
      bootstrap: bootstrapOf({
        units: { user: "u1", account: "a1" },
        experiments: [
          { key: "hero", variant: "treatment", unitId: "u1", customValue: { color: "red" } },
          { key: "billing", variant: "b", unitTypeKey: "account", unitId: "a1" },
          { key: "forced", variant: "x", unitId: "u1", reason: "override", trackEnrollment: false },
        ],
        enrolled: ["hero"],
      }),
    });

    expect(client.getStatus()).toMatchObject({ ready: true, source: "bootstrap" });
    expect(client.getVariant("hero", "c")).toBe("treatment");
    expect(client.getVariantParam("hero", "color", "blue")).toBe("red");
    expect(client.getVariant("billing", "c")).toBe("b");
    expect(client.getVariant("forced", "c")).toBe("x");
    expect(client.getAssignmentDetail("forced").reason).toBe("override");
    expect(client.getAssignmentDetail("other").reason).toBe("not_assigned");
    await client.flush();

    expect(events.map((e) => [e.experimentKey, e.unitId])).toEqual([["billing", "a1"]]);
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("is accepted after a JSON round trip", () => {
    const bootstrap = JSON.parse(
      JSON.stringify(bootstrapOf({ experiments: [{ key: "hero", variant: "t", unitId: "u1" }] })),
    ) as ReturnType<typeof bootstrapOf>;
    const { client } = makeClient({ bootstrap });
    expect(client.getVariant("hero", "c")).toBe("t");
  });

  it.each<[string, unknown, RegExp]>([
    ["its JSON text", JSON.stringify(bootstrapOf({})), /pass the parsed object/],
    ["a newer version", { ...bootstrapOf({}), v: 2 }, /version isn't supported/],
  ])("ignores and reports %s", (_, bootstrap, reason) => {
    const { client, errors } = makeClient({ bootstrap: bootstrap as never });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("bad_config");
    expect(errors[0].message).toMatch(reason);
    expect(client.getStatus().ready).toBe(false);
  });

  it("is ignored when the context's units don't match it", () => {
    const { client, errors } = makeClient({
      context: { units: { user: "u2" } },
      bootstrap: bootstrapOf({
        units: { user: "u1" },
        experiments: [{ key: "hero", variant: "t", unitId: "u1" }],
      }),
    });
    expect(client.getVariant("hero", "c")).toBe("c");
    expect(errors.map((e) => e.code)).toEqual(["bad_config"]);
  });

  it("never fetches without a context", async () => {
    const { client, server } = makeClient({
      refreshIntervalMs: 10,
      bootstrap: bootstrapOf({ experiments: [{ key: "hero", variant: "t", unitId: "u1" }] }),
    });
    vi.advanceTimersByTime(1_000);
    client.getVariant("hero", "c");
    client.getAllAssignments();
    vi.advanceTimersByTime(0);
    expect(await client.initialize()).toEqual({ ok: true, source: "bootstrap" });
    expect(await client.refresh()).toEqual({ ok: true, source: "bootstrap" });
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("wins over saved assignments for the same context", async () => {
    const { storage } = memoryStorage();
    await primeCache(storage, { user: "u1" }, [exp("hero", "old-variant")]);
    const { client, server, events } = makeClient({
      storage,
      context: { units: { user: "u1" } },
      bootstrap: bootstrapOf({
        experiments: [{ key: "hero", variant: "new-variant", unitId: "u1" }],
      }),
    });

    expect(client.getVariant("hero", "c")).toBe("new-variant");
    expect(await client.initialize()).toEqual({ ok: true, source: "bootstrap" });
    expect(client.getVariant("hero", "c")).toBe("new-variant");
    expect(server.fetch).not.toHaveBeenCalled();
    await client.flush();
    expect(events.map((e) => e.variantKey)).toEqual(["new-variant"]);
  });

  it("reloads once it is older than refreshIntervalMs", async () => {
    const { client, server } = makeClient(
      {
        context: { units: { user: "u1" } },
        bootstrap: bootstrapOf({
          experiments: [{ key: "hero", variant: "t", unitId: "u1" }],
          generatedAt: new Date(Date.now() - 120_000),
        }),
      },
      () => assigned(exp("hero", "fresh")),
    );
    expect(client.getVariant("hero", "c", { track: false })).toBe("t");
    await client.initialize();
    expect(server.initCalls()).toHaveLength(1);
    expect(client.getVariant("hero", "c")).toBe("fresh");
  });

  it("is kept, with no request, when identify() passes its context", async () => {
    const attributes = { plan: "pro" };
    const { client, events, server } = makeClient({
      bootstrap: bootstrapOf({
        attributes,
        experiments: [{ key: "X", variant: "t", unitId: "u1" }],
      }),
    });

    const result = await client.identify({ units: { user: "u1" }, attributes });
    client.getVariant("X", "control");
    await client.flush();

    expect(result).toEqual({ ok: true, source: "bootstrap" });
    expect(events.map((e) => e.variantKey)).toEqual(["t"]);
    expect(server.initCalls()).toEqual([]);
  });
});
