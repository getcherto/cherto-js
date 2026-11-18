import {
  ChertoError,
  asTransportError,
  backoffMs,
  httpError,
  isChertoError,
  isDateTime,
  timerMs,
  untilDeadline,
  type ChertoEnrollmentEvent,
  type ChertoErrorCode,
  type ChertoLogger,
  type EnrollmentTransport,
} from "@cherto/core";
import type { SafeStorage } from "./storage.js";

const WHAT = "enrollment event delivery";
/** The most events `POST /v1/events` accepts in one request. */
export const MAX_EVENTS_PER_REQUEST = 5_000;
/** Under the API's 1 MiB body limit. */
const MAX_BODY_BYTES = 1_000_000;
/** Under the 64 KiB browsers allow a beacon or a keepalive request. */
const MAX_KEEPALIVE_BYTES = 60_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_PERSISTED_EVENTS = 100;
const PERSISTED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// The API rejects a whole batch over one malformed eventId, so a restored event must match.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EVENT_BUFFER_DEFAULTS = {
  flushIntervalMs: 5_000,
  maxBatchSize: 20,
  maxQueueSize: 500,
  maxFlushAttempts: 3,
  flushRetryBaseDelayMs: 1_000,
} as const;

export type EventBufferTuning = { -readonly [K in keyof typeof EVENT_BUFFER_DEFAULTS]: number };

export interface EventBufferOptions extends EventBufferTuning {
  clientKey: string;
  /** No trailing slash. */
  apiUrl: string;
  sdkIdentity: string;
  fetch: typeof fetch;
  storage: SafeStorage | null;
  logger: ChertoLogger;
  /** Called with the error when a batch is dropped, or saved for a later page load. */
  onError(err: ChertoError): void;
  /** Called when `droppedCount` grows without a call to `onError`. */
  onDropped?(): void;
}

interface Backoff {
  batch: ChertoEnrollmentEvent[];
  /** Ends the wait; `true` when the page is going away and took the batch. */
  release(handedOff: boolean): void;
}

/**
 * Batched delivery of enrollment events to `POST /v1/events`. A failed batch is retried with
 * backoff, then saved to storage for a later page load; a rejected one is dropped. When the
 * page is hidden or unloaded, queued events go out by `sendBeacon`, and what can't is saved.
 * Retries resend the same `eventId`s so the server counts each event once.
 */
export class EventBuffer implements EnrollmentTransport {
  private readonly url: string;
  private readonly opts: EventBufferOptions;
  private queue: ChertoEnrollmentEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;
  private backoff: Backoff | null = null;
  private inFlight: { batch: ChertoEnrollmentEvent[]; keepalive: boolean } | null = null;
  private stopped = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private droppedSinceReport = 0;
  private readonly detach: Array<() => void> = [];
  private started = false;

  /** Events given up on since construction: dropped, rejected or undeliverable. */
  droppedCount = 0;

  constructor(opts: EventBufferOptions) {
    this.opts = { ...opts, maxBatchSize: Math.min(opts.maxBatchSize, MAX_EVENTS_PER_REQUEST) };
    this.url = `${opts.apiUrl}/v1/events`;
  }

  /**
   * Take over what earlier pages saved and listen for page exit. Not done on construction, so a
   * buffer that is never used, such as one built in a render React discards, changes nothing.
   */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.restorePersisted();
    this.listen();
  }

  send(event: ChertoEnrollmentEvent): Promise<void> {
    this.start();
    this.add(event);
    return Promise.resolve();
  }

  /** Send what is queued and wait, retries included, until it is delivered or given up on. */
  flush(timeoutMs = Infinity): Promise<void> {
    this.start();
    return untilDeadline(this.drainAll(), timeoutMs);
  }

  /**
   * Stop accepting events and send what is queued, without waiting out a retry. What isn't sent
   * by `timeoutMs` is saved for a later page load, or dropped without storage. A page exit
   * meanwhile beacons the rest.
   */
  close(timeoutMs = Infinity): Promise<void> {
    if (this.closing === null) {
      this.closed = true;
      this.clearTimer();
      this.backoff?.release(false);
      this.closing = this.drainAll().finally(() => {
        for (const detach of this.detach.splice(0)) detach();
      });
    }
    return untilDeadline(this.closing, timeoutMs).then(() =>
      this.saveOrDrop(this.queue.splice(0), "timeout", "before close() timed out"),
    );
  }

  private async drainAll(): Promise<void> {
    for (let pass = 0; pass < 3 && (this.sending !== null || this.queue.length > 0); pass++) {
      this.clearTimer();
      await (this.sending ?? this.drain());
    }
  }

  private add(event: ChertoEnrollmentEvent): void {
    if (this.closed) return;
    if (this.stopped || !isSendable(event)) {
      this.countDropped(1);
      return;
    }
    this.queue.push(event);
    if (this.queue.length > this.opts.maxQueueSize) {
      this.queue.shift();
      this.droppedSinceReport++;
      this.countDropped(1);
    }
    if (this.queue.length >= this.opts.maxBatchSize) {
      if (this.sending === null) {
        this.clearTimer();
        void this.drain();
      }
    } else {
      this.ensureTimer();
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.sending !== null || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, timerMs(this.opts.flushIntervalMs));
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
      this.reportOverflow();
      if (this.closed || this.queue.length === 0) return;
      if (this.queue.length >= this.opts.maxBatchSize) void this.drain();
      else this.ensureTimer();
    });
    return this.sending;
  }

  // Only what is queued now, so steady traffic can't turn into back-to-back requests.
  private async sendQueued(): Promise<void> {
    let remaining = this.queue.length;
    while (remaining > 0 && this.queue.length > 0 && !this.stopped) {
      const batch = this.queue.splice(0, this.batchLength(remaining));
      remaining -= batch.length;
      await this.sendWithRetry(batch);
    }
  }

  private batchLength(remaining: number): number {
    const max = Math.min(remaining, this.opts.maxBatchSize, this.queue.length);
    let bytes = byteLength(JSON.stringify({ events: [] })) + eventBytes(this.queue[0]);
    let count = 1;
    while (count < max) {
      bytes += eventBytes(this.queue[count]) + 1;
      if (bytes > MAX_BODY_BYTES) break;
      count++;
    }
    return count;
  }

  private async sendWithRetry(batch: ChertoEnrollmentEvent[]): Promise<void> {
    const body = JSON.stringify({ events: batch });
    const keepalive = byteLength(body) <= MAX_KEEPALIVE_BYTES;
    for (let attempt = 1; ; attempt++) {
      let error: ChertoError;
      const inFlight = { batch, keepalive };
      this.inFlight = inFlight;
      try {
        await this.post(body, keepalive);
        return;
      } catch (err) {
        error = isChertoError(err) ? err : asTransportError(err, WHAT);
      } finally {
        if (this.inFlight === inFlight) this.inFlight = null;
      }
      if (!error.retryable) {
        this.drop(batch, error);
        if (error.status === 401 || error.status === 403) this.stop();
        return;
      }
      if (attempt >= this.opts.maxFlushAttempts || this.closed) {
        this.saveForLater(batch, error);
        return;
      }
      const delay = Math.min(
        Math.max(backoffMs(this.opts.flushRetryBaseDelayMs, attempt), error.retryAfterMs ?? 0),
        MAX_RETRY_DELAY_MS,
      );
      if (await this.waitToRetry(batch, delay)) return;
    }
  }

  private async post(body: string, keepalive: boolean): Promise<void> {
    let res: Response;
    try {
      res = await this.opts.fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.clientKey}`,
          "x-cherto-sdk": this.opts.sdkIdentity,
        },
        body,
        // Lets a send started as the page unloads finish.
        keepalive,
      });
    } catch (err) {
      throw asTransportError(err, WHAT);
    }
    if (res.ok) return;
    const text = await res.text().catch(() => "");
    throw httpError(
      { status: res.status, retryAfter: res.headers.get("retry-after"), body: text },
      WHAT,
    );
  }

  /** Wait `ms` before a retry. Resolves `true` when the page exit took the batch instead. */
  private waitToRetry(batch: ChertoEnrollmentEvent[], ms: number): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.backoff = null;
        resolve(false);
      }, timerMs(ms));
      this.backoff = {
        batch,
        release: (handedOff) => {
          clearTimeout(timer);
          this.backoff = null;
          resolve(handedOff);
        },
      };
    });
  }

  private drop(batch: ChertoEnrollmentEvent[], error: ChertoError): void {
    this.droppedCount += batch.length;
    this.opts.logger.error(`[cherto] dropped ${batch.length} enrollment event(s)`, { err: error });
    this.opts.onError(error);
  }

  /** The key or origin was refused: nothing more can be delivered from this page. */
  private stop(): void {
    this.stopped = true;
    this.countDropped(this.queue.length);
    this.queue = [];
    this.clearTimer();
  }

  private countDropped(count: number): void {
    if (count <= 0) return;
    this.droppedCount += count;
    this.opts.onDropped?.();
  }

  private saveForLater(batch: ChertoEnrollmentEvent[], error: ChertoError): void {
    if (!this.persist(batch)) {
      this.drop(batch, error);
      return;
    }
    this.opts.onError(
      new ChertoError(
        error.code,
        `[cherto] couldn't deliver ${batch.length} enrollment event(s); saved them to send on a later page load`,
        {
          cause: error,
          ...(error.status !== undefined ? { status: error.status } : {}),
          ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        },
      ),
    );
  }

  /** Save `unsent` for a later page load, or drop and report it when there is no storage. */
  private saveOrDrop(unsent: ChertoEnrollmentEvent[], code: ChertoErrorCode, when: string): void {
    if (unsent.length === 0 || this.persist(unsent)) return;
    this.drop(
      unsent,
      new ChertoError(
        code,
        `[cherto] couldn't send ${unsent.length} enrollment event(s) ${when}, ` +
          "and there is no storage to save them in",
      ),
    );
  }

  private reportOverflow(): void {
    if (this.droppedSinceReport === 0) return;
    this.opts.logger.error(
      `[cherto] enrollment queue full: dropped the oldest ${this.droppedSinceReport} event(s)`,
    );
    this.droppedSinceReport = 0;
  }

  private listen(): void {
    const win = typeof window === "undefined" ? undefined : window;
    const doc = typeof document === "undefined" ? undefined : document;
    if (typeof win?.addEventListener === "function") {
      const onPageHide = () => this.onPageExit();
      win.addEventListener("pagehide", onPageHide);
      this.detach.push(() => win.removeEventListener("pagehide", onPageHide));
    }
    if (doc !== undefined && typeof doc.addEventListener === "function") {
      const onVisibility = () => {
        if (doc.visibilityState === "hidden") this.onPageExit();
        else if (doc.visibilityState === "visible") this.restorePersisted();
      };
      doc.addEventListener("visibilitychange", onVisibility);
      this.detach.push(() => doc.removeEventListener("visibilitychange", onVisibility));
    }
  }

  // The page may not run again: beacon what is queued or waiting to retry, and save what
  // can't go. A request the browser cancels on unload is saved too; the API deduplicates by
  // eventId if it did arrive.
  private onPageExit(): void {
    if (this.stopped) return;
    this.clearTimer();
    const events: ChertoEnrollmentEvent[] = [];
    if (this.backoff !== null) {
      events.push(...this.backoff.batch);
      this.backoff.release(true);
    }
    events.push(...this.queue.splice(0));
    this.saveOrDrop(this.beacon(events), "network", "as the page was hidden");
    if (this.inFlight !== null && !this.inFlight.keepalive) {
      this.persist(this.inFlight.batch, true);
    }
  }

  /** Send `events` by beacon in chunks the browser accepts. Returns what wasn't sent. */
  private beacon(events: ChertoEnrollmentEvent[]): ChertoEnrollmentEvent[] {
    const nav = typeof navigator === "undefined" ? undefined : navigator;
    if (typeof nav?.sendBeacon !== "function" || typeof Blob !== "function") return events;
    // A beacon can't set headers, so the key and identity ride in the body.
    const prefix = `${JSON.stringify({
      clientKey: this.opts.clientKey,
      sdkIdentity: this.opts.sdkIdentity,
    }).slice(0, -1)},"events":[`;
    const suffix = "]}";
    const jsons = events.map((event) => JSON.stringify(event));
    let start = 0;
    while (start < events.length) {
      let end = start;
      let bytes = byteLength(prefix) + suffix.length;
      while (end < events.length && end - start < this.opts.maxBatchSize) {
        const added = byteLength(jsons[end]) + (end > start ? 1 : 0);
        if (bytes + added > MAX_KEEPALIVE_BYTES) break;
        bytes += added;
        end++;
      }
      if (end === start) return events.slice(start);
      const body = `${prefix}${jsons.slice(start, end).join(",")}${suffix}`;
      if (!sendBeacon(nav, this.url, body)) return events.slice(start);
      start = end;
    }
    return [];
  }

  private get storageKey(): string {
    return `cherto:events:pending:${this.opts.clientKey}`;
  }

  private readPersisted(): ChertoEnrollmentEvent[] {
    const storage = this.opts.storage;
    if (storage === null) return [];
    const raw = storage.getItem(this.storageKey);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const oldest = Date.now() - PERSISTED_TTL_MS;
      return parsed
        .filter(
          (event: unknown): event is ChertoEnrollmentEvent =>
            isSendable(event) && UUID.test(event.eventId) && Date.parse(event.occurredAt) >= oldest,
        )
        .map(({ eventId, experimentKey, variantKey, unitId, startedAt, occurredAt }) => ({
          eventId,
          experimentKey,
          variantKey,
          unitId,
          startedAt,
          occurredAt,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Save `events` for a later page load, newest kept when over the cap. `false` when there is
   * nowhere to save them. `mayBeDelivered` is for events still in flight: those that don't fit
   * aren't counted as dropped.
   */
  private persist(events: ChertoEnrollmentEvent[], mayBeDelivered = false): boolean {
    const storage = this.opts.storage;
    if (events.length === 0) return true;
    if (storage === null) return false;
    const byId = new Map<string, ChertoEnrollmentEvent>();
    for (const event of [...this.readPersisted(), ...events]) byId.set(event.eventId, event);
    const combined = [...byId.values()];
    const kept = combined.slice(-MAX_PERSISTED_EVENTS);
    if (!storage.setItem(this.storageKey, JSON.stringify(kept))) return false;
    if (!mayBeDelivered) this.countDropped(combined.length - kept.length);
    return true;
  }

  /** Queue what an earlier page saved, ahead of new events. */
  private restorePersisted(): void {
    if (this.opts.storage === null || this.closed || this.stopped) return;
    if (this.opts.storage.getItem(this.storageKey) === null) return;
    const events = this.readPersisted();
    this.opts.storage.removeItem(this.storageKey);
    if (events.length === 0) return;
    this.queue.unshift(...events);
    this.ensureTimer();
  }
}

function sendBeacon(nav: Navigator, url: string, body: string): boolean {
  try {
    // text/plain needs no CORS preflight, which a beacon can't make.
    return nav.sendBeacon(url, new Blob([body], { type: "text/plain" }));
  } catch {
    return false;
  }
}

function isSendable(event: unknown): event is ChertoEnrollmentEvent {
  if (typeof event !== "object" || event === null) return false;
  const e = event as Partial<Record<keyof ChertoEnrollmentEvent, unknown>>;
  return (
    [e.eventId, e.experimentKey, e.variantKey, e.unitId].every(
      (field) => typeof field === "string" && field !== "",
    ) &&
    isDateTime(e.startedAt) &&
    isDateTime(e.occurredAt)
  );
}

function eventBytes(event: ChertoEnrollmentEvent): number {
  return byteLength(JSON.stringify(event));
}

let encoder: TextEncoder | undefined;

function byteLength(text: string): number {
  if (typeof TextEncoder !== "function") return text.length * 3;
  encoder ??= new TextEncoder();
  return encoder.encode(text).length;
}
