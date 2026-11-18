import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_BUFFER_DEFAULTS } from "./event-buffer.js";
import { resolveStorage } from "./storage.js";
import {
  API,
  PENDING_KEY,
  event,
  json,
  makeBuffer,
  memoryStorage,
  stubPage,
} from "./test-helpers.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("EventBuffer", () => {
  it("sends queued events after flushIntervalMs", async () => {
    const { buffer, server } = makeBuffer();
    const e = event();
    await buffer.send(e);
    expect(server.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(EVENT_BUFFER_DEFAULTS.flushIntervalMs);

    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].url).toBe(`${API}/v1/events`);
    expect(server.calls[0].init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer ck_test",
      "x-cherto-sdk": "browser/1.0.0",
    });
    expect(server.calls[0].init.keepalive).toBe(true);
    expect(server.calls[0].body).toEqual({ events: [e] });
  });

  it("sends a full batch at once", async () => {
    const { buffer, server } = makeBuffer({ maxBatchSize: 2 });
    for (let i = 0; i < 3; i++) void buffer.send(event());
    const batchSizes = () =>
      server.calls.map((call) => (call.body as { events: unknown[] }).events.length);

    await vi.advanceTimersByTimeAsync(0);
    expect(batchSizes()).toEqual([2]);
    await vi.advanceTimersByTimeAsync(EVENT_BUFFER_DEFAULTS.flushIntervalMs);
    expect(batchSizes()).toEqual([2, 1]);
  });

  it("flush() sends everything queued, in batches of maxBatchSize", async () => {
    const { buffer, server } = makeBuffer({ maxBatchSize: 2 });
    for (let i = 0; i < 5; i++) void buffer.send(event());
    await buffer.flush();
    expect(server.calls.map((c) => (c.body as { events: unknown[] }).events.length)).toEqual([
      2, 2, 1,
    ]);
  });

  it("drops the oldest event when the queue is full", async () => {
    const { buffer, sentEvents, logger } = makeBuffer({ maxQueueSize: 2 });
    const [a, b, c] = [event(), event(), event()];
    void buffer.send(a);
    void buffer.send(b);
    void buffer.send(c);
    await buffer.flush();
    expect(sentEvents()).toEqual([b, c]);
    expect(buffer.droppedCount).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      "[cherto] enrollment queue full: dropped the oldest 1 event(s)",
    );
  });

  it("retries a 5xx with the same events", async () => {
    const { buffer, server } = makeBuffer({}, (_, i) =>
      i === 0 ? json({ error: "UPSTREAM_UNAVAILABLE" }, 503) : json({}),
    );
    void buffer.send(event());
    await buffer.flush();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1].body).toEqual(server.calls[0].body);
    expect(buffer.droppedCount).toBe(0);
  });

  it("waits out Retry-After on a 429", async () => {
    const { buffer, server } = makeBuffer({}, (_, i) =>
      i === 0 ? json({ error: "RATE_LIMITED" }, 429, { "retry-after": "3" }) : json({}),
    );
    void buffer.send(event());
    const flushing = buffer.flush();
    await vi.advanceTimersByTimeAsync(2_900);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    await flushing;
    expect(server.calls).toHaveLength(2);
  });

  it("drops and reports a batch the API rejects", async () => {
    const { buffer, server, errors } = makeBuffer({}, () => json({ message: "rejected" }, 400));
    void buffer.send(event());
    await buffer.flush();

    expect(server.calls).toHaveLength(1);
    expect(buffer.droppedCount).toBe(1);
    expect(errors.map((e) => e.status)).toEqual([400]);
  });

  it("saves an undelivered batch for the next page load", async () => {
    const { storage, store } = memoryStorage();
    const safe = resolveStorage(storage, () => {});
    const { buffer, server, errors } = makeBuffer({ storage: safe }, () => json({}, 503));
    const e = event();
    void buffer.send(e);
    await buffer.flush();

    expect(server.calls).toHaveLength(EVENT_BUFFER_DEFAULTS.maxFlushAttempts);
    expect(JSON.parse(store.get(PENDING_KEY)!)).toEqual([e]);
    expect(errors.map((err) => [err.code, err.retryable])).toEqual([["bad_response", true]]);
    expect(buffer.droppedCount).toBe(0);

    const next = makeBuffer({ storage: safe });
    expect(store.has(PENDING_KEY), "a buffer that is never started takes nothing").toBe(true);
    next.buffer.start();
    expect(store.has(PENDING_KEY)).toBe(false);
    await vi.advanceTimersByTimeAsync(EVENT_BUFFER_DEFAULTS.flushIntervalMs);
    expect(next.sentEvents()).toEqual([e]);
  });

  it("drops and reports an undelivered batch without storage", async () => {
    const { buffer, errors } = makeBuffer({}, () => json({}, 503));
    void buffer.send(event());
    await buffer.flush();
    expect(buffer.droppedCount).toBe(1);
    expect(errors.map((e) => e.code)).toEqual(["bad_response"]);
  });

  describe("when the page is hidden or unloaded", () => {
    it("beacons queued events", async () => {
      const page = stubPage();
      const { buffer, server } = makeBuffer();
      const e = event();
      void buffer.send(e);

      page.hide();

      expect(page.sendBeacon).toHaveBeenCalledOnce();
      const [url, blob] = page.sendBeacon.mock.calls[0] as [string, Blob];
      expect(url).toBe(`${API}/v1/events`);
      expect(blob.type).toBe("text/plain");
      expect(JSON.parse(await blob.text())).toEqual({
        clientKey: "ck_test",
        sdkIdentity: "browser/1.0.0",
        events: [e],
      });
      await vi.advanceTimersByTimeAsync(EVENT_BUFFER_DEFAULTS.flushIntervalMs);
      expect(server.calls).toHaveLength(0);
    });

    it("beacons on pagehide too", () => {
      const page = stubPage();
      const { buffer } = makeBuffer();
      void buffer.send(event());
      page.unload();
      expect(page.sendBeacon).toHaveBeenCalledOnce();
    });

    it("sends saved events again once the page is visible", async () => {
      const page = stubPage(() => false);
      const { storage, store } = memoryStorage();
      const { buffer, sentEvents } = makeBuffer({ storage: resolveStorage(storage, () => {}) });
      const e = event();
      void buffer.send(e);
      page.hide();
      expect(store.has(PENDING_KEY)).toBe(true);

      page.show();
      await vi.advanceTimersByTimeAsync(EVENT_BUFFER_DEFAULTS.flushIntervalMs);
      expect(sentEvents()).toEqual([e]);
      expect(store.has(PENDING_KEY)).toBe(false);
    });

    it("stops listening once closed", async () => {
      const page = stubPage();
      const { buffer } = makeBuffer();
      await buffer.close();
      void buffer.send(event());
      page.hide();
      expect(page.sendBeacon).not.toHaveBeenCalled();
    });
  });
});
