import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ConfigPoller } from "./poller.js";
import { ChertoError } from "@cherto/core";
import type { Config } from "./types.js";

const MOCK_CONFIG: Config = {
  version: 5,
  configHash: "aabbcc",
  experiments: [],
};

function mockFetch(responses: Array<() => Response>) {
  let call = 0;
  return vi.fn(() => Promise.resolve(responses[call++ % responses.length]()));
}

function jsonResponse(body: unknown, status = 200, etag?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (etag) headers.set("etag", etag);
  return new Response(JSON.stringify(body), { status, headers });
}

function notModifiedResponse(): Response {
  return new Response(null, { status: 304 });
}

function errorResponse(status: number, body = "error"): Response {
  return new Response(body, { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConfigPoller.fetch", () => {
  it("fetches and stores the config", async () => {
    const fetchMock = mockFetch([() => jsonResponse(MOCK_CONFIG, 200, 'W/"org-5"')]);
    vi.stubGlobal("fetch", fetchMock);

    const poller = new ConfigPoller("sk_test", "https://api.example.com");
    const updated = await poller.fetch();

    expect(updated).toBe(true);
    expect(poller.config).toEqual(MOCK_CONFIG);
  });

  it("sends the server key as a bearer token", async () => {
    const fetchMock = mockFetch([() => jsonResponse(MOCK_CONFIG)]);
    vi.stubGlobal("fetch", fetchMock);

    const poller = new ConfigPoller("sk_abc123", "https://api.example.com");
    await poller.fetch();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer sk_abc123");
  });

  it("sends the last ETag as If-None-Match", async () => {
    const fetchMock = mockFetch([
      () => jsonResponse(MOCK_CONFIG, 200, 'W/"org-5"'),
      () => notModifiedResponse(),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const poller = new ConfigPoller("sk_test", "https://api.example.com");
    await poller.fetch();
    await poller.fetch();

    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["if-none-match"]).toBe('W/"org-5"');
  });

  it("keeps the config on a 304", async () => {
    const fetchMock = mockFetch([
      () => jsonResponse(MOCK_CONFIG, 200, 'W/"org-5"'),
      () => notModifiedResponse(),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const poller = new ConfigPoller("sk_test", "https://api.example.com");
    await poller.fetch();

    const updated = await poller.fetch();
    expect(updated).toBe(false);
    expect(poller.config).toEqual(MOCK_CONFIG);
  });
});

describe("ConfigPoller.fetch errors", () => {
  it.each([
    [401, "unauthorized"],
    [429, "rate_limited"],
    [500, "bad_response"],
  ])("rejects HTTP %i with code %s", async (status, code) => {
    vi.stubGlobal("fetch", mockFetch([() => errorResponse(status)]));

    const poller = new ConfigPoller("sk_test", "https://api.example.com");
    const err = await poller.fetch().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ChertoError);
    expect((err as ChertoError).code).toBe(code);
    expect((err as ChertoError).status).toBe(status);
    expect((err as ChertoError).name).toBe("ChertoError");
    expect((err as ChertoError).message).toContain(`HTTP ${status}`);
  });

  it("carries the server's Retry-After on a 429", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        () => new Response("rate limited", { status: 429, headers: { "retry-after": "5" } }),
      ]),
    );

    const poller = new ConfigPoller("sk_test", "https://api.example.com");
    const err = await poller.fetch().catch((e: unknown) => e);

    expect((err as ChertoError).code).toBe("rate_limited");
    expect((err as ChertoError).retryAfterMs).toBe(5000);
  });

  it("wraps a network failure, keeping the original as cause", async () => {
    const underlying = new TypeError("fetch failed");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(underlying)),
    );

    const poller = new ConfigPoller("sk_test", "http://127.0.0.1:9");
    const err = await poller.fetch().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ChertoError);
    expect((err as ChertoError).code).toBe("network");
    expect((err as ChertoError).cause).toBe(underlying);
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it("reports a timed-out request as `timeout`", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(abort)),
    );

    const poller = new ConfigPoller("sk_test", "https://api.example.com");
    const err = await poller.fetch().catch((e: unknown) => e);

    expect((err as ChertoError).code).toBe("timeout");
  });
});

describe("ConfigPoller polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startPolling(fetchMock: ReturnType<typeof vi.fn>) {
    const poller = new ConfigPoller("sk_test", "https://api.example.com");
    vi.stubGlobal("fetch", mockFetch([() => jsonResponse(MOCK_CONFIG)]));
    await poller.fetch();
    vi.stubGlobal("fetch", fetchMock);
    poller.start(10_000);
    return poller;
  }

  it("fetches the config once per interval", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(MOCK_CONFIG)));
    const poller = await startPolling(fetchMock);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("waits twice the interval after a failed poll", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(errorResponse(503)))
      .mockImplementation(() => Promise.resolve(jsonResponse(MOCK_CONFIG)));
    const poller = await startPolling(fetchMock);

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it("stops polling after stop()", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(MOCK_CONFIG)));
    const poller = await startPolling(fetchMock);

    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
