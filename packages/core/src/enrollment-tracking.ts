import { ChertoError, isChertoError } from "./errors.js";
import { callGuarded } from "./logger.js";
import type { ChertoEnrollmentEvent, ChertoEnrollmentTrackingConfig } from "./types.js";

/** The error reported for a `"custom"` enrollment logger that threw or rejected. */
export function enrollmentLoggerError(err: unknown): ChertoError {
  if (isChertoError(err)) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new ChertoError("callback_failed", `[cherto] the enrollment logger failed: ${detail}`, {
    cause: err,
  });
}

/** Delivers enrollment events to Cherto's `POST /v1/events`. */
export interface EnrollmentTransport {
  /** Events sharing a `dedupeKey` record the same enrollment, so one may be skipped. */
  send(event: ChertoEnrollmentEvent, dedupeKey?: string): Promise<void>;
}

export type EnrollmentTrackerOptions = ChertoEnrollmentTrackingConfig & {
  /** Required when `mode` is `"cherto"`; ignored otherwise. */
  transport?: EnrollmentTransport;
  /** Called when a delivery throws or rejects. What it throws itself is ignored. */
  onError?: (err: unknown, event: ChertoEnrollmentEvent) => void;
};

type Deliver = (event: ChertoEnrollmentEvent, dedupeKey: string | undefined) => unknown;

/**
 * Dispatches enrollment events by tracking mode and tracks in-flight deliveries for `flush()`.
 * Delivery itself (HTTP, batching, retries) belongs to each SDK's transport.
 */
export class EnrollmentTracker {
  private readonly deliver: Deliver;
  private readonly onError: ((err: unknown, event: ChertoEnrollmentEvent) => void) | undefined;
  private readonly pending = new Set<Promise<void>>();

  constructor(opts: EnrollmentTrackerOptions) {
    this.deliver = deliveryOf(opts);
    this.onError = opts.onError;
  }

  /**
   * Dispatch one event. Resolves once the logger or transport accepts it and never rejects:
   * failures go to `onError`.
   */
  track(event: ChertoEnrollmentEvent, dedupeKey?: string): Promise<void> {
    // Deferred so a synchronous throw becomes a rejection instead of escaping.
    const promise = Promise.resolve()
      .then(() => this.deliver(event, dedupeKey))
      .then(
        () => {},
        (err: unknown) => {
          callGuarded(
            () => this.onError?.(err, event),
            () => {},
          );
        },
      );
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
    return promise;
  }

  /** Await every `track()` still in progress. A buffering transport needs its own flush. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}

// Checked at run time too, for callers without the types.
function deliveryOf(opts: EnrollmentTrackerOptions): Deliver {
  switch (opts.mode) {
    case "custom": {
      const { logger } = opts;
      if (typeof logger !== "function") {
        throw new Error(
          '[cherto] enrollmentTracking.logger must be a function when mode is "custom"',
        );
      }
      return (event) => logger(event);
    }
    case "cherto": {
      const { transport } = opts;
      if (!transport) {
        throw new Error('[cherto] an enrollment transport is required when mode is "cherto"');
      }
      return (event, dedupeKey) => transport.send(event, dedupeKey);
    }
    default:
      return () => undefined;
  }
}
