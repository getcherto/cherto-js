import type {
  ChertoBootstrap,
  ChertoContextInput,
  ChertoEnrollmentTrackingConfig,
  ChertoError,
  ChertoLogger,
} from "@cherto/core";

/** Where the client persists assignments and undelivered enrollment. `localStorage` fits. */
export type ChertoStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Options for constructing a {@link ChertoClient}. */
export interface ChertoClientOptions {
  /**
   * The organization's client key (`ck_…`), from Settings → SDK & keys → Client key. It is
   * public, so it is safe in browser code. A server key (`sk_…`) is a secret and is refused.
   */
  clientKey: string;
  /**
   * Base URL of the Cherto SDK API.
   * @defaultValue "https://api.getcherto.com"
   */
  apiUrl?: string | undefined;
  /**
   * The context to load assignments for. Assignments this browser saved for the same context
   * are served from construction until fresh ones load; once older than `refreshIntervalMs`,
   * they are enrolled only when a load confirms them. A context with no units loads nothing.
   */
  context?: ChertoContextInput | undefined;
  /**
   * Assignments evaluated on the server by `ctx.getBootstrap()` in `@cherto/node`, served
   * from construction. With `context` too, they are used only when `context` has every unit
   * the bootstrap was generated for, with the same id. An invalid bootstrap is reported and
   * ignored.
   */
  bootstrap?: ChertoBootstrap | undefined;
  /**
   * The longest `initialize()`, `identify()` and `refresh()` wait for assignments, in
   * milliseconds, retries included. A response arriving up to 10 seconds later is still applied.
   * @defaultValue 3_000
   */
  initTimeoutMs?: number | undefined;
  /**
   * How old loaded assignments may get, in milliseconds, before a read refreshes them in the
   * background. The read itself is served what is loaded.
   * @defaultValue 60_000
   */
  refreshIntervalMs?: number | undefined;
  /**
   * How enrollment events are delivered. `"cherto"` sends them to Cherto with `clientKey`, in
   * batches; `"custom"` calls `enrollmentTracking.logger`; `"none"` sends nothing, for
   * enrollment you record yourself. `"custom"` without a logger function is reported and
   * treated as `"none"`.
   * @defaultValue `{ mode: "cherto" }`
   */
  enrollmentTracking?: ChertoEnrollmentTrackingConfig | undefined;
  /** Tuning for `"cherto"` enrollment delivery. */
  eventBuffer?:
    | {
        /**
         * How long the queue collects events before sending them, in milliseconds. Events are
         * also sent when a batch fills, and when the page is hidden or unloaded.
         * @defaultValue 5_000
         */
        flushIntervalMs?: number | undefined;
        /**
         * Events per request, capped at 5,000. A full batch is sent at once.
         * @defaultValue 20
         */
        maxBatchSize?: number | undefined;
        /**
         * Events held while waiting to be sent. When full, the oldest is dropped.
         * @defaultValue 500
         */
        maxQueueSize?: number | undefined;
        /**
         * Attempts per batch, the first send included. A batch still undelivered is saved to
         * `storage` and sent on a later page load; a rejected batch is dropped.
         * @defaultValue 3
         */
        maxFlushAttempts?: number | undefined;
        /**
         * Delay before the first retry, in milliseconds, doubling with each attempt and
         * jittered down by up to half. A longer `Retry-After` wins. No delay exceeds 60 seconds.
         * @defaultValue 1_000
         */
        flushRetryBaseDelayMs?: number | undefined;
      }
    | undefined;
  /**
   * Where assignments and undelivered enrollment are saved between page loads. Attribute
   * values are never saved, only a digest of the context. `null` saves nothing.
   * @defaultValue `localStorage`, when it is usable
   */
  storage?: ChertoStorage | null | undefined;
  /**
   * Make no network requests and use no timers or storage, for tests and local development.
   * The client serves `bootstrap`, or callers' defaults; `"custom"` tracking still calls your
   * logger and `"cherto"` tracking sends nothing. Outside a browser page or web worker, as in
   * server rendering, and without a `fetch` option, the client behaves as offline.
   * @defaultValue false
   */
  offline?: boolean | undefined;
  /**
   * Receives every message the SDK logs.
   * @defaultValue console
   */
  logger?: ChertoLogger | undefined;
  /**
   * Called with each failure after it is logged: an invalid option, a failed load of
   * assignments, including one a read starts in the background, an enrollment batch dropped or
   * saved for a later page load, or a `"custom"` enrollment logger that threw or rejected.
   */
  onError?: ((err: ChertoError) => void) | undefined;
  /**
   * The `fetch` to send requests with.
   * @defaultValue globalThis.fetch
   */
  fetch?: typeof fetch | undefined;
  /** @internal Identifies a wrapping SDK in the `X-Cherto-SDK` header. */
  sdkWrapper?: { name: string; version: string };
}

/** What `initialize()`, `identify()` and `refresh()` resolve with. */
export interface ChertoInitResult {
  /**
   * Whether the client is serving the current answer for its context, which may be no
   * assignments at all: offline without a bootstrap, or for a context with no units.
   */
  ok: boolean;
  /** Where the assignments being served came from; `"none"` means callers' defaults. */
  source: "network" | "cache" | "bootstrap" | "none";
  /** Why the call failed, when it did. */
  error?: ChertoError;
}

/** What {@link ChertoClient.getStatus} returns. */
export interface ChertoClientStatus {
  /** Whether assignments are loaded. While `false`, every read serves the caller's default. */
  ready: boolean;
  /** Where the assignments being served came from. */
  source: "network" | "cache" | "bootstrap" | "none";
  /** The latest failure, or `null`. A later success doesn't clear it. */
  lastError: ChertoError | null;
  /** When `lastError` was reported, or `null`; compare it with `lastSuccessfulFetchAt`. */
  lastErrorAt: Date | null;
  /** When assignments for the current context last loaded from the network, or `null`. */
  lastSuccessfulFetchAt: Date | null;
  /** `"cherto"` enrollment events dropped or rejected since construction. */
  droppedEvents: number;
}
