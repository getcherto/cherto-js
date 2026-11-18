import {
  ChertoError,
  EnrollmentTracker,
  catchRejection,
  copyJson,
  createWarnOnce,
  enrollmentLoggerError,
  isRecord,
  isRetryable,
  loggerFrom,
  untilDeadline,
  type ChertoContext,
  type ChertoEnrollmentEvent,
  type ChertoEnrollmentTrackingConfig,
  type WarnFn,
} from "@cherto/core";
import { ConfigPoller, DEFAULT_API_URL } from "./poller.js";
import { parseConfig, sourceOf } from "./config.js";
import { NodeChertoContext, type EnrollmentSink } from "./context.js";
import { EventBuffer, type EventBufferOptions } from "./event-buffer.js";
import type {
  ChertoClientOptions,
  ChertoClientStatus,
  ChertoConfigSnapshot,
  ChertoContextInput,
  ChertoLogger,
  Config,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const INIT_FAILURE_MODES: readonly string[] = ["throw", "serveDefaults"];
const TRACKING_MODES: readonly string[] = ["none", "cherto", "custom"];
const MIN_POLL_INTERVAL_MS = 5_000;

/**
 * The Cherto Node.js server SDK client. Fetches the organization's experiment config,
 * polls for changes and evaluates experiments locally, with no request per read. Create
 * one at startup with {@link ChertoClient.init} and share it.
 */
export class ChertoClient {
  private readonly poller: ConfigPoller;
  private readonly tracker: EnrollmentTracker;
  private readonly buffer: EventBuffer | undefined;
  private readonly warn: WarnFn;
  private readonly errors: ErrorReporter;
  private readonly sendsEnrollment: boolean;
  private readonly sink: EnrollmentSink = {
    track: (event, dedupeKey) => this.track(event, dedupeKey),
    sends: () => this.sendsEnrollment && this.closing === null,
  };
  private closing: Promise<void> | null = null;
  private releaseServerKey: () => void = () => {};

  private constructor(parts: {
    poller: ConfigPoller;
    tracker: EnrollmentTracker;
    buffer: EventBuffer | undefined;
    warn: WarnFn;
    errors: ErrorReporter;
    sendsEnrollment: boolean;
  }) {
    this.poller = parts.poller;
    this.tracker = parts.tracker;
    this.buffer = parts.buffer;
    this.warn = parts.warn;
    this.errors = parts.errors;
    this.sendsEnrollment = parts.sendsEnrollment;
  }

  /**
   * Create a client, fetch its first config and start background polling. Retryable
   * failures are retried for up to `initTimeoutMs`. Resolves without waiting for the
   * network with `initialConfig` or `offline: true`.
   *
   * @throws {@link ChertoError} `bad_config`, `unauthorized` or `bad_request` at once, without
   *   retrying. `network`, `timeout`, `rate_limited` or `bad_response` when no config
   *   arrived in time, unless `onInitFailure` is `"serveDefaults"`.
   */
  static async init(opts: ChertoClientOptions): Promise<ChertoClient> {
    if (!isRecord(opts)) {
      throw new ChertoError("bad_config", "[cherto] init() takes an options object");
    }
    if (opts.offline !== undefined && typeof opts.offline !== "boolean") {
      throw new ChertoError(
        "bad_config",
        `[cherto] offline must be a boolean, got ${JSON.stringify(opts.offline)}`,
      );
    }
    const offline = opts.offline === true;
    const logger = loggerOf(opts.logger);
    if (opts.onError !== undefined && typeof opts.onError !== "function") {
      throw new ChertoError("bad_config", "[cherto] onError must be a function");
    }
    const errors = new ErrorReporter(logger, opts.onError);
    const trackingMode = opts.enrollmentTracking?.mode ?? "cherto";
    if (!TRACKING_MODES.includes(trackingMode)) {
      throw new ChertoError(
        "bad_config",
        `[cherto] enrollmentTracking.mode must be "cherto", "custom" or "none", got ${JSON.stringify(trackingMode)}`,
      );
    }
    checkServerKey(opts.serverKey, offline);
    if ((opts as { clientKey?: unknown }).clientKey !== undefined) {
      logger.warn(
        "[cherto] clientKey is no longer used: enrollment is sent with serverKey. Remove clientKey.",
      );
    }
    if ((opts as { pollInterval?: unknown }).pollInterval !== undefined) {
      logger.warn("[cherto] pollInterval is ignored: it was renamed pollIntervalMs.");
    }
    const onInitFailure = opts.onInitFailure ?? "throw";
    if (!INIT_FAILURE_MODES.includes(onInitFailure)) {
      throw new ChertoError(
        "bad_config",
        `[cherto] onInitFailure must be "throw" or "serveDefaults", got ${JSON.stringify(onInitFailure)}`,
      );
    }
    const pollIntervalMs = pollIntervalOf(opts.pollIntervalMs, logger);
    const initTimeoutMs = positiveDurationOf(
      "initTimeoutMs",
      opts.initTimeoutMs,
      DEFAULT_INIT_TIMEOUT_MS,
    );

    const rawApiUrl = opts.apiUrl ?? DEFAULT_API_URL;
    let parsedApiUrl: URL;
    try {
      parsedApiUrl = new URL(rawApiUrl);
    } catch (err) {
      throw new ChertoError("bad_config", `[cherto] apiUrl is not a valid URL: ${rawApiUrl}`, {
        cause: err,
      });
    }
    if (parsedApiUrl.protocol !== "http:" && parsedApiUrl.protocol !== "https:") {
      throw new ChertoError(
        "bad_config",
        `[cherto] apiUrl must be http(s), got "${parsedApiUrl.protocol}": ${rawApiUrl}`,
      );
    }
    // A trailing slash would make `/v1/events` post to `//v1/events`.
    const apiUrl = parsedApiUrl.href.replace(/\/+$/, "");
    const warn = createWarnOnce(logger);
    const initialConfig = initialConfigOf(opts.initialConfig, warn);
    const bufferOptions = eventBufferOptions(opts.eventBuffer);
    const buffer =
      trackingMode === "cherto" && !offline
        ? new EventBuffer({
            serverKey: opts.serverKey,
            baseUrl: apiUrl,
            logger,
            onError: (err) => errors.report(err),
            ...bufferOptions,
          })
        : undefined;
    const tracking: ChertoEnrollmentTrackingConfig =
      opts.enrollmentTracking?.mode === "custom"
        ? opts.enrollmentTracking
        : { mode: buffer ? "cherto" : "none" };
    let tracker: EnrollmentTracker;
    try {
      tracker = new EnrollmentTracker({
        ...tracking,
        ...(buffer ? { transport: buffer } : {}),
        onError: (err, event) => {
          logger.error("[cherto] enrollment logger failed", {
            experimentKey: event.experimentKey,
            err,
          });
          errors.report(enrollmentLoggerError(err));
        },
      });
    } catch (err) {
      throw new ChertoError("bad_config", err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }

    const poller = new ConfigPoller(opts.serverKey, apiUrl, warn, (err) => {
      logger.error("[cherto] config poll failed (will retry)", { err });
      errors.report(err);
    });
    poller.config = initialConfig;
    const client = new ChertoClient({
      poller,
      tracker,
      buffer,
      warn,
      errors,
      sendsEnrollment: tracking.mode !== "none",
    });
    if (offline) return client;
    if (initialConfig !== null) {
      poller.start(pollIntervalMs, 0);
    } else {
      try {
        await poller.fetchWithRetry(initTimeoutMs);
        poller.start(pollIntervalMs);
      } catch (err) {
        if (onInitFailure === "throw" || !isRetryable(err)) throw err;
        logger.error(
          "[cherto] init couldn't fetch a config; serving defaults until a fetch succeeds",
          { err },
        );
        errors.report(err);
        poller.startAfterFailure(pollIntervalMs, err);
      }
    }
    client.releaseServerKey = claimServerKey(opts.serverKey, logger);
    return client;
  }

  /**
   * Bind units and attributes for one request. Every read off the returned context
   * evaluates against the same config snapshot.
   */
  context(input: ChertoContextInput): ChertoContext {
    return new NodeChertoContext({
      input,
      config: this.poller.config,
      tracker: this.sink,
      warn: this.warn,
    });
  }

  /**
   * The loaded config in the form `initialConfig` accepts, or `null` before one is loaded.
   * Save it to start a later client or a test with the same assignments and no network wait.
   * Each call returns a new copy.
   */
  getConfigSnapshot(): ChertoConfigSnapshot | null {
    const source = this.poller.config === null ? undefined : sourceOf(this.poller.config);
    return source === undefined
      ? null
      : (JSON.parse(JSON.stringify(source)) as ChertoConfigSnapshot);
  }

  /** A snapshot of the client's health, for a readiness probe or a metric. */
  getStatus(): ChertoClientStatus {
    const fetchedAt = this.poller.lastSuccessfulFetchAt;
    const erredAt = this.errors.lastAt;
    return {
      ready: this.poller.config !== null,
      configVersion: this.poller.config?.version ?? 0,
      lastSuccessfulFetchAt: fetchedAt === null ? null : new Date(fetchedAt),
      lastError: this.errors.last,
      lastErrorAt: erredAt === null ? null : new Date(erredAt),
      droppedEvents: this.buffer?.droppedCount ?? 0,
    };
  }

  /**
   * Send every enrollment recorded before the call and wait until each is delivered or given
   * up on; enrollments recorded while it waits may be left to the background.
   * Retries can take minutes when the API sends `Retry-After`, so before a serverless
   * function's process is frozen, pass `timeoutMs`: at that deadline this resolves, and what
   * is undelivered stays queued. A pending retry keeps the process alive while this waits.
   *
   * @param opts - `timeoutMs`: the longest to wait, in milliseconds; `0` or less doesn't wait.
   *   No limit by default.
   * @throws {@link ChertoError} `bad_config` when `timeoutMs` isn't a number. Never otherwise.
   */
  async flush(opts?: { timeoutMs?: number | undefined }): Promise<void> {
    const deadline = Date.now() + timeoutOf("flush", opts?.timeoutMs, Infinity);
    await untilDeadline(this.tracker.flush(), deadline - Date.now());
    await this.buffer?.flush(deadline - Date.now());
  }

  /**
   * Stop polling and send queued enrollments, giving each batch one last attempt instead of
   * waiting to retry it. Resolves once they are delivered, or at the deadline, leaving any
   * delivery still in flight to finish in the background. Contexts keep serving the last
   * config but record no further enrollment. Later calls return the first call's promise.
   *
   * @param opts - `timeoutMs`: the longest to wait, in milliseconds; `0` or less doesn't wait
   *   and `Infinity` waits for every delivery. 10 seconds by default.
   * @throws {@link ChertoError} `bad_config` when `timeoutMs` isn't a number, without closing.
   *   Never otherwise.
   */
  close(opts?: { timeoutMs?: number | undefined }): Promise<void> {
    if (this.closing !== null) return this.closing;
    let timeoutMs: number;
    try {
      timeoutMs = timeoutOf("close", opts?.timeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
    } catch (err) {
      return Promise.reject(err);
    }
    const deadline = Date.now() + timeoutMs;
    this.closing = (async () => {
      this.releaseServerKey();
      this.poller.stop();
      await untilDeadline(this.tracker.flush(), timeoutMs);
      // Closed even past the deadline, so the buffer stops accepting events and retrying.
      await untilDeadline(this.buffer?.close() ?? Promise.resolve(), deadline - Date.now());
    })();
    return this.closing;
  }

  private track(event: ChertoEnrollmentEvent, dedupeKey: string): Promise<void> {
    if (this.closing !== null) {
      this.warn({}, "the client is closed, so enrollment is no longer recorded");
      return Promise.resolve();
    }
    return this.tracker.track(event, dedupeKey);
  }
}

function checkServerKey(serverKey: unknown, offline: boolean): void {
  if (serverKey !== undefined && typeof serverKey !== "string") {
    throw new ChertoError("bad_config", "[cherto] serverKey must be a string");
  }
  if (!serverKey && !offline) {
    throw new ChertoError("bad_config", "[cherto] serverKey is required: pass a server key (sk_…)");
  }
  if (serverKey?.startsWith("ck_")) {
    throw new ChertoError(
      "bad_config",
      "[cherto] serverKey is a client key (ck_…), which belongs in browser code. Pass a server " +
        "key (sk_…), from Settings → SDK & keys → Server keys.",
    );
  }
}

const openClientsByServerKey = new Map<string, number>();
const warnedServerKeys = new Set<string>();

/** Counts an open client for `serverKey`, warning once per key about a second. */
function claimServerKey(serverKey: string, logger: ChertoLogger): () => void {
  const open = openClientsByServerKey.get(serverKey) ?? 0;
  openClientsByServerKey.set(serverKey, open + 1);
  if (open > 0 && !warnedServerKeys.has(serverKey)) {
    warnedServerKeys.add(serverKey);
    logger.warn(
      "[cherto] another ChertoClient with this serverKey is already open in this process. " +
        "Create one client at startup and share it: each client polls for config and " +
        "sends enrollment on its own.",
    );
  }
  return () => {
    const remaining = (openClientsByServerKey.get(serverKey) ?? 1) - 1;
    if (remaining > 0) openClientsByServerKey.set(serverKey, remaining);
    else openClientsByServerKey.delete(serverKey);
  };
}

class ErrorReporter {
  last: ChertoError | null = null;
  lastAt: number | null = null;

  constructor(
    private readonly logger: ChertoLogger,
    private readonly onError: ((err: ChertoError) => void) | undefined,
  ) {}

  report(err: unknown): void {
    if (!(err instanceof ChertoError)) return;
    this.last = err;
    this.lastAt = Date.now();
    if (this.onError === undefined) return;
    const logThrown = (thrown: unknown) =>
      this.logger.error("[cherto] onError threw", { err: thrown });
    try {
      catchRejection(this.onError(err), logThrown);
    } catch (thrown) {
      logThrown(thrown);
    }
  }
}

function initialConfigOf(value: unknown, warn: WarnFn): Config | null {
  if (value === undefined) return null;
  try {
    return parseConfig(copyJson(value), warn);
  } catch (err) {
    throw new ChertoError(
      "bad_config",
      "[cherto] initialConfig must be a config snapshot with an experiments list",
      { cause: err },
    );
  }
}

function timeoutOf(method: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ChertoError(
      "bad_config",
      `[cherto] ${method} timeoutMs must be a number of milliseconds, got ${String(value)}`,
    );
  }
  return value;
}

function positiveDurationOf(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ChertoError(
      "bad_config",
      `[cherto] ${name} must be a positive, finite number of milliseconds, got ${String(value)}`,
    );
  }
  return value;
}

function loggerOf(value: unknown): ChertoLogger {
  return loggerFrom(value, (message) => {
    throw new ChertoError("bad_config", `[cherto] ${message}`);
  });
}

function pollIntervalOf(pollIntervalMs: number | undefined, logger: ChertoLogger): number {
  if (pollIntervalMs === undefined) return DEFAULT_POLL_INTERVAL_MS;
  if (typeof pollIntervalMs !== "number" || !Number.isFinite(pollIntervalMs)) {
    throw new ChertoError(
      "bad_config",
      `[cherto] pollIntervalMs must be a finite number of milliseconds, got ${String(pollIntervalMs)}`,
    );
  }
  if (pollIntervalMs < MIN_POLL_INTERVAL_MS) {
    logger.warn(
      `[cherto] pollIntervalMs ${pollIntervalMs} ms is below the ${MIN_POLL_INTERVAL_MS} ms minimum; using ${MIN_POLL_INTERVAL_MS} ms`,
    );
    return MIN_POLL_INTERVAL_MS;
  }
  return pollIntervalMs;
}

const EVENT_BUFFER_MINIMUMS = {
  flushIntervalMs: 0,
  maxBatchSize: 1,
  maxQueueSize: 1,
  maxFlushAttempts: 1,
  flushRetryBaseDelayMs: 0,
} as const;

function eventBufferOptions(opts: unknown): Partial<EventBufferOptions> {
  const checked: Partial<EventBufferOptions> = {};
  if (opts === undefined) return checked;
  if (!isRecord(opts)) {
    throw new ChertoError("bad_config", "[cherto] eventBuffer must be an object");
  }
  for (const [name, min] of Object.entries(EVENT_BUFFER_MINIMUMS)) {
    const value = opts[name];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
      throw new ChertoError(
        "bad_config",
        `[cherto] eventBuffer.${name} must be a number of at least ${min}`,
      );
    }
    checked[name as keyof typeof EVENT_BUFFER_MINIMUMS] = value;
  }
  return checked;
}
