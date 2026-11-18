import { afterEach, describe, expect, it, vi } from "vitest";
import { ChertoClient } from "./client.js";
import {
  API,
  assigned,
  bootstrapOf,
  exp,
  json,
  makeClient,
  quietLogger,
  settle,
} from "./test-helpers.js";
import { VERSION } from "./version.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("new ChertoClient()", () => {
  it("never throws on invalid options", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => new ChertoClient(undefined as never)).not.toThrow();
    expect(() => new ChertoClient({ clientKey: 5 } as never)).not.toThrow();
  });

  it("reports a server key and makes no request", async () => {
    const { client, server, errors } = makeClient({
      clientKey: "sk_test_secret",
      context: { units: { user: "u1" } },
    });
    expect(errors.map((e) => e.code)).toEqual(["bad_config"]);
    expect((await client.initialize()).ok).toBe(false);
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["isn't a URL", "api.example.com"],
    ["isn't http(s)", "ftp://api.example.com"],
  ])("reports an apiUrl that %s", async (_, apiUrl) => {
    const { client, server, errors } = makeClient({ apiUrl, context: { units: { user: "u1" } } });
    expect(errors.map((e) => e.code)).toEqual(["bad_config"]);
    await client.initialize();
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("defaults apiUrl to https://api.getcherto.com", async () => {
    const { client, server } = makeClient({
      apiUrl: undefined,
      context: { units: { user: "u1" } },
    });
    await client.initialize();
    expect(server.calls[0].url).toBe("https://api.getcherto.com/v1/initialize");
  });
});

describe("initialize()", () => {
  it("posts the context with the client key", async () => {
    const { client, server } = makeClient({
      context: {
        units: { user: "u1", account: 42, device: undefined },
        attributes: { plan: "pro", beta: true, gone: undefined },
      },
    });

    expect(await client.initialize()).toEqual({ ok: true, source: "network" });

    expect(server.calls).toHaveLength(1);
    const [call] = server.calls;
    expect(call.url).toBe(`${API}/v1/initialize`);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer ck_test",
      "X-Cherto-SDK": `browser/${VERSION}`,
    });
    expect(call.body).toEqual({
      context: { units: { user: "u1", account: "42" }, attributes: { plan: "pro", beta: true } },
    });
  });

  it("shares one request between concurrent calls", async () => {
    const { client, server } = makeClient({ context: { units: { user: "u1" } } });
    const [a, b] = await Promise.all([client.initialize(), client.initialize()]);
    expect(a).toEqual(b);
    expect(server.calls).toHaveLength(1);
  });

  it("reloads only once assignments are older than refreshIntervalMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, server } = makeClient({
      context: { units: { user: "u1" } },
      refreshIntervalMs: 1_000,
    });
    await client.initialize();
    expect(await client.initialize()).toEqual({ ok: true, source: "network" });
    expect(server.calls).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    await client.initialize();
    expect(server.calls).toHaveLength(2);
  });

  it("reports bad_config without a context or bootstrap", async () => {
    const { client, server, errors } = makeClient();
    const result = await client.initialize();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad_config");
    expect(errors).toHaveLength(1);
    await client.initialize();
    expect(errors).toHaveLength(1);
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("makes no request when offline", async () => {
    const { client, server } = makeClient({ offline: true, context: { units: { user: "u1" } } });
    expect(await client.initialize()).toEqual({ ok: true, source: "none" });
    expect(await client.refresh()).toEqual({ ok: true, source: "none" });
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "UNAUTHORIZED", "unauthorized"],
    [403, "ORIGIN_NOT_ALLOWED", "origin_not_allowed"],
  ])("resolves ok: false on HTTP %s, without retrying", async (status, error, code) => {
    const { client, server, errors } = makeClient({ context: { units: { user: "u1" } } }, () =>
      json({ error, message: "rejected" }, status),
    );
    const result = await client.initialize();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(code);
    expect(errors).toEqual([result.error]);
    expect(server.calls).toHaveLength(1);
  });

  it("resolves with a timeout error after initTimeoutMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client } = makeClient(
      { initTimeoutMs: 100, context: { units: { user: "u1" } } },
      () => new Promise<Response>(() => {}),
    );
    const pending = client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).error?.code).toBe("timeout");
  });

  it("retries a 503 with backoff, then succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, server } = makeClient({ context: { units: { user: "u1" } } }, (_, i) =>
      i === 0 ? new Response("unavailable", { status: 503 }) : assigned(exp("hero", "t")),
    );
    const pending = client.initialize();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ ok: true, source: "network" });
    expect(server.calls).toHaveLength(2);
  });

  it("retries a network failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, server } = makeClient({ context: { units: { user: "u1" } } }, (_, i) => {
      if (i === 0) throw new TypeError("Failed to fetch");
      return assigned();
    });
    const pending = client.initialize();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).ok).toBe(true);
    expect(server.calls).toHaveLength(2);
  });

  it("waits for Retry-After on a 429", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, server } = makeClient({ context: { units: { user: "u1" } } }, (_, i) =>
      i === 0 ? json({ error: "RATE_LIMITED" }, 429, { "retry-after": "2" }) : assigned(),
    );
    const pending = client.initialize();
    await vi.advanceTimersByTimeAsync(1_900);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).ok).toBe(true);
    expect(server.calls).toHaveLength(2);
  });

  it("gives up when Retry-After outlasts initTimeoutMs", async () => {
    const { client, server } = makeClient({ context: { units: { user: "u1" } } }, () =>
      json({ error: "RATE_LIMITED" }, 429, { "retry-after": "30" }),
    );
    const result = await client.initialize();
    expect(result.error?.code).toBe("rate_limited");
    expect(result.error?.retryAfterMs).toBe(30_000);
    expect(server.calls).toHaveLength(1);
  });
});

describe("background refresh", () => {
  it("reloads stale assignments after a read, serving them meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let variant = "a";
    const { client, server } = makeClient(
      { context: { units: { user: "u1" } }, refreshIntervalMs: 1_000 },
      () => assigned(exp("hero", variant)),
    );
    await client.initialize();
    client.getVariant("hero", "c");
    vi.advanceTimersByTime(0);
    expect(server.initCalls()).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    variant = "b";
    expect(client.getVariant("hero", "c")).toBe("a");
    client.getAssignmentDetail("hero");
    expect(server.initCalls()).toHaveLength(1);
    vi.advanceTimersByTime(0);
    expect(server.initCalls()).toHaveLength(2);
    await settle();
    expect(client.getVariant("hero", "c")).toBe("b");
  });

  it("retries a failed load when the browser comes back online", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.stubGlobal("window", new EventTarget());
    let fail = true;
    const { client, server } = makeClient({ context: { units: { user: "u1" } } }, () => {
      if (fail) throw new TypeError("Failed to fetch");
      return assigned(exp("hero", "t"));
    });
    const pending = client.initialize();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).ok).toBe(false);
    const attempts = server.initCalls().length;

    fail = false;
    window.dispatchEvent(new Event("online"));
    expect(server.initCalls()).toHaveLength(attempts + 1);
    await settle();
    expect(client.getVariant("hero", "c")).toBe("t");

    await client.close();
    window.dispatchEvent(new Event("online"));
    expect(server.initCalls()).toHaveLength(attempts + 1);
  });
});

describe("subscribe()", () => {
  it("notifies when assignments load and when they change", async () => {
    let variant = "a";
    const { client } = makeClient({ context: { units: { user: "u1" } } }, () =>
      assigned(exp("hero", variant)),
    );
    const listener = vi.fn(() => client.getVariant("hero", "x", { track: false }));
    client.subscribe(listener);

    await client.initialize();
    expect(listener).toHaveBeenCalledTimes(1);

    variant = "b";
    await client.refresh();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveLastReturnedWith("b");
  });

  it("stops notifying after unsubscribing", async () => {
    const { client } = makeClient({ context: { units: { user: "u1" } } });
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    unsubscribe();
    await client.initialize();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("getStatus()", () => {
  it("reports readiness, the source and the last error", async () => {
    let fail = true;
    const { client } = makeClient({ context: { units: { user: "u1" } } }, () =>
      fail ? json({ error: "BAD_REQUEST" }, 400) : assigned(),
    );
    expect(client.getStatus()).toMatchObject({ ready: false, source: "none", lastError: null });

    await client.initialize();
    expect(client.getStatus().lastError?.code).toBe("bad_request");

    fail = false;
    await client.refresh();
    expect(client.getStatus()).toMatchObject({
      ready: true,
      source: "network",
      lastSuccessfulFetchAt: expect.any(Date),
    });
  });
});

describe("close()", () => {
  it("keeps serving reads but stops requests and enrollment", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, server, events, logger } = makeClient(
      { context: { units: { user: "u1" } }, refreshIntervalMs: 10 },
      () => assigned(exp("hero", "t")),
    );
    await client.initialize();
    const closing = client.close();
    expect(client.close()).toBe(closing);
    await closing;

    vi.advanceTimersByTime(100);
    expect(client.getVariant("hero", "c")).toBe("t");
    client.getVariant("hero", "c");
    await client.trackEnrollment("hero");
    await client.refresh();
    await client.initialize();
    await client.flush();

    expect(server.calls).toHaveLength(1);
    expect(events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "[cherto] the client is closed, so enrollment is no longer recorded",
    );
  });
});

describe("server rendering", () => {
  it("makes no request and uses no storage or timers without window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "Date"] });
    const globalFetch = vi.fn();
    const localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("fetch", globalFetch);
    vi.stubGlobal("localStorage", localStorage);
    const client = new ChertoClient({
      clientKey: "ck_test",
      context: { units: { user: "u1" } },
      bootstrap: bootstrapOf({ experiments: [{ key: "hero", variant: "t", unitId: "u1" }] }),
      logger: quietLogger(),
    });

    expect(client.getVariant("hero", "c")).toBe("t");
    expect(await client.initialize()).toEqual({ ok: true, source: "bootstrap" });
    await client.identify({ units: { user: "u2" } });
    await client.flush();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
