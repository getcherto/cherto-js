import {
  asHttpError,
  backoffMs,
  consoleLogger,
  isDateTime,
  isRetryable,
  retryAfterOf,
  timerMs,
  untilDeadline,
  type ChertoEnrollmentEvent,
  type EnrollmentTransport,
} from "@cherto/core";
import { buildSdkIdentity } from "./sdk-identity.js";
import type { ChertoLogger } from "./types.js";
import { timedFetch } from "./timing.js";

/** The most events `POST /v1/events` accepts in one request. */
const MAX_EVENTS_PER_REQUEST = 5_000;
/** Kept under the API's 1 MiB request body limit. */
const MAX_BODY_BYTES = 1_000_000;
const BODY_OVERHEAD_BYTES = '{"events":[]}'.length;

const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_FLUSH_ATTEMPTS = 3;
const DEFAULT_FLUSH_RETRY_BASE_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_DEDUPE_CAPACITY = 10_000;
const DEFAULT_DEDUPE_TTL_MS = 5 * 60_000;

export interface EventBufferOptions {
  serverKey: string;
  /** No trailing slash. */
  baseUrl: string;
  flushIntervalMs?: number;
  /** Clamped to {@link MAX_EVENTS_PER_REQUEST}. */
  maxBatchSize?: number;
  maxQueueSize?: number;
  /** Total attempts per batch: the first send plus retries. */
  maxFlushAttempts?: number;
  flushRetryBaseDelayMs?: number;
  dedupeCapacity?: number;
  dedupeTtlMs?: number;
  /** Where delivery failures and dropped events are reported. */
  logger?: ChertoLogger;
  /** Called with the error that made a batch be given up on. */
  onError?: (err: unknown) => void;
}

interface QueuedEvent {
  json: string;
  bytes: number;
  dedupeKey: string | undefined;
}

/** Shared by events that record the same unit in the same variant of the same run. */
export function enrollmentDedupeKey(parts: {
  experimentKey: string;
  variantKey: string;
  unitTypeKey: string;
  unitId: string;
  startedAt: string | undefined;
}): string {
  return JSON.stringify([
    parts.experimentKey,
    parts.variantKey,
    parts.unitTypeKey,
    parts.unitId,
    parts.startedAt ?? null,
  ]);
}

/**
 * Batched, deduplicated delivery of a client's enrollment events to `POST /v1/events`.
 * Retries resend the same `eventId`s so the server counts each event once. An event the API
 * would reject is skipped, since it would fail its whole batch.
 */
export class EventBuffer implements EnrollmentTransport {
  private readonly url: string;
  private readonly serverKey: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly maxFlushAttempts: number;
  private readonly flushRetryBaseDelayMs: number;
  private readonly dedupeCapacity: number;
  private readonly dedupeTtlMs: number;
  private readonly logger: ChertoLogger;
  private readonly onError: ((err: unknown) => void) | undefined;

  private queue: QueuedEvent[] = [];
  private readonly seen = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeRetry: (() => void) | null = null;
  private awaitingFlush = 0;
  private closed = false;
  private closing: Promise<void> | null = null;
  private droppedSinceReport = 0;
  private reportedInvalid = false;

  /** Events given up on since construction: dropped, undelivered or unsendable. */
  droppedCount = 0;

  constructor(opts: EventBufferOptions) {
    this.url = `${opts.baseUrl}/v1/events`;
    this.serverKey = opts.serverKey;
    this.flushIntervalMs = timerMs(opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.maxBatchSize = Math.min(
      opts.maxBatchSize ?? MAX_EVENTS_PER_REQUEST,
      MAX_EVENTS_PER_REQUEST,
    );
    this.maxQueueSize = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.maxFlushAttempts = opts.maxFlushAttempts ?? DEFAULT_MAX_FLUSH_ATTEMPTS;
    this.flushRetryBaseDelayMs = opts.flushRetryBaseDelayMs ?? DEFAULT_FLUSH_RETRY_BASE_DELAY_MS;
    this.dedupeCapacity = opts.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY;
    this.dedupeTtlMs = opts.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.logger = opts.logger ?? consoleLogger;
    this.onError = opts.onError;
  }

  send(event: ChertoEnrollmentEvent, dedupeKey?: string): Promise<void> {
    this.add(event, dedupeKey);
    return Promise.resolve();
  }

  /**
   * Send every event queued before the call and wait, retries included, until each is delivered
   * or dropped, or until `timeoutMs` has passed, leaving the rest to the background. Events added
   * while it waits may be left to the background too. A retry keeps the process alive only while
   * a flush awaits it.
   */
  async flush(timeoutMs = Infinity): Promise<void> {
    this.awaitingFlush++;
    this.retryTimer?.ref?.();
    try {
      await untilDeadline(this.drainAll(), timeoutMs);
    } finally {
      if (--this.awaitingFlush === 0) this.retryTimer?.unref?.();
    }
  }

  /** Stop accepting events and send what is queued without further retries. Idempotent. */
  close(): Promise<void> {
    if (this.closing === null) {
      this.closed = true;
      this.clearTimer();
      this.wakeRetry?.();
      this.closing = this.flush();
    }
    return this.closing;
  }

  // The batch in flight, then what queued behind it, then what arrived meanwhile.
  private async drainAll(): Promise<void> {
    for (let pass = 0; pass < 3 && (this.sending !== null || this.queue.length > 0); pass++) {
      this.clearTimer();
      await (this.sending ?? this.drain());
    }
  }

  private add(event: ChertoEnrollmentEvent, dedupeKey: string | undefined): void {
    if (this.closed) return;
    if (!isSendable(event)) {
      this.droppedCount++;
      if (!this.reportedInvalid) {
        this.reportedInvalid = true;
        this.logger.error(
          "[cherto] skipped an enrollment event with a missing or malformed field",
          { experimentKey: event.experimentKey },
        );
      }
      return;
    }
    if (dedupeKey !== undefined && !this.remember(dedupeKey)) return;

    const json = JSON.stringify(event);
    this.queue.push({ json, bytes: Buffer.byteLength(json), dedupeKey });
    if (this.queue.length > this.maxQueueSize) {
      const oldest = this.queue.shift()!;
      this.forget(oldest);
      this.droppedCount++;
      this.droppedSinceReport++;
    }

    if (this.queue.length >= this.maxBatchSize) {
      if (this.sending === null) {
        this.clearTimer();
        void this.drain();
      }
    } else {
      this.ensureTimer();
    }
  }

  /** Records `key` and reports whether it was new within the dedupe window. */
  private remember(key: string): boolean {
    const now = Date.now();
    const expiresAt = this.seen.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.seen.delete(key);
    this.seen.set(key, now + this.dedupeTtlMs);
    if (this.seen.size > this.dedupeCapacity) this.evict(now);
    return true;
  }

  // A tenth at a time, plus anything expired: evicting one key per insert from the front of a
  // Map re-scans its deleted slots each time.
  private evict(now: number): void {
    let excess = this.seen.size - (this.dedupeCapacity - Math.floor(this.dedupeCapacity / 10));
    for (const [key, expiresAt] of this.seen) {
      if (excess <= 0 && expiresAt > now) break;
      this.seen.delete(key);
      excess--;
    }
  }

  /** Lets a later read re-record an enrollment whose event was dropped. */
  private forget(item: QueuedEvent): void {
    if (item.dedupeKey !== undefined) this.seen.delete(item.dedupeKey);
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.sending !== null || this.closed) return;
    // Left ref'd so a queued event keeps the process alive until it is sent.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.flushIntervalMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private drain(): Promise<void> {
    this.sending ??= this.sendQueued().finally(() => {
      this.sending = null;
      this.reportDropped();
      if (this.closed || this.queue.length === 0) return;
      if (this.queue.length >= this.maxBatchSize) void this.drain();
      else this.ensureTimer();
    });
    return this.sending;
  }

  // Only what is queued now, so steady traffic can't turn into back-to-back requests.
  private async sendQueued(): Promise<void> {
    let remaining = this.queue.length;
    while (remaining > 0 && this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchLength(remaining));
      remaining -= batch.length;
      await this.sendWithRetry(batch);
    }
  }

  /** How many queued events fit in one request, by count and body size. */
  private batchLength(remaining: number): number {
    const max = Math.min(remaining, this.maxBatchSize, this.queue.length);
    let bytes = BODY_OVERHEAD_BYTES + this.queue[0].bytes;
    let count = 1;
    while (count < max) {
      bytes += this.queue[count].bytes + 1;
      if (bytes > MAX_BODY_BYTES) break;
      count++;
    }
    return count;
  }

  private async sendWithRetry(batch: QueuedEvent[]): Promise<void> {
    const body = `{"events":[${batch.map((item) => item.json).join(",")}]}`;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.post(body);
        return;
      } catch (err) {
        const retryable = isRetryable(err);
        if (!retryable || attempt >= this.maxFlushAttempts || this.closed) {
          batch.forEach((item) => this.forget(item));
          this.droppedCount += batch.length;
          const reason = retryable ? `after ${attempt} attempts` : "(not retryable)";
          this.logger.error(`[cherto] dropped ${batch.length} enrollment event(s) ${reason}`, {
            err,
          });
          this.onError?.(err);
          return;
        }
        await this.sleep(this.retryDelay(attempt, err));
      }
    }
  }

  private async post(body: string): Promise<void> {
    const what = "enrollment event delivery";
    const res = await timedFetch(
      this.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.serverKey}`,
          "x-cherto-sdk": buildSdkIdentity(),
        },
        body,
      },
      what,
    );
    if (!res.ok) throw await asHttpError(res, what);
  }

  private retryDelay(attempt: number, err: unknown): number {
    const backoff = backoffMs(this.flushRetryBaseDelayMs, attempt);
    return Math.min(Math.max(backoff, retryAfterOf(err)), MAX_RETRY_DELAY_MS);
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (this.awaitingFlush === 0) timer.unref?.();
      this.retryTimer = timer;
      this.wakeRetry = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      this.retryTimer = null;
      this.wakeRetry = null;
    });
  }

  private reportDropped(): void {
    if (this.droppedSinceReport === 0) return;
    this.logger.error(
      `[cherto] enrollment queue full: dropped the oldest ${this.droppedSinceReport} event(s)`,
    );
    this.droppedSinceReport = 0;
  }
}

function isSendable(event: ChertoEnrollmentEvent): boolean {
  return (
    [event.eventId, event.experimentKey, event.variantKey, event.unitId].every(
      (field) => typeof field === "string" && field !== "",
    ) &&
    isDateTime(event.startedAt) &&
    isDateTime(event.occurredAt)
  );
}
