import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChertoEnrollmentEvent } from "@cherto/core";
import { EventBuffer, enrollmentDedupeKey, type EventBufferOptions } from "./event-buffer.js";

function event(n: number, overrides: Partial<ChertoEnrollmentEvent> = {}): ChertoEnrollmentEvent {
  return {
    eventId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    experimentKey: "checkout-copy",
    variantKey: "treatment",
    unitId: `u_${n}`,
    startedAt: "2025-12-01T00:00:00.000Z",
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function keyFor(e: ChertoEnrollmentEvent, startedAt = "2026-01-01T00:00:00.000Z"): string {
  return enrollmentDedupeKey({ ...e, unitTypeKey: "user", startedAt });
}

type FetchArgs = [string, RequestInit];

function stubFetch(...responses: Array<() => Response | Promise<Response>>) {
  let call = 0;
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(() => {
    const next = responses[Math.min(call++, responses.length - 1)];
    return Promise.resolve().then(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const ok = () => new Response('{"accepted":1}', { status: 200 });

function sentEvents(
  fetchMock: ReturnType<typeof stubFetch>,
  call: number,
): ChertoEnrollmentEvent[] {
  const [, init] = fetchMock.mock.calls[call];
  return (JSON.parse(init.body as string) as { events: ChertoEnrollmentEvent[] }).events;
}

function makeBuffer(opts: Partial<EventBufferOptions> = {}) {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const buffer = new EventBuffer({
    serverKey: "sk_test",
    baseUrl: "https://api.example.com",
    logger,
    ...opts,
  });
  return { buffer, logError: logger.error };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EventBuffer batching", () => {
  it("sends queued events in one request after the flush interval", async () => {
    const fetchMock = stubFetch(ok);
    const { buffer } = makeBuffer();

    for (let i = 0; i < 20; i++) {
      await buffer.send(event(i));
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/events");
    expect(init.headers).toMatchObject({
      authorization: "Bearer sk_test",
      "content-type": "application/json",
      "x-cherto-sdk": expect.stringMatching(/^node\//),
    });
    expect(sentEvents(fetchMock, 0)).toHaveLength(20);
  });

  it("sends a full batch without waiting for the interval", async () => {
    const fetchMock = stubFetch(ok);
    const { buffer } = makeBuffer({ maxBatchSize: 2 });

    for (let i = 0; i < 4; i++) void buffer.send(event(i));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentEvents(fetchMock, 0).map((e) => e.unitId)).toEqual(["u_0", "u_1"]);
    expect(sentEvents(fetchMock, 1).map((e) => e.unitId)).toEqual(["u_2", "u_3"]);
  });

  it("drops the oldest events when the queue is full", async () => {
    const fetchMock = stubFetch(ok);
    const { buffer, logError } = makeBuffer({ maxQueueSize: 3 });

    for (let i = 0; i < 5; i++) void buffer.send(event(i), keyFor(event(i)));
    await buffer.flush();

    expect(sentEvents(fetchMock, 0).map((e) => e.unitId)).toEqual(["u_2", "u_3", "u_4"]);
    expect(buffer.droppedCount).toBe(2);
    expect(logError).toHaveBeenCalledWith(
      "[cherto] enrollment queue full: dropped the oldest 2 event(s)",
    );

    void buffer.send(event(0), keyFor(event(0)));
    await buffer.flush();
    expect(sentEvents(fetchMock, 1).map((e) => e.unitId)).toEqual(["u_0"]);
  });
});

describe("EventBuffer deduplication", () => {
  it("sends an enrollment recorded many times once", async () => {
    const fetchMock = stubFetch(ok);
    const { buffer } = makeBuffer();

    for (let i = 0; i < 5; i++)
      void buffer.send(event(100 + i, { unitId: "u_1" }), keyFor(event(1)));
    await buffer.flush();

    expect(sentEvents(fetchMock, 0)).toHaveLength(1);
  });

  it("treats a restarted run as a new enrollment", async () => {
    const fetchMock = stubFetch(ok);
    const { buffer } = makeBuffer();

    void buffer.send(event(1), keyFor(event(1), "2026-01-01T00:00:00.000Z"));
    void buffer.send(event(1), keyFor(event(1), "2026-02-01T00:00:00.000Z"));
    await buffer.flush();

    expect(sentEvents(fetchMock, 0)).toHaveLength(2);
  });
});

describe("EventBuffer retries", () => {
  it("retries a failed request with backoff", async () => {
    const fetchMock = stubFetch(
      () => new Response("unavailable", { status: 503 }),
      () => Promise.reject(new TypeError("fetch failed")),
      ok,
    );
    const { buffer, logError } = makeBuffer({ flushRetryBaseDelayMs: 100 });

    void buffer.send(event(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const bodies = fetchMock.mock.calls.map(([, init]) => init.body);
    expect(new Set(bodies).size).toBe(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("waits at least as long as the server's Retry-After", async () => {
    const fetchMock = stubFetch(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "5" } }),
      ok,
    );
    const { buffer } = makeBuffer({ flushRetryBaseDelayMs: 100 });

    void buffer.send(event(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops a batch after maxFlushAttempts and reports it", async () => {
    const fetchMock = stubFetch(() => new Response("down", { status: 500 }));
    const onError = vi.fn();
    const { buffer, logError } = makeBuffer({
      maxFlushAttempts: 2,
      flushRetryBaseDelayMs: 0,
      onError,
    });

    void buffer.send(event(1), keyFor(event(1)));
    await buffer.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledExactlyOnceWith(
      "[cherto] dropped 1 enrollment event(s) after 2 attempts",
      { err: expect.objectContaining({ code: "bad_response" }) },
    );
    expect(buffer.droppedCount).toBe(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "bad_response" }),
    );

    void buffer.send(event(1), keyFor(event(1)));
    await buffer.flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([400, 401, 403, 413])(
    "does not retry a batch the API rejects with %i",
    async (status) => {
      const fetchMock = stubFetch(() => new Response("no", { status }));
      const { buffer, logError } = makeBuffer({ flushRetryBaseDelayMs: 0 });

      void buffer.send(event(1));
      await buffer.flush();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(logError).toHaveBeenCalledWith(
        "[cherto] dropped 1 enrollment event(s) (not retryable)",
        {
          err: expect.objectContaining({ status }),
        },
      );
    },
  );

  it("send() never rejects", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const { buffer } = makeBuffer({ maxFlushAttempts: 1 });

    await expect(buffer.send(event(1))).resolves.toBeUndefined();
    await expect(buffer.flush()).resolves.toBeUndefined();
  });
});

describe("EventBuffer flush and close", () => {
  it("flush() sends queued events without waiting for the interval", async () => {
    const fetchMock = stubFetch(ok);
    const { buffer } = makeBuffer({ flushIntervalMs: 60_000 });

    void buffer.send(event(1));
    await buffer.flush();
    await buffer.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("close() sends what is queued, then ignores new events", async () => {
    const fetchMock = stubFetch(ok);
    const { buffer } = makeBuffer();

    void buffer.send(event(1));
    await buffer.close();
    void buffer.send(event(2));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentEvents(fetchMock, 0).map((e) => e.unitId)).toEqual(["u_1"]);
  });

  it("close() is idempotent", () => {
    stubFetch(ok);
    const { buffer } = makeBuffer();

    expect(buffer.close()).toBe(buffer.close());
  });
});
