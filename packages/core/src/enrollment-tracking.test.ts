import { describe, expect, it, vi } from "vitest";
import { ChertoError } from "./errors.js";
import {
  EnrollmentTracker,
  enrollmentLoggerError,
  type EnrollmentTrackerOptions,
} from "./enrollment-tracking.js";
import type { ChertoEnrollmentEvent } from "./types.js";

function makeEvent(overrides: Partial<ChertoEnrollmentEvent> = {}): ChertoEnrollmentEvent {
  return {
    eventId: "evt_1",
    experimentKey: "checkout-copy",
    variantKey: "treatment",
    unitId: "u_123",
    startedAt: "2025-12-01T00:00:00.000Z",
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("EnrollmentTracker", () => {
  it("sends nothing in none mode", async () => {
    const send = vi.fn();
    const tracker = new EnrollmentTracker({ mode: "none", transport: { send } });

    await tracker.track(makeEvent());

    expect(send).not.toHaveBeenCalled();
  });

  it.each([undefined, "dedupe-key"])(
    "sends through the transport in cherto mode, with dedupe key %s",
    async (dedupeKey) => {
      const send = vi.fn().mockResolvedValue(undefined);
      const tracker = new EnrollmentTracker({ mode: "cherto", transport: { send } });
      const event = makeEvent();

      await tracker.track(event, dedupeKey);

      expect(send).toHaveBeenCalledExactlyOnceWith(event, dedupeKey);
    },
  );

  it("calls the logger in custom mode", async () => {
    const logger = vi.fn().mockResolvedValue(undefined);
    const tracker = new EnrollmentTracker({ mode: "custom", logger });
    const event = makeEvent();

    await tracker.track(event);

    expect(logger).toHaveBeenCalledExactlyOnceWith(event);
  });

  it.each([
    ["missing", undefined],
    ["a string", "console"],
    ["an object", { log: () => {} }],
    ["true", true],
  ])("throws at construction in custom mode when the logger is %s", (_, logger) => {
    expect(() => new EnrollmentTracker({ mode: "custom", logger: logger as never })).toThrow(
      /logger must be a function/,
    );
  });

  it("throws at construction in cherto mode without a transport", () => {
    expect(() => new EnrollmentTracker({ mode: "cherto" })).toThrow(/transport/);
  });

  it.each<[string, (failure: Error) => EnrollmentTrackerOptions]>([
    [
      "a rejecting transport",
      (failure) => ({ mode: "cherto", transport: { send: () => Promise.reject(failure) } }),
    ],
    [
      "a throwing transport",
      (failure) => ({
        mode: "cherto",
        transport: {
          send: () => {
            throw failure;
          },
        },
      }),
    ],
    [
      "a throwing logger",
      (failure) => ({
        mode: "custom",
        logger: () => {
          throw failure;
        },
      }),
    ],
  ])("routes %s to onError instead of rejecting", async (_, config) => {
    const failure = new Error("boom");
    const onError = vi.fn();
    const tracker = new EnrollmentTracker({ ...config(failure), onError });
    const event = makeEvent();

    await expect(tracker.track(event)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure, event);
  });

  it("flush waits for a track call nobody awaited", async () => {
    let resolveSend: () => void = () => {};
    const send = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const tracker = new EnrollmentTracker({ mode: "cherto", transport: { send } });

    void tracker.track(makeEvent());

    let flushed = false;
    const flushPromise = tracker.flush().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(flushed).toBe(false);

    resolveSend();
    await flushPromise;
    expect(flushed).toBe(true);
  });

  it("flush resolves when nothing is in flight", async () => {
    const tracker = new EnrollmentTracker({ mode: "none" });
    await expect(tracker.flush()).resolves.toBeUndefined();
  });
});

describe("enrollmentLoggerError", () => {
  it("reports a failing logger as callback_failed, which isn't retryable", () => {
    const thrown = new Error("db down");
    const err = enrollmentLoggerError(thrown);
    expect(err).toMatchObject({ code: "callback_failed", retryable: false, cause: thrown });
    expect(err.message).toBe("[cherto] the enrollment logger failed: db down");
  });

  it("passes a ChertoError through unchanged", () => {
    const thrown = new ChertoError("network", "x");
    expect(enrollmentLoggerError(thrown)).toBe(thrown);
  });
});
