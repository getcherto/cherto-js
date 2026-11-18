import { describe, it, expect, vi } from "vitest";
import { ChertoError } from "@cherto/core";
import { ChertoClient } from "./client.js";
import { MOCK_CONFIG, closeClientsAfterEach, stubFetch } from "./test-helpers.js";
import type { ChertoClientOptions, ChertoConfigSnapshot } from "./types.js";

closeClientsAfterEach();

const config = () => new Response(JSON.stringify(MOCK_CONFIG), { status: 200 });
const unavailable = () => new Response("down", { status: 503 });

/** A fetch that answers config requests with each response in turn, repeating the last. */
function respondWith(...responses: Array<() => Response>) {
  let call = 0;
  const fetchMock = vi.fn((url: string) =>
    url.includes("/v1/config")
      ? Promise.resolve(responses[Math.min(call++, responses.length - 1)]())
      : Promise.resolve(new Response("{}")),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ChertoClient.init", () => {
  it("fetches the config with the server key", async () => {
    const fetchMock = stubFetch(MOCK_CONFIG);
    vi.stubGlobal("fetch", fetchMock);

    const client = await ChertoClient.init({ serverKey: "sk_test" });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://api.getcherto.com/v1/config",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer sk_test" }),
      }),
    );
    expect(client.getStatus().ready).toBe(true);
  });

  it("rejects a client key passed as serverKey", async () => {
    const fetchMock = stubFetch(MOCK_CONFIG);
    vi.stubGlobal("fetch", fetchMock);

    await expect(ChertoClient.init({ serverKey: "ck_test" })).rejects.toMatchObject({
      code: "bad_config",
      message: expect.stringMatching(/serverKey is a client key/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing serverKey", { serverKey: "" }],
    ["a malformed apiUrl", { serverKey: "sk_test", apiUrl: "not-a-url" }],
    [
      '"custom" tracking with no logger',
      { serverKey: "sk_test", enrollmentTracking: { mode: "custom" as const } },
    ],
    [
      "an unknown tracking mode",
      { serverKey: "sk_test", enrollmentTracking: { mode: "segment" as "none" } },
    ],
  ])("rejects %s before any request goes out", async (_label, opts) => {
    const fetchMock = stubFetch(MOCK_CONFIG);
    vi.stubGlobal("fetch", fetchMock);

    const err = await ChertoClient.init(opts as ChertoClientOptions).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ChertoError);
    expect((err as ChertoError).code).toBe("bad_config");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ChertoClient.init retries", () => {
  it("retries a transient failure with backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fetchMock = respondWith(unavailable, unavailable, config);

    const pending = ChertoClient.init({ serverKey: "sk_test" });
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    const client = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(client.getStatus().configVersion).toBe(7);
  });

  it("waits out the server's Retry-After", async () => {
    vi.useFakeTimers();
    const fetchMock = respondWith(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }),
      config,
    );

    const pending = ChertoClient.init({ serverKey: "sk_test" });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects with the last error once initTimeoutMs runs out", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fetchMock = respondWith(unavailable);

    const pending = ChertoClient.init({ serverKey: "sk_test", initTimeoutMs: 4_000 }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(4_000);
    const err = await pending;

    expect((err as ChertoError).code).toBe("bad_response");
    // Attempts at 0, 0.5, 1.5 and 3.5 s; the next couldn't start within 4 s.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    [401, "unauthorized"],
    [404, "bad_request"],
  ])("rejects HTTP %i (%s) without retrying", async (status, code) => {
    const fetchMock = respondWith(() => new Response("no", { status }));

    const err = await ChertoClient.init({ serverKey: "sk_test" }).catch((e: unknown) => e);

    expect((err as ChertoError).code).toBe(code);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("times out a request that outlasts initTimeoutMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );

    const err = await ChertoClient.init({ serverKey: "sk_test", initTimeoutMs: 20 }).catch(
      (e: unknown) => e,
    );

    expect((err as ChertoError).code).toBe("timeout");
  });
});

describe("initialConfig", () => {
  it("is served without waiting for the network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    const client = await ChertoClient.init({
      serverKey: "sk_test",
      initialConfig: MOCK_CONFIG,
      enrollmentTracking: { mode: "none" },
    });

    expect(client.getStatus().configVersion).toBe(7);
    expect(client.context({ units: { user: "u_1" } }).getVariant("concluded-exp", "x")).toBe(
      "treatment",
    );
  });

  it("is replaced by the first fetch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stubFetch({ ...MOCK_CONFIG, version: 8 }));

    const client = await ChertoClient.init({ serverKey: "sk_test", initialConfig: MOCK_CONFIG });
    expect(client.getStatus().configVersion).toBe(7);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.getStatus().configVersion).toBe(8);
  });

  it("keeps being served when the first fetch fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(unavailable);

    const client = await ChertoClient.init({ serverKey: "sk_test", initialConfig: MOCK_CONFIG });
    await vi.advanceTimersByTimeAsync(0);

    expect(client.getStatus().configVersion).toBe(7);
  });
});

describe("ChertoClient.getConfigSnapshot", () => {
  it("is null before a config is loaded", async () => {
    const client = await ChertoClient.init({ serverKey: "", offline: true });

    expect(client.getConfigSnapshot()).toBeNull();
  });

  it("restores a client that assigns the same variants", async () => {
    vi.stubGlobal("fetch", stubFetch(MOCK_CONFIG));
    const original = await ChertoClient.init({ serverKey: "sk_test" });
    const saved = JSON.stringify(original.getConfigSnapshot());

    const restored = await ChertoClient.init({
      serverKey: "",
      offline: true,
      initialConfig: JSON.parse(saved) as ChertoConfigSnapshot,
    });

    const input = { units: { user: "u_1", company: "c_1" }, attributes: { plan: "premium" } };
    expect(restored.context(input).getAllAssignments()).toEqual(
      original.context(input).getAllAssignments(),
    );
  });
});

describe("onInitFailure", () => {
  it('"serveDefaults" serves defaults until a fetch succeeds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondWith(unavailable);

    const pending = ChertoClient.init({
      serverKey: "sk_test",
      onInitFailure: "serveDefaults",
      enrollmentTracking: { mode: "none" },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const client = await pending;
    const read = () =>
      client.context({ units: { user: "u_1" } }).getVariant("concluded-exp", "control");

    expect(read()).toBe("control");

    vi.stubGlobal("fetch", stubFetch(MOCK_CONFIG));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(read()).toBe("treatment");
  });

  it('"serveDefaults" still rejects a permanent failure', async () => {
    respondWith(() => new Response("no", { status: 401 }));

    const err = await ChertoClient.init({
      serverKey: "sk_bad",
      onInitFailure: "serveDefaults",
    }).catch((e: unknown) => e);

    expect((err as ChertoError).code).toBe("unauthorized");
  });
});

describe("offline", () => {
  it("serves initialConfig with no network, timers or keys", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(MOCK_CONFIG);
    vi.stubGlobal("fetch", fetchMock);

    const client = await ChertoClient.init({
      serverKey: "",
      offline: true,
      initialConfig: MOCK_CONFIG,
      enrollmentTracking: { mode: "cherto" },
    });
    const ctx = client.context({ units: { user: "u_1" } });
    expect(ctx.getVariant("concluded-exp", "control")).toBe("treatment");
    await ctx.trackEnrollment("concluded-exp");
    await vi.advanceTimersByTimeAsync(120_000);
    await client.flush();
    await client.close();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serves every default without an initialConfig", async () => {
    const client = await ChertoClient.init({ serverKey: "sk_test", offline: true });

    expect(client.context({ units: { user: "u_1" } }).getVariant("concluded-exp", "x")).toBe("x");
    expect(client.getStatus().configVersion).toBe(0);
  });

  it('still calls a "custom" enrollment logger', async () => {
    const logger = vi.fn();
    const client = await ChertoClient.init({
      serverKey: "sk_test",
      offline: true,
      initialConfig: MOCK_CONFIG,
      enrollmentTracking: { mode: "custom", logger },
    });

    client.context({ units: { user: "u_1" } }).getVariant("concluded-exp", "control");
    await client.flush();

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({ experimentKey: "concluded-exp", variantKey: "treatment" }),
    );
  });

  it("serves and enrolls a hand-written snapshot", async () => {
    const events: unknown[] = [];
    const savedConfig: ChertoConfigSnapshot = {
      experiments: [
        {
          key: "checkout-copy",
          status: "running",
          salt: "test",
          unitTypeKey: "user",
          trafficPercentage: 100,
          variants: [
            { key: "control", allocationPercentage: 0 },
            { key: "treatment", allocationPercentage: 100 },
          ],
        },
      ],
    };
    const client = await ChertoClient.init({
      serverKey: "",
      offline: true,
      initialConfig: savedConfig,
      enrollmentTracking: { mode: "custom", logger: (event) => void events.push(event) },
    });

    for (const user of ["u_1", "u_2", "u_3"]) {
      expect(client.context({ units: { user } }).getVariant("checkout-copy", "control")).toBe(
        "treatment",
      );
    }
    await client.flush();

    expect(events).toHaveLength(3);
  });
});

describe("polling", () => {
  it("picks up a changed config on the next poll", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stubFetch(MOCK_CONFIG));
    const client = await ChertoClient.init({ serverKey: "sk_test" });

    vi.stubGlobal("fetch", stubFetch({ ...MOCK_CONFIG, version: 8 }));
    await vi.advanceTimersByTimeAsync(35_000);

    expect(client.getStatus().configVersion).toBe(8);
  });
});

describe("logger", () => {
  it("receives the SDK's warnings instead of the console", async () => {
    vi.stubGlobal("fetch", stubFetch(MOCK_CONFIG));
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = { warn: vi.fn(), error: vi.fn() };

    await ChertoClient.init({ serverKey: "sk_test", logger, pollIntervalMs: 1_000 });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("5000 ms minimum"));
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});

describe("getStatus and onError", () => {
  it("reports a healthy client after init", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00.000Z") });
    vi.stubGlobal("fetch", stubFetch(MOCK_CONFIG));

    const client = await ChertoClient.init({ serverKey: "sk_test" });

    expect(client.getStatus()).toEqual({
      ready: true,
      configVersion: 7,
      lastSuccessfulFetchAt: new Date("2026-10-01T12:00:00.000Z"),
      lastError: null,
      lastErrorAt: null,
      droppedEvents: 0,
    });
  });

  it("reports a failed poll and keeps the last good config", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00.000Z") });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", stubFetch(MOCK_CONFIG));
    const onError = vi.fn();
    const client = await ChertoClient.init({ serverKey: "sk_test", onError });

    respondWith(() => new Response("no", { status: 401 }));
    await vi.advanceTimersByTimeAsync(35_000);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "unauthorized" }));
    const status = client.getStatus();
    expect(status.lastError?.code).toBe("unauthorized");
    expect(status.lastErrorAt).toEqual(new Date("2026-10-01T12:00:30.000Z"));
    expect(status.lastSuccessfulFetchAt).toEqual(new Date("2026-10-01T12:00:00.000Z"));
    expect(status.ready).toBe(true);
    expect(status.configVersion).toBe(7);
  });

  it("counts enrollment events it gave up delivering", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      stubFetch(MOCK_CONFIG, () => {
        throw new TypeError("fetch failed");
      }),
    );
    const onError = vi.fn();
    const client = await ChertoClient.init({
      serverKey: "sk_test",
      eventBuffer: { maxFlushAttempts: 1 },
      onError,
    });

    for (const user of ["u_1", "u_2"]) {
      client.context({ units: { user } }).getVariant("concluded-exp", "control");
    }
    await client.flush();

    expect(client.getStatus().droppedEvents).toBe(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "network" }));
  });

  it("reports an offline client as ready only with an initialConfig", async () => {
    const seeded = await ChertoClient.init({
      serverKey: "",
      offline: true,
      initialConfig: MOCK_CONFIG,
    });
    const empty = await ChertoClient.init({ serverKey: "", offline: true });

    expect(seeded.getStatus()).toMatchObject({ ready: true, lastSuccessfulFetchAt: null });
    expect(empty.getStatus().ready).toBe(false);
  });
});
