import type { Config } from "./types.js";
import { parseConfig } from "./config.js";
import { buildSdkIdentity } from "./sdk-identity.js";
import {
  ChertoError,
  asHttpError,
  backoffMs,
  consoleLogger,
  createWarnOnce,
  isRetryable,
  retryAfterOf,
  timerMs,
  type WarnFn,
} from "@cherto/core";
import { FETCH_TIMEOUT_MS, timedFetch } from "./timing.js";

export const DEFAULT_API_URL = "https://api.getcherto.com";
const INIT_RETRY_BASE_DELAY_MS = 500;
const MAX_INIT_RETRY_DELAY_MS = 5_000;
const MAX_POLL_BACKOFF_MS = 5 * 60_000;
const RECOVERY_BASE_DELAY_MS = 1_000;
const POLL_JITTER = 0.1;

/**
 * Polls `GET /v1/config` with `If-None-Match`, each poll jittered ±10% and scheduled once the
 * previous one settles. A failure keeps the current config and backs off, never sooner than
 * `Retry-After`. The ETag is opaque: never parse or synthesize one.
 */
export class ConfigPoller {
  private readonly serverKey: string;
  private readonly baseUrl: string;
  private readonly warn: WarnFn;
  private readonly onPollError: (err: unknown) => void;

  /** The config being served: the latest fetched, a seeded snapshot, or null. */
  config: Config | null = null;
  /** When a fetch last succeeded (a 304 included), in epoch milliseconds. */
  lastSuccessfulFetchAt: number | null = null;

  private etag: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private intervalMs = 0;
  private running = false;
  private failures = 0;

  /** `apiUrl` must have no trailing slash. `onPollError` reports background poll failures. */
  constructor(
    serverKey: string,
    apiUrl: string = DEFAULT_API_URL,
    warn?: WarnFn,
    onPollError?: (err: unknown) => void,
  ) {
    this.serverKey = serverKey;
    this.baseUrl = apiUrl;
    this.warn = warn ?? createWarnOnce();
    this.onPollError =
      onPollError ??
      ((err) => consoleLogger.error("[cherto] config poll failed (will retry)", { err }));
  }

  /**
   * Fetch the config: `true` when it changed, `false` on a 304. Throws on a transport or HTTP
   * error, or an unusable body, keeping the current config.
   */
  async fetch(timeoutMs: number = FETCH_TIMEOUT_MS): Promise<boolean> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.serverKey}`,
      "x-cherto-sdk": buildSdkIdentity(),
    };
    if (this.etag !== null) {
      headers["if-none-match"] = this.etag;
    }

    const res = await timedFetch(
      `${this.baseUrl}/v1/config`,
      { method: "GET", headers },
      "config fetch",
      timeoutMs,
    );

    if (res.status === 304) {
      this.lastSuccessfulFetchAt = Date.now();
      return false;
    }

    if (!res.ok) {
      throw await asHttpError(res, "config fetch");
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      // No `status`: the response itself succeeded.
      throw new ChertoError("bad_response", "[cherto] config fetch returned unparseable JSON", {
        cause: err,
      });
    }
    this.config = parseConfig(body, this.warn);
    // Only after parsing succeeds, or a rejected body's ETag would pin the stale config.
    this.etag = res.headers.get("etag") || null;
    this.lastSuccessfulFetchAt = Date.now();
    return true;
  }

  /** Fetch, retrying retryable failures until one succeeds or `budgetMs` would run out. */
  async fetchWithRetry(budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.fetch(deadline - Date.now());
        return;
      } catch (err) {
        if (!isRetryable(err)) throw err;
        const delay = Math.max(
          backoffMs(INIT_RETRY_BASE_DELAY_MS, attempt, MAX_INIT_RETRY_DELAY_MS),
          retryAfterOf(err),
        );
        if (Date.now() + delay >= deadline) throw err;
        // Ref'd, unlike the poll timer: nothing else keeps the process alive during init().
        await new Promise((resolve) => setTimeout(resolve, timerMs(delay)));
      }
    }
  }

  /** Start background polling on an unref'd timer, the first poll after `firstDelayMs`. */
  start(intervalMs: number, firstDelayMs: number = jitter(intervalMs)): void {
    if (this.running) return;
    this.running = true;
    this.intervalMs = intervalMs;
    this.schedule(firstDelayMs);
  }

  /** Start background polling as if a poll had just failed with `err`. */
  startAfterFailure(intervalMs: number, err: unknown): void {
    if (this.running) return;
    this.running = true;
    this.intervalMs = intervalMs;
    this.retryAfter(err);
  }

  /** Stop background polling. A poll already in flight is not rescheduled. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, timerMs(delayMs));
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    try {
      await this.fetch();
      this.failures = 0;
      this.schedule(jitter(this.intervalMs));
    } catch (err) {
      this.onPollError(err);
      this.retryAfter(err);
    }
  }

  private retryAfter(err: unknown): void {
    this.failures++;
    const backoff =
      this.lastSuccessfulFetchAt === null
        ? Math.min(RECOVERY_BASE_DELAY_MS * 2 ** (this.failures - 1), this.intervalMs)
        : Math.min(
            this.intervalMs * 2 ** this.failures,
            Math.max(this.intervalMs, MAX_POLL_BACKOFF_MS),
          );
    this.schedule(Math.max(jitter(backoff), retryAfterOf(err)));
  }
}

function jitter(ms: number): number {
  return ms * (1 - POLL_JITTER + Math.random() * 2 * POLL_JITTER);
}
