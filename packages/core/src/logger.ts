/**
 * Where the SDK logs. `console` satisfies it; for pino, pass
 * `{ warn: (msg, meta) => log.warn(meta, msg), error: (msg, meta) => log.error(meta, msg) }`.
 * `meta` never holds attribute values. A throw or rejection from the logger is swallowed.
 */
export interface ChertoLogger {
  /** Configuration problems and degraded evaluation, logged once per cause. */
  warn(message: string, meta?: Record<string, unknown>): void;
  /** Failed requests, undelivered enrollment events, throwing callbacks and internal errors. */
  error(message: string, meta?: Record<string, unknown>): void;
}

/** A warning sink. `meta` holds keys and type names only, never attribute values. */
export type WarnFn = (meta: Record<string, unknown>, message: string) => void;

export const noopWarn: WarnFn = () => {};

export const consoleLogger: ChertoLogger = {
  warn: (message, meta) =>
    meta === undefined ? console.warn(message) : console.warn(message, meta),
  error: (message, meta) =>
    meta === undefined ? console.error(message) : console.error(message, meta),
};

/**
 * Route a rejection of `result`, when it is a promise, to `onRejected`. A callback typed
 * `=> void` may still be async, and an unhandled rejection ends a Node process by default.
 */
export function catchRejection(result: unknown, onRejected: (err: unknown) => void): void {
  const then = (result as { then?: unknown } | null | undefined)?.then;
  if (typeof then === "function") {
    (result as PromiseLike<unknown>).then(undefined, onRejected);
  }
}

/** Call a caller's callback, routing a throw or a returned rejection to `onFailure`. */
export function callGuarded(call: () => unknown, onFailure: (err: unknown) => void): void {
  try {
    catchRejection(call(), onFailure);
  } catch (err) {
    onFailure(err);
  }
}

/** Wraps a caller's logger so a throw or rejection from it can't escape into a read path. */
export function guardLogger(logger: ChertoLogger): ChertoLogger {
  const log = (level: keyof ChertoLogger, message: string, meta?: Record<string, unknown>) => {
    callGuarded(
      () => (meta === undefined ? logger[level](message) : logger[level](message, meta)),
      () => {},
    );
  };
  return {
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
  };
}

/**
 * Validate a caller's `logger` option: `undefined` gives `console`, a valid logger comes back
 * guarded, and anything else gives `console` with the problem passed to `onInvalid`.
 */
export function loggerFrom(value: unknown, onInvalid: (message: string) => void): ChertoLogger {
  if (value === undefined) return consoleLogger;
  if (typeof value === "function") {
    onInvalid(
      "logger takes an object with warn and error methods, for the SDK's own logs. To " +
        'receive enrollment events, pass enrollmentTracking: { mode: "custom", logger }.',
    );
    return consoleLogger;
  }
  const candidate = value as Partial<ChertoLogger> | null;
  if (typeof candidate?.warn !== "function" || typeof candidate.error !== "function") {
    onInvalid("logger must have warn and error methods");
    return consoleLogger;
  }
  return guardLogger(candidate as ChertoLogger);
}

const DEFAULT_WARN_CAPACITY = 1_000;

/**
 * A warn sink that logs each (experiment or holdout key, message) pair once. It remembers up
 * to `capacity` pairs, forgetting the oldest tenth when full.
 */
export function createWarnOnce(
  logger: ChertoLogger = consoleLogger,
  capacity: number = DEFAULT_WARN_CAPACITY,
): WarnFn {
  const seen = new Set<string>();
  return (meta, message) => {
    const subject = meta.experimentKey ?? meta.holdoutKey ?? "";
    const id = `${String(subject)}\u0000${message}`;
    if (seen.has(id)) return;
    if (seen.size >= capacity) {
      let excess = Math.max(1, Math.floor(capacity / 10));
      for (const oldest of seen) {
        if (excess-- <= 0) break;
        seen.delete(oldest);
      }
    }
    seen.add(id);
    logger.warn(`[cherto] ${message}`, meta);
  };
}
