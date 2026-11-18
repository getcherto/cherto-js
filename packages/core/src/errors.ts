/**
 * Why a {@link ChertoError} was raised. New codes may be added in minor versions, so branch
 * on {@link ChertoError.retryable} and give a `switch` over `code` a default case.
 */
export type ChertoErrorCode =
  /** The connection failed: DNS, a refused connection or TLS. Transient. */
  | "network"
  /** The request ran out of time, or the server answered 408. Transient. */
  | "timeout"
  /** 401, or another 403: the key is missing, malformed, unknown or revoked. Permanent. */
  | "unauthorized"
  /** 429: the request budget is exhausted. Retry after {@link ChertoError.retryAfterMs}. */
  | "rate_limited"
  /** 400 or another 4xx not listed here: the request itself was rejected. Permanent. */
  | "bad_request"
  /** A 5xx, a 425, or a 2xx with an unusable body. Transient. */
  | "bad_response"
  /** The SDK was given invalid options. Permanent: fix the call site. */
  | "bad_config"
  /**
   * 403 from the browser SDK: the page's origin isn't one the client key allows. Add it under
   * Settings → SDK & keys. Permanent.
   */
  | "origin_not_allowed"
  /**
   * A `"custom"` enrollment logger threw or rejected, with what it threw as `cause`. The SDK
   * doesn't call it again for that event.
   */
  | "callback_failed";

// Global, so every copy of either SDK recognises the others' errors.
const BRAND = Symbol.for("cherto.ChertoError");

const RETRYABLE_CODES: ReadonlySet<ChertoErrorCode> = new Set<ChertoErrorCode>([
  "network",
  "timeout",
  "rate_limited",
  "bad_response",
]);

/** Every error the SDK throws, rejects with or reports to `onError`. */
export class ChertoError extends Error {
  /** Matches a `ChertoError` from any copy of the SDK; see {@link isChertoError}. */
  static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== ChertoError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return isChertoError(value);
  }

  /** Why it failed. */
  readonly code: ChertoErrorCode;
  /** Present when the failure came back with an HTTP status. */
  readonly status?: number;
  /** The wait the server asked for, in milliseconds, from a `Retry-After` header. */
  readonly retryAfterMs?: number;

  /** Whether the same request can succeed later. Prefer this to listing codes. */
  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  constructor(
    code: ChertoErrorCode,
    message: string,
    options?: { cause?: unknown; status?: number; retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = "ChertoError";
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    // Some supported browsers ignore the constructor's cause option.
    if (options?.cause !== undefined && !("cause" in this)) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        writable: true,
        configurable: true,
      });
    }
    Object.defineProperty(this, BRAND, { value: true });
  }
}

/**
 * Whether `value` is a `ChertoError`, including one from another copy of the SDK (its ESM or
 * CommonJS build, or another version). Equivalent to `value instanceof ChertoError`.
 */
export function isChertoError(value: unknown): value is ChertoError {
  return (
    typeof value === "object" && value !== null && (value as { [BRAND]?: unknown })[BRAND] === true
  );
}

export function isRetryable(err: unknown): err is ChertoError {
  return isChertoError(err) && err.retryable;
}

export function retryAfterOf(err: unknown): number {
  return isChertoError(err) ? (err.retryAfterMs ?? 0) : 0;
}

/** Map an HTTP status, and the API's error code when it sent one, to a code. */
export function codeForStatus(status: number, apiError?: string): ChertoErrorCode {
  if (status === 403 && apiError === "ORIGIN_NOT_ALLOWED") return "origin_not_allowed";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status === 425) return "bad_response";
  if (status >= 400 && status < 500) return "bad_request";
  return "bad_response";
}

/**
 * Parse `Retry-After` (delta-seconds or an HTTP-date) into milliseconds. A past date gives `0`;
 * a negative or unparseable value gives `null`.
 */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : null;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** A non-OK response, already read. */
export interface HttpFailure {
  status: number;
  retryAfter: string | null;
  body: string;
}

/**
 * The `ChertoError` for a non-OK response. An API error body (`{ error, message }`) supplies
 * the message; any other body is quoted, cut to 200 characters.
 */
export function httpError(failure: HttpFailure, what: string): ChertoError {
  const { status, body } = failure;
  let apiError: string | undefined;
  let detail = body.slice(0, 200);
  let origin: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const { error, message, details } = parsed as {
        error?: unknown;
        message?: unknown;
        details?: { origin?: unknown } | null;
      };
      if (typeof error === "string") apiError = error;
      if (typeof message === "string" && message !== "") detail = message.slice(0, 200);
      if (typeof details?.origin === "string" && details.origin !== "") {
        origin = details.origin.slice(0, 200);
      }
    }
  } catch {
    // Not JSON: quote it as is.
  }
  const code = codeForStatus(status, apiError);
  const retryAfterMs = parseRetryAfter(failure.retryAfter);
  return new ChertoError(
    code,
    code === "origin_not_allowed" && origin !== undefined
      ? `[cherto] origin ${origin} isn't allowed for this client key; add it under ` +
          "Settings → SDK & keys → Allowed origins"
      : `[cherto] ${what} failed: HTTP ${status}${detail === "" ? "" : `: ${detail}`}`,
    { status, ...(retryAfterMs !== null ? { retryAfterMs } : {}) },
  );
}

/** The `ChertoError` for a non-OK response, reading its body. */
export async function asHttpError(res: Response, what: string): Promise<ChertoError> {
  const body = await res.text().catch(() => "");
  return httpError({ status: res.status, retryAfter: res.headers.get("retry-after"), body }, what);
}

/** Wrap a `fetch` rejection: an abort is a `timeout`, anything else `network`, kept as `cause`. */
export function asTransportError(err: unknown, what: string): ChertoError {
  if (isChertoError(err)) return err;
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ChertoError("timeout", `[cherto] ${what} timed out`, { cause: err });
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new ChertoError("network", `[cherto] ${what} failed: ${detail}`, { cause: err });
}
