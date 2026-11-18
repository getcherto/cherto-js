import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STARTED_AT,
  assigned,
  deferred,
  exp,
  json,
  makeClient,
  memoryStorage,
  primeCache,
  unitsOf,
} from "./test-helpers.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("identify()", () => {
  it("serves defaults, never the previous user's variants, while loading", async () => {
    const response = deferred<Response>();
    const { client, events } = makeClient({ context: { units: { user: "u1" } } }, (call) =>
      unitsOf(call).user === "u1" ? assigned(exp("hero", "u1-variant")) : response.promise,
    );
    await client.initialize();
    const listener = vi.fn();
    client.subscribe(listener);

    const pending = client.identify({ units: { user: "u2" } });

    expect(listener).toHaveBeenCalledOnce();
    expect(client.getVariant("hero", "default")).toBe("default");
    expect(client.getAssignmentDetail("hero").reason).toBe("not_ready");
    expect(client.getStatus()).toMatchObject({ ready: false, source: "none" });

    response.resolve(assigned(exp("hero", "u2-variant")));
    expect(await pending).toEqual({ ok: true, source: "network" });
    expect(client.getVariant("hero", "default")).toBe("u2-variant");
    await client.flush();
    expect(events.map((e) => [e.variantKey, e.unitId])).toEqual([["u2-variant", "u2"]]);
  });

  it("serves what was saved for the new context while loading", async () => {
    const { storage } = memoryStorage();
    await primeCache(storage, { user: "u2" }, [exp("hero", "saved")]);
    const { client } = makeClient(
      { storage, context: { units: { user: "u1" } } },
      () => new Promise<Response>(() => {}),
    );

    void client.identify({ units: { user: "u2" } });

    expect(client.getStatus().source).toBe("cache");
    expect(client.getVariant("hero", "c")).toBe("saved");
  });

  it("does nothing for an identical context", async () => {
    const { client, server } = makeClient({
      context: { units: { user: "u1", device: "d1" }, attributes: { plan: "pro" } },
    });
    await client.initialize();
    const listener = vi.fn();
    client.subscribe(listener);

    const result = await client.identify({
      units: { device: "d1", user: "u1", gone: undefined },
      attributes: { plan: "pro" },
    });

    expect(result).toEqual({ ok: true, source: "network" });
    expect(server.initCalls()).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("enrolls the new unit in experiments and holdouts", async () => {
    const holdout = {
      key: "h1",
      variant: "released",
      unitTypeKey: "user",
      startedAt: STARTED_AT,
      experimentKeys: ["hero"],
    };
    const { client, events } = makeClient({ context: { units: { user: "u1" } } }, () =>
      json({ experiments: [exp("hero", "treatment")], holdouts: [holdout] }),
    );
    await client.initialize();
    client.getVariant("hero", "c");
    await client.identify({ units: { user: "u2" } });
    client.getVariant("hero", "c");
    await client.flush();
    expect(events.map((e) => [e.experimentKey, e.unitId])).toEqual([
      ["h1", "u1"],
      ["hero", "u1"],
      ["h1", "u2"],
      ["hero", "u2"],
    ]);
  });

  it("serves defaults once every unit is undefined", async () => {
    const { client, server } = makeClient({ context: { units: { user: "u1" } } }, () =>
      assigned(exp("X", "t")),
    );
    await client.initialize();
    expect(await client.identify({ units: { user: undefined } })).toEqual({
      ok: true,
      source: "none",
    });
    expect(client.getVariant("X", "control")).toBe("control");
    expect(server.initCalls()).toHaveLength(1);
  });
});

describe("a context with no units", () => {
  it("loads nothing and serves defaults, with a warning", async () => {
    const { client, server, logger, errors } = makeClient({ context: { units: {} } });
    expect(await client.initialize()).toEqual({ ok: true, source: "none" });
    expect(await client.refresh()).toEqual({ ok: true, source: "none" });
    expect(client.getVariant("X", "control")).toBe("control");
    vi.advanceTimersByTime(600_000);
    client.getVariant("X", "control");
    vi.advanceTimersByTime(0);

    expect(server.fetch).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "[cherto] context has no units, so no assignments are loaded; pass at least one, such as " +
        "a device id",
      {},
    );
  });
});
