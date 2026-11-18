import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API,
  STARTED_AT,
  assigned,
  exp,
  json,
  makeClient,
  memoryStorage,
  primeCache,
} from "./test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("reading variants", () => {
  it("serves defaults and enrolls nothing before assignments load", async () => {
    const { client, events } = makeClient({ context: { units: { user: "u1" } } });
    expect(client.getVariant("hero", "control")).toBe("control");
    expect(client.getVariantValue("hero", { a: 1 })).toEqual({ a: 1 });
    expect(client.getVariantParam("hero", "a", 1)).toBe(1);
    expect(client.getAssignment("hero")).toBeNull();
    expect(client.getAllAssignments()).toEqual({});
    expect(client.getAssignmentDetail("hero")).toEqual({ assignment: null, reason: "not_ready" });
    await client.trackEnrollment("hero");
    await client.flush();
    expect(events).toEqual([]);
  });

  it("serves loaded assignments and enrolls the unit once", async () => {
    const { client, events } = makeClient({ context: { units: { user: "u1" } } }, () =>
      assigned(exp("hero", "treatment", { value: { color: "red" } })),
    );
    await client.initialize();

    expect(client.getVariant("hero", "control")).toBe("treatment");
    expect(client.getVariant("hero", "control")).toBe("treatment");
    expect(client.getVariantValue("hero", {})).toEqual({ color: "red" });
    expect(client.getVariantParam("hero", "color", "blue")).toBe("red");
    await client.flush();

    expect(events).toEqual([
      {
        eventId: expect.any(String),
        experimentKey: "hero",
        variantKey: "treatment",
        unitId: "u1",
        startedAt: STARTED_AT,
        occurredAt: expect.any(String),
      },
    ]);
  });

  it("skips enrollment with { track: false } until trackEnrollment()", async () => {
    const { client, events } = makeClient({ context: { units: { user: "u1" } } }, () =>
      assigned(exp("hero", "treatment")),
    );
    await client.initialize();
    client.getVariant("hero", "control", { track: false });
    await client.flush();
    expect(events).toEqual([]);
    await client.trackEnrollment("hero");
    await client.flush();
    expect(events.map((e) => e.experimentKey)).toEqual(["hero"]);
  });

  it("getAssignmentDetail() returns the reason without enrolling", async () => {
    const { client, events } = makeClient({ context: { units: { user: "u1" } } }, () =>
      assigned(exp("hero", "treatment"), exp("forced", "control", { reason: "override" })),
    );
    await client.initialize();
    expect(client.getAssignmentDetail("hero")).toEqual({
      assignment: { variant: "treatment", startedAt: STARTED_AT },
      reason: "assigned",
    });
    expect(client.getAssignmentDetail("forced").reason).toBe("override");
    expect(client.getAssignmentDetail("other")).toEqual({
      assignment: null,
      reason: "not_assigned",
    });
    await client.flush();
    expect(events).toEqual([]);
  });

  it("returns copies of custom values", async () => {
    const { client } = makeClient({ context: { units: { user: "u1" } } }, () =>
      assigned(exp("hero", "treatment", { value: { nested: { color: "red" } } })),
    );
    await client.initialize();
    const value = client.getVariantValue<{ nested: { color: string } }>("hero", {
      nested: { color: "" },
    });
    value.nested.color = "mutated";
    client.getAssignment("hero")!.customValue!.nested = "mutated";
    client.getAllAssignments().hero.customValue!.nested = "mutated";
    (client.getVariantParam("hero", "nested", {}) as { color: string }).color = "mutated";

    expect(client.getAssignment("hero")?.customValue).toEqual({ nested: { color: "red" } });
  });

  it("serves the default when its type doesn't match the value", async () => {
    const { client, logger } = makeClient({ context: { units: { user: "u1" } } }, () =>
      assigned(exp("hero", "treatment", { value: { size: "big" } })),
    );
    await client.initialize();
    expect(client.getVariantParam("hero", "size", 1)).toBe(1);
    expect(client.getVariantValue("hero", "fallback")).toBe("fallback");
    expect(logger.warn).toHaveBeenCalledWith(
      `[cherto] param "size" doesn't match the type of the caller's default, serving the default`,
      { experimentKey: "hero", expected: "number", actual: "string" },
    );
  });

  it("enrolls again when the experiment restarts", async () => {
    let startedAt = STARTED_AT;
    const { client, events } = makeClient({ context: { units: { user: "u1" } } }, () =>
      assigned(exp("hero", "treatment", { startedAt })),
    );
    await client.initialize();
    client.getVariant("hero", "c");
    startedAt = "2026-02-01T00:00:00.000Z";
    await client.refresh();
    client.getVariant("hero", "c");
    await client.flush();
    expect(events.map((e) => e.startedAt)).toEqual([STARTED_AT, "2026-02-01T00:00:00.000Z"]);
  });
});

describe("overrides and holdouts", () => {
  const response = () =>
    json({
      experiments: [
        exp("forced", "treatment", { trackEnrollment: false, reason: "override" }),
        exp("covered", "control", { trackEnrollment: false, reason: "holdout" }),
        exp("released", "treatment"),
      ],
      holdouts: [
        {
          key: "h1",
          variant: "holdout",
          unitTypeKey: "user",
          startedAt: STARTED_AT,
          experimentKeys: ["covered", "gated"],
        },
      ],
    });

  it("serves an override without enrolling it", async () => {
    const { client, events } = makeClient({ context: { units: { user: "u1" } } }, response);
    await client.initialize();
    expect(client.getVariant("forced", "control")).toBe("treatment");
    await client.trackEnrollment("forced");
    await client.flush();
    expect(events).toEqual([]);
    expect(client.getEnrollmentPayloads("forced")).toEqual([]);
  });

  it("enrolls a held-out unit in the holdout once", async () => {
    const { client, events } = makeClient({ context: { units: { user: "u1" } } }, response);
    await client.initialize();
    client.getVariant("covered", "x");
    client.getVariant("gated", "x");
    client.getVariant("covered", "x");
    await client.flush();
    expect(events.map((e) => [e.experimentKey, e.variantKey, e.unitId])).toEqual([
      ["h1", "holdout", "u1"],
    ]);
  });

  it("honors { track: false } for the holdout too", async () => {
    const { client, events } = makeClient({ context: { units: { user: "u1" } } }, response);
    await client.initialize();
    client.getVariant("covered", "x", { track: false });
    await client.flush();
    expect(events).toEqual([]);
  });

  it("getEnrollmentPayloads() returns what a read would send", async () => {
    const { client, events } = makeClient({ context: { units: { user: "u1" } } }, response);
    await client.initialize();
    expect(client.getEnrollmentPayloads("covered")).toEqual([
      expect.objectContaining({ experimentKey: "h1", variantKey: "holdout", unitId: "u1" }),
    ]);
    expect(client.getEnrollmentPayloads("released")).toEqual([
      expect.objectContaining({ experimentKey: "released", variantKey: "treatment" }),
    ]);
    expect(client.getEnrollmentPayloads("missing")).toEqual([]);
    await client.flush();
    expect(events).toEqual([]);
    client.getVariant("covered", "x");
    await client.flush();
    expect(events).toHaveLength(1);
  });
});

describe('"cherto" enrollment tracking', () => {
  it("posts enrollment events to /v1/events", async () => {
    const { client, server } = makeClient(
      { context: { units: { user: "u1" } }, enrollmentTracking: { mode: "cherto" } },
      (call) =>
        call.url.endsWith("/v1/events") ? json({ accepted: 1 }) : assigned(exp("hero", "t")),
    );
    await client.initialize();
    client.getVariant("hero", "c");
    await client.flush();

    const sent = server.calls.filter((call) => call.url === `${API}/v1/events`);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({
      events: [expect.objectContaining({ experimentKey: "hero", variantKey: "t", unitId: "u1" })],
    });
  });
});

describe("cache", () => {
  it("serves saved assignments on the next page load, with no request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { storage } = memoryStorage();
    await primeCache(storage, { user: "u1" }, [exp("hero", "treatment")]);

    const { client, server, events } = makeClient({ storage, context: { units: { user: "u1" } } });
    expect(client.getStatus().source).toBe("cache");
    expect(client.getVariant("hero", "control")).toBe("treatment");
    vi.advanceTimersByTime(0);
    await client.flush();
    expect(events.map((e) => e.variantKey)).toEqual(["treatment"]);
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("stores no unit ids or attribute values", async () => {
    const { storage, store } = memoryStorage();
    const first = makeClient(
      { storage, context: { units: { user: "user-42" }, attributes: { email: "a@example.com" } } },
      () => assigned(exp("hero", "treatment")),
    );
    await first.client.initialize();

    const { client } = makeClient({
      storage,
      context: { units: { user: "user-42" }, attributes: { email: "b@example.com" } },
    });
    expect(client.getStatus().source).toBe("none");
    const saved = JSON.stringify([...store.values()]);
    expect(saved).not.toContain("a@example.com");
    expect(saved).not.toContain("user-42");
  });
});
