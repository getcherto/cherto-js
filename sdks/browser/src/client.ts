import {
  ChertoError,
  EnrollmentTracker,
  attributesDigest,
  backoffMs,
  callGuarded,
  copyJson,
  createWarnOnce,
  digest,
  enrollmentLoggerError,
  generateUuid,
  hasOwn,
  ifTypeMatches,
  isRecord,
  loggerFrom,
  normalizeContext,
  paramOf,
  parseBootstrap,
  retryAfterOf,
  setOwn,
  untilDeadline,
  type BootstrapV1,
  type ChertoAssignment,
  type ChertoAssignmentDetail,
  type ChertoContextInput,
  type ChertoEnrollmentEvent,
  type ChertoEnrollmentTrackingConfig,
  type ChertoLogger,
  type ChertoReadOptions,
  type NormalizedContext,
  type UnitMap,
  type WarnFn,
} from "@cherto/core";
import {
  fingerprint,
  parseAssignments,
  setFromBootstrap,
  setFromWire,
  type AssignmentEntry,
  type AssignmentSet,
  type WireAssignments,
  type WireHoldout,
} from "./assignments.js";
import {
  EVENT_BUFFER_DEFAULTS,
  EventBuffer,
  MAX_EVENTS_PER_REQUEST,
  type EventBufferTuning,
} from "./event-buffer.js";
import { contextIdentity, sameAttributes, sameUnit, unitsWithin } from "./identity.js";
import { loadAssignments, type LoadOutcome } from "./load.js";
import { buildSdkIdentity } from "./sdk-identity.js";
import { resolveStorage, type SafeStorage } from "./storage.js";
import type { ChertoClientOptions, ChertoClientStatus, ChertoInitResult } from "./types.js";

const DEFAULT_API_URL = "https://api.getcherto.com";
const DEFAULT_INIT_TIMEOUT_MS = 3_000;
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const LATE_RESPONSE_GRACE_MS = 10_000;
// Generous, so a client clock some minutes fast doesn't trip it.
const STALE_BOOTSTRAP_MINUTES = 15;
const RECOVERY_BASE_DELAY_MS = 1_000;
const CACHE_KEY_PREFIX = "cherto:assignments:";
const MAX_CACHE_ENTRIES = 5;

type Source = ChertoInitResult["source"];

interface BoundContext {
  input: NormalizedContext;
  identity: string;
  /** The digest the cache stores this context under. */
  key: string;
}

interface Load {
  generation: number;
  promise: Promise<ChertoInitResult>;
}

interface Intent {
  experiment?: { variant: string; startedAt: string; unitId: string };
  holdouts: Array<{ key: string; variant: string; startedAt: string; unitId: string }>;
}

interface CacheEntry {
  k: string;
  t: number;
  experiments: unknown;
  holdouts?: unknown;
}

/**
 * The Cherto browser SDK client. Loads the current context's assignments from Cherto, serves
 * them synchronously, and records enrollment when a variant is read. Never throws: failures
 * are logged, passed to `onError`, and leave callers' defaults or the last assignments served.
 */
export class ChertoClient {
  private readonly logger: ChertoLogger;
  private readonly warn: WarnFn;
  private readonly onErrorCallback: ((err: ChertoError) => void) | undefined;
  private readonly clientKey: string;
  private readonly apiUrl: string;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly offline: boolean;
  private readonly inertError: ChertoError | null;
  private readonly initTimeoutMs: number;
  private readonly refreshIntervalMs: number;
  private readonly storage: SafeStorage | null;
  private readonly buffer: EventBuffer | undefined;
  private readonly tracker: EnrollmentTracker;
  private readonly headers: Record<string, string>;
  private readonly abort: AbortController | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly detach: Array<() => void> = [];
  // The newest request each cache entry was written from, so a late older one can't win.
  private readonly cacheWrites = new Map<string, number>();

  private context: BoundContext | null = null;
  private generation = 0;
  private set: AssignmentSet | null = null;
  private source: Source = "none";
  // Whether `set` is current: loaded, bootstrapped, or saved within refreshIntervalMs. Reads of
  // an unconfirmed set are served but enrolled only once a load confirms the same assignment.
  private confirmed = false;
  // When the served assignments were evaluated, for freshness.
  private loadedAt: number | null = null;
  // The attributes the bootstrap was evaluated for, which identify() checks a context against.
  private bootstrapDigest: string | null = null;
  private started = false;
  private readonly enrolled = new Set<string>();
  private readonly enrolledHoldouts = new Set<string>();
  private deferred = new Map<string, Intent>();
  private load: Load | null = null;
  private revalidation: ReturnType<typeof setTimeout> | null = null;
  private lastLoad: { generation: number; result: ChertoInitResult } | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  // A Retry-After holds back every request, whatever its context.
  private rateLimit: { until: number; error: ChertoError } | null = null;
  private requestSeq = 0;
  private appliedSeq = 0;
  private lastError: ChertoError | null = null;
  private lastErrorAt: number | null = null;
  private errorsReported = 0;
  private lastSuccessfulFetchAt: number | null = null;
  private closing: Promise<void> | null = null;
  private warnedClosed = false;
  private reportedNoContext = false;
  // What reads and getStatus() returned when subscribers were last notified.
  private notified = "";

  constructor(options: ChertoClientOptions) {
    const opts: Partial<ChertoClientOptions> = isRecord(options) ? options : {};
    const problems: string[] = [];
    const invalid = (message: string) => problems.push(message);
    if (!isRecord(options)) invalid("ChertoClient takes an options object");

    this.logger = loggerFrom(opts.logger, invalid);
    this.warn = createWarnOnce(this.logger);
    if (opts.onError !== undefined && typeof opts.onError !== "function") {
      invalid("onError must be a function");
    }
    this.onErrorCallback = typeof opts.onError === "function" ? opts.onError : undefined;

    const keyProblem = clientKeyProblem(opts.clientKey);
    const apiUrl = apiUrlOf(opts.apiUrl);
    const inertProblem = keyProblem ?? (typeof apiUrl === "string" ? null : apiUrl.problem);
    this.inertError =
      inertProblem === null ? null : new ChertoError("bad_config", `[cherto] ${inertProblem}`);
    this.clientKey = keyProblem === null ? (opts.clientKey as string) : "";
    this.apiUrl = typeof apiUrl === "string" ? apiUrl : DEFAULT_API_URL;

    if (opts.offline !== undefined && typeof opts.offline !== "boolean") {
      invalid("offline must be a boolean");
    }
    if (opts.fetch !== undefined && typeof opts.fetch !== "function") {
      invalid("fetch must be a function");
    }
    const userFetch = typeof opts.fetch === "function" ? opts.fetch : undefined;
    const globalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch : undefined;
    const fetchImpl = userFetch ?? globalFetch;
    // Called as a plain function: a browser's fetch throws when called as another object's method.
    this.fetchFn =
      fetchImpl === undefined
        ? undefined
        : (input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, init);
    const serverSide = browserScope() === undefined && userFetch === undefined;
    if (!serverSide && opts.offline !== true && fetchImpl === undefined) {
      invalid("fetch is unavailable here: pass the fetch option");
    }
    this.offline =
      opts.offline === true || this.inertError !== null || serverSide || fetchImpl === undefined;

    this.initTimeoutMs = durationOf(
      "initTimeoutMs",
      opts.initTimeoutMs,
      DEFAULT_INIT_TIMEOUT_MS,
      invalid,
    );
    this.refreshIntervalMs = durationOf(
      "refreshIntervalMs",
      opts.refreshIntervalMs,
      DEFAULT_REFRESH_INTERVAL_MS,
      invalid,
    );
    this.storage = this.offline ? null : resolveStorage(opts.storage, invalid);

    const sdkIdentity = buildSdkIdentity(sdkWrapperOf(opts.sdkWrapper));
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.clientKey}`,
      "X-Cherto-SDK": sdkIdentity,
    };
    this.abort = typeof AbortController === "function" ? new AbortController() : undefined;

    const tracking = trackingOf(opts.enrollmentTracking, invalid);
    const tuning = eventBufferTuning(opts.eventBuffer, invalid);
    this.buffer =
      tracking.mode === "cherto" && !this.offline && this.fetchFn !== undefined
        ? new EventBuffer({
            clientKey: this.clientKey,
            apiUrl: this.apiUrl,
            sdkIdentity,
            fetch: this.fetchFn,
            storage: this.storage,
            logger: this.logger,
            onError: (err) => this.report(err, null),
            onDropped: () => this.notifyIfChanged(),
            ...tuning,
          })
        : undefined;
    this.tracker = new EnrollmentTracker({
      ...(tracking.mode === "cherto" && this.buffer === undefined ? { mode: "none" } : tracking),
      ...(this.buffer ? { transport: this.buffer } : {}),
      onError: (err, event) =>
        this.report(enrollmentLoggerError(err), "[cherto] enrollment logger failed", {
          experimentKey: event.experimentKey,
        }),
    });

    let bootstrap: BootstrapV1 | null = null;
    if (opts.bootstrap !== undefined && opts.bootstrap !== null) {
      const parsed = parseBootstrap(opts.bootstrap);
      if (parsed.ok) bootstrap = parsed.value;
      else invalid(`bootstrap ignored: ${parsed.reason}`);
    }
    const context =
      opts.context === undefined || opts.context === null
        ? null
        : this.bind(normalizeContext(opts.context, this.warn));
    this.context = context;
    if (bootstrap !== null) {
      const ageMinutes = Math.floor((Date.now() - Date.parse(bootstrap.generatedAt)) / 60_000);
      // Without a context nothing checks it again, so one cached for another visitor enrolls them.
      if (context === null && ageMinutes >= STALE_BOOTSTRAP_MINUTES) {
        this.warn(
          { ageMinutes },
          "bootstrap is old: render a page that carries one per request, never from a shared cache",
        );
      }
      if (context === null || unitsWithin(bootstrap.units, context.input.units)) {
        this.seedBootstrap(
          bootstrap,
          context === null ||
            attributesDigest(context.input.attributes) === bootstrap.attributesDigest,
        );
      } else {
        invalid(unitMismatch(bootstrap.units, context.input.units));
      }
    }
    if (this.set === null && context !== null) {
      if (hasUnits(context)) this.seedFromCache(context);
      else this.serveNothing(context);
    }

    for (const problem of problems) {
      this.report(new ChertoError("bad_config", `[cherto] ${problem}`), null);
    }
    if (this.inertError !== null) this.report(this.inertError, null);
    this.notified = this.snapshot();
  }

  /**
   * Load assignments for the current context. Concurrent calls share one load. Resolves at
   * once, without a request, while the assignments served are confirmed and younger than
   * `refreshIntervalMs`; offline; with only a `bootstrap`; or for a context with no units.
   * Without a context or a bootstrap, resolves `ok: false` with a `bad_config` error. Never
   * rejects.
   */
  initialize(): Promise<ChertoInitResult> {
    try {
      this.start();
      if (this.inertError !== null) return this.resolved(false, this.inertError);
      if (this.closing !== null) return this.resolved(this.confirmed);
      if (this.offline) return this.resolved(true);
      const context = this.context;
      if (context === null) {
        if (this.source === "bootstrap") return this.resolved(true);
        const err = new ChertoError(
          "bad_config",
          "[cherto] there is no context to load: pass context to the constructor or call identify()",
        );
        if (!this.reportedNoContext) {
          this.reportedNoContext = true;
          this.report(err, null);
        }
        return this.resolved(false, err);
      }
      if (!hasUnits(context)) return this.resolved(true);
      if (this.load !== null) return this.load.promise;
      if (this.confirmed && this.isFresh()) return this.resolved(true);
      return this.startLoad();
    } catch (err) {
      return this.resolved(false, asError(err));
    }
  }

  /**
   * Switch to another context, such as a user who just signed in. Reads switch at once, to
   * what this browser saved for the new context if anything; otherwise experiments on a unit
   * whose id is unchanged keep their assignments, enrolled only once the new context's load
   * confirms them, and the rest serve callers' defaults. A bootstrap stays served while the new
   * context has every unit it was generated for, with the same id. Resolves when the new
   * context's assignments load, or with `ok: false` if another `identify()` replaces the
   * context first. An identical context changes nothing. Never rejects.
   */
  identify(context: ChertoContextInput): Promise<ChertoInitResult> {
    try {
      this.start();
      const next = this.bind(normalizeContext(context, this.warn));
      if (this.context !== null && next.identity === this.context.identity) {
        return this.initialize();
      }
      const current = this.context;
      const previous = this.set;
      const previousSource = this.source;
      const keepBootstrap =
        previous !== null &&
        previousSource === "bootstrap" &&
        this.confirmed &&
        this.closing === null &&
        unitsWithin(previous.units, next.input.units);
      this.generation++;
      this.load = null;
      this.lastLoad = null;
      this.failures = 0;
      this.nextAttemptAt = 0;
      this.lastSuccessfulFetchAt = null;
      this.deferred.clear();
      this.context = next;
      if (keepBootstrap) {
        const sameAttrs =
          current === null
            ? attributesDigest(next.input.attributes) === this.bootstrapDigest
            : sameAttributes(current.input, next.input);
        if (!sameAttrs) this.confirmed = false;
      } else {
        this.switchTo(next, previous, previousSource);
      }
      const result = this.loadAfterSwitch(next, keepBootstrap);
      this.notifyIfChanged();
      return result;
    } catch (err) {
      return this.resolved(false, asError(err));
    }
  }

  /**
   * Load the current context's assignments now, however fresh they are. Joins a load already
   * in progress. Never rejects.
   */
  refresh(): Promise<ChertoInitResult> {
    try {
      this.start();
      if (this.inertError !== null) return this.resolved(false, this.inertError);
      const context = this.context;
      if (this.offline || this.closing !== null || context === null || !hasUnits(context)) {
        return this.initialize();
      }
      return this.load?.promise ?? this.startLoad();
    } catch (err) {
      return this.resolved(false, asError(err));
    }
  }

  /**
   * Call `listener` whenever a read or `getStatus()` would return something different: when
   * assignments load or a load confirms them, when `identify()` switches context, when a load
   * fails, and when enrollment events are dropped. Returns a function that unsubscribes. A
   * listener that throws or rejects is logged.
   */
  subscribe(listener: () => void): () => void {
    if (typeof listener !== "function") return () => {};
    const entry = () => listener();
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /**
   * Read the variant key for `key`, enrolling by default. Returns `defaultValue` when `key`
   * isn't assigned, as before assignments load.
   */
  getVariant(key: string, defaultValue: string, opts?: ChertoReadOptions): string {
    try {
      this.revalidate();
      const entry = this.entryOf(key);
      this.maybeEnroll(key, opts);
      return entry?.variant ?? defaultValue;
    } catch (err) {
      this.logger.error("[cherto] getVariant failed, serving the default", { err });
      return defaultValue;
    }
  }

  /**
   * Read a variant's custom value, enrolling by default. Returns `defaultValue` when there is
   * none, or when a string, number or boolean default doesn't match the value's type. An
   * object value isn't checked against `T`. Each call returns a new copy.
   */
  getVariantValue<T = Record<string, unknown>>(
    key: string,
    defaultValue: T,
    opts?: ChertoReadOptions,
  ): T {
    try {
      this.revalidate();
      const entry = this.entryOf(key);
      this.maybeEnroll(key, opts);
      if (entry?.customValue === undefined) return defaultValue;
      return ifTypeMatches(
        key,
        "the variant's value",
        copyJson(entry.customValue),
        defaultValue,
        this.warn,
      );
    } catch (err) {
      this.logger.error("[cherto] getVariantValue failed, serving the default", { err });
      return defaultValue;
    }
  }

  /**
   * Read one param of a variant's custom value, enrolling by default. Returns `defaultValue`
   * when it is absent, or when a string, number or boolean default doesn't match its type. An
   * object param isn't checked against `T`.
   */
  getVariantParam<T = unknown>(
    key: string,
    paramKey: string,
    defaultValue: T,
    opts?: ChertoReadOptions,
  ): T {
    try {
      this.revalidate();
      const entry = this.entryOf(key);
      this.maybeEnroll(key, opts);
      const value = paramOf(entry?.customValue, paramKey);
      if (value === undefined) return defaultValue;
      return ifTypeMatches(key, `param "${paramKey}"`, copyJson(value), defaultValue, this.warn);
    } catch (err) {
      this.logger.error("[cherto] getVariantParam failed, serving the default", { err });
      return defaultValue;
    }
  }

  /** Read the assignment for `key` without enrolling, or `null` when there is none. */
  getAssignment(key: string): ChertoAssignment | null {
    try {
      this.revalidate();
      const entry = this.entryOf(key);
      return entry ? assignmentOf(entry) : null;
    } catch {
      return null;
    }
  }

  /** Read every assignment without enrolling. */
  getAllAssignments(): Record<string, ChertoAssignment> {
    const result: Record<string, ChertoAssignment> = {};
    try {
      this.revalidate();
      for (const [key, entry] of this.set?.experiments ?? []) {
        setOwn(result, key, assignmentOf(entry));
      }
    } catch {
      // Return what was collected.
    }
    return result;
  }

  /**
   * Read the assignment for `key` with the reason for it, without enrolling. `"not_ready"`
   * while nothing current is loaded for the context, `"not_assigned"` when the current
   * assignments don't include `key`.
   */
  getAssignmentDetail(key: string): ChertoAssignmentDetail {
    try {
      this.revalidate();
      const entry = this.entryOf(key);
      if (entry) return { assignment: assignmentOf(entry), reason: entry.reason };
      return {
        assignment: null,
        reason: this.set !== null && this.confirmed ? "not_assigned" : "not_ready",
      };
    } catch {
      return { assignment: null, reason: "error", errorCode: "evaluation_failed" };
    }
  }

  /**
   * The enrollment events a tracked read of `key` would record, for callers who record enrollment
   * themselves: the experiment's, unless it is never enrolled (as for an override), and one
   * per holdout covering it. Empty while the assignments served await a load to confirm them.
   * Records nothing and remembers nothing, so it returns the events again on every call:
   * deduplicate holdout events by holdout key.
   */
  getEnrollmentPayloads(key: string): ChertoEnrollmentEvent[] {
    const events: ChertoEnrollmentEvent[] = [];
    try {
      const set = this.set;
      if (set === null || !this.confirmed) return events;
      const entry = this.entryOf(key);
      const unitId = entry && unitIdOf(set, entry.unitTypeKey);
      if (entry?.trackEnrollment && unitId !== undefined) {
        events.push(eventFor(key, entry.variant, unitId, entry.startedAt));
      }
      for (const holdout of set.holdouts) {
        if (!holdout.experimentKeys.includes(key)) continue;
        const holdoutUnitId = unitIdOf(set, holdout.unitTypeKey);
        if (holdoutUnitId !== undefined) {
          events.push(eventFor(holdout.key, holdout.variant, holdoutUnitId, holdout.startedAt));
        }
      }
    } catch (err) {
      this.logger.error("[cherto] getEnrollmentPayloads failed", { err });
    }
    return events;
  }

  /**
   * Enroll the unit in `key`, and in any holdout the read exposes it to, as a read without
   * `{ track: false }` does. Resolves once the events are handed off; call `flush()` to await
   * delivery. Never rejects.
   */
  trackEnrollment(key: string): Promise<void> {
    try {
      this.start();
      if (this.closedForEnrollment()) return Promise.resolve();
      const set = this.set;
      if (set === null) return Promise.resolve();
      if (!this.confirmed) {
        this.defer(key, set);
        return Promise.resolve();
      }
      const pending = this.enrollHoldouts(key, set);
      const entry = set.experiments.get(key);
      if (entry) pending.push(this.enroll(key, entry, set));
      return Promise.all(pending).then(() => {});
    } catch (err) {
      this.logger.error("[cherto] trackEnrollment failed", { err });
      return Promise.resolve();
    }
  }

  /** A snapshot of the client's health. */
  getStatus(): ChertoClientStatus {
    return {
      ready: this.set !== null,
      source: this.source,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt === null ? null : new Date(this.lastErrorAt),
      lastSuccessfulFetchAt:
        this.lastSuccessfulFetchAt === null ? null : new Date(this.lastSuccessfulFetchAt),
      droppedEvents: this.buffer?.droppedCount ?? 0,
    };
  }

  /**
   * Send every enrollment recorded so far and wait until each is delivered or given up on.
   * Enrollment also goes out on its own, and when the page is hidden. Never rejects.
   *
   * @param opts - `timeoutMs`: the longest to wait, in milliseconds. No limit by default.
   */
  async flush(opts?: { timeoutMs?: number | undefined }): Promise<void> {
    try {
      const deadline = Date.now() + timeoutOf(opts?.timeoutMs, Infinity);
      await untilDeadline(this.tracker.flush(), deadline - Date.now());
      await this.buffer?.flush(deadline - Date.now());
    } catch (err) {
      this.logger.error("[cherto] flush failed", { err });
    }
  }

  /**
   * Stop loading assignments and deliver queued enrollment, without waiting out retries. Reads
   * keep serving the last assignments, recording no enrollment, until `identify()` switches
   * context; reads then serve callers' defaults. Later calls return the first call's promise.
   * Never rejects.
   *
   * @param opts - `timeoutMs`: the longest to wait, in milliseconds. 10 seconds by default.
   * Enrollment not sent by then is saved for a later page load, or dropped without storage.
   */
  close(opts?: { timeoutMs?: number | undefined }): Promise<void> {
    if (this.closing !== null) return this.closing;
    const timeoutMs = timeoutOf(opts?.timeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    this.closing = (async () => {
      for (const detach of this.detach.splice(0)) detach();
      if (this.revalidation !== null) clearTimeout(this.revalidation);
      this.revalidation = null;
      this.abort?.abort();
      this.load = null;
      this.deferred.clear();
      await untilDeadline(this.tracker.flush(), timeoutMs);
      await this.buffer?.close(deadline - Date.now());
    })().catch((err: unknown) => {
      this.logger.error("[cherto] close failed", { err });
    });
    return this.closing;
  }

  private bind(input: NormalizedContext): BoundContext {
    const identity = contextIdentity(input);
    return { input, identity, key: digest(identity) };
  }

  private resolved(ok: boolean, error?: ChertoError): Promise<ChertoInitResult> {
    return Promise.resolve({ ok, source: this.source, ...(error ? { error } : {}) });
  }

  private isFresh(): boolean {
    return (
      this.set !== null &&
      this.loadedAt !== null &&
      Date.now() - this.loadedAt < this.refreshIntervalMs
    );
  }

  private entryOf(key: string): AssignmentEntry | undefined {
    return typeof key === "string" ? this.set?.experiments.get(key) : undefined;
  }

  private seedBootstrap(bootstrap: BootstrapV1, confirmed: boolean): void {
    const set = setFromBootstrap(bootstrap);
    this.bootstrapDigest = bootstrap.attributesDigest;
    const generatedAt = Math.min(Date.parse(bootstrap.generatedAt), Date.now());
    this.applySet(set, "bootstrap", generatedAt, confirmed);
    for (const key of bootstrap.enrolled ?? []) {
      const entry = set.experiments.get(key);
      const unitId = entry && unitIdOf(set, entry.unitTypeKey);
      if (entry && unitId !== undefined) {
        this.enrolled.add(dedupeKey(key, entry.variant, entry.startedAt, unitId));
      }
    }
    for (const key of bootstrap.enrolledHoldouts ?? []) {
      const holdout = set.holdouts.find((h) => h.key === key);
      const unitId = holdout && unitIdOf(set, holdout.unitTypeKey);
      if (holdout && unitId !== undefined) {
        this.enrolledHoldouts.add(dedupeKey(key, holdout.variant, holdout.startedAt, unitId));
      }
    }
  }

  private seedFromCache(context: BoundContext): void {
    const cached = this.readCache(context.key);
    if (cached === null) return;
    const fresh = Date.now() - cached.savedAt < this.refreshIntervalMs;
    this.applySet(setFromWire(cached.wire, context.input.units), "cache", cached.savedAt, fresh);
  }

  private serveNothing(context: BoundContext): void {
    this.warn(
      {},
      "context has no units, so no assignments are loaded; pass at least one, such as a device id",
    );
    this.set = { experiments: new Map(), holdouts: [], units: context.input.units };
    this.source = "none";
    this.confirmed = true;
    this.loadedAt = Date.now();
  }

  // What identify() serves until the new context loads: saved assignments for it, or those of
  // the previous context's experiments whose unit kept its id, pending confirmation.
  private switchTo(next: BoundContext, previous: AssignmentSet | null, previousSource: Source) {
    this.set = null;
    this.source = "none";
    this.confirmed = false;
    this.loadedAt = null;
    if (this.closing !== null) return;
    if (!hasUnits(next)) {
      this.serveNothing(next);
      return;
    }
    this.seedFromCache(next);
    if (this.set !== null || previous === null || this.offline) return;
    const units = next.input.units;
    const experiments = new Map<string, AssignmentEntry>();
    for (const [key, entry] of previous.experiments) {
      if (sameUnit(previous.units, units, entry.unitTypeKey)) experiments.set(key, entry);
    }
    const holdouts = previous.holdouts.filter((h) =>
      sameUnit(previous.units, units, h.unitTypeKey),
    );
    if (experiments.size === 0 && holdouts.length === 0) return;
    this.set = { experiments, holdouts, units };
    this.source = previousSource;
  }

  private loadAfterSwitch(next: BoundContext, keepBootstrap: boolean): Promise<ChertoInitResult> {
    if (this.inertError !== null) return this.resolved(false, this.inertError);
    if (this.closing !== null) return this.resolved(false);
    if (this.offline || !hasUnits(next)) return this.resolved(true);
    // A bootstrap still answers for a context that adds no units to it.
    const answered = !keepBootstrap || unitsWithin(next.input.units, this.set!.units);
    if (answered && this.confirmed && this.isFresh()) return this.resolved(true);
    return this.startLoad();
  }

  private applySet(set: AssignmentSet, source: Source, loadedAt: number, confirmed: boolean) {
    this.set = set;
    this.source = source;
    this.loadedAt = loadedAt;
    this.confirmed = confirmed;
  }

  private startLoad(): Promise<ChertoInitResult> {
    const generation = this.generation;
    const context = this.context!;
    if (this.rateLimit !== null && Date.now() < this.rateLimit.until) {
      const result: ChertoInitResult = {
        ok: false,
        source: this.source,
        error: this.rateLimit.error,
      };
      this.lastLoad = { generation, result };
      this.nextAttemptAt = Math.max(this.nextAttemptAt, this.rateLimit.until);
      return Promise.resolve(result);
    }
    const seq = ++this.requestSeq;
    const { units, attributes } = context.input;
    const body = JSON.stringify({
      context: {
        units,
        ...(attributes !== undefined && Object.keys(attributes).length > 0 ? { attributes } : {}),
      },
    });
    const promise = loadAssignments({
      fetch: this.fetchFn!,
      url: `${this.apiUrl}/v1/initialize`,
      headers: this.headers,
      body,
      budgetMs: this.initTimeoutMs,
      graceMs: LATE_RESPONSE_GRACE_MS,
      warn: this.warn,
      signal: this.abort?.signal,
      onLate: (wire) => this.receive(generation, seq, context, wire),
    })
      .then((outcome) => this.settle(generation, seq, context, outcome))
      .catch((err: unknown) => {
        this.logger.error("[cherto] loading assignments failed unexpectedly", { err });
        return { ok: false, source: this.source, error: asError(err) };
      });
    const load: Load = { generation, promise };
    this.load = load;
    void promise.then(() => {
      if (this.load === load) this.load = null;
    });
    return promise;
  }

  private settle(
    generation: number,
    seq: number,
    context: BoundContext,
    outcome: LoadOutcome,
  ): ChertoInitResult {
    if (outcome.ok) this.receive(generation, seq, context, outcome.wire);
    if (generation !== this.generation || this.closing !== null) {
      return { ok: false, source: this.source, ...(outcome.ok ? {} : { error: outcome.error }) };
    }
    let result: ChertoInitResult;
    if (outcome.ok) {
      result = { ok: true, source: this.source };
    } else {
      const { error } = outcome;
      this.failures++;
      const backoff = backoffMs(
        RECOVERY_BASE_DELAY_MS,
        this.failures,
        Math.max(this.refreshIntervalMs, RECOVERY_BASE_DELAY_MS),
      );
      const retryAfter = retryAfterOf(error);
      if (retryAfter > 0) this.rateLimit = { until: Date.now() + retryAfter, error };
      this.nextAttemptAt = Date.now() + Math.max(backoff, retryAfter);
      this.report(error, "[cherto] couldn't load assignments");
      result = { ok: false, source: this.source, error };
    }
    this.lastLoad = { generation, result };
    return result;
  }

  // Cached under its own context; served only if still the newest for the current one.
  private receive(generation: number, seq: number, context: BoundContext, wire: WireAssignments) {
    if (this.closing !== null) return;
    const now = Date.now();
    if (seq > (this.cacheWrites.get(context.key) ?? 0)) {
      this.cacheWrites.set(context.key, seq);
      this.writeCache(context.key, wire, now);
    }
    if (generation !== this.generation || seq <= this.appliedSeq) return;
    this.appliedSeq = seq;
    this.lastSuccessfulFetchAt = now;
    this.failures = 0;
    this.nextAttemptAt = 0;
    const set = setFromWire(wire, context.input.units);
    this.applySet(set, "network", now, true);
    this.enrollDeferred(set);
    if (this.lastLoad?.generation === generation && !this.lastLoad.result.ok) {
      this.lastLoad = { generation, result: { ok: true, source: "network" } };
    }
    this.notifyIfChanged();
  }

  // Deferred, so a read (as inside a render) never starts a request itself.
  private revalidate(): void {
    if (this.revalidation !== null || !this.needsLoad()) return;
    this.revalidation = setTimeout(() => {
      this.revalidation = null;
      if (this.needsLoad()) void this.startLoad();
    }, 0);
  }

  private needsLoad(): boolean {
    if (this.offline || this.closing !== null || this.load !== null) return false;
    const context = this.context;
    if (context === null || !hasUnits(context) || Date.now() < this.nextAttemptAt) return false;
    const last = this.lastLoad?.generation === this.generation ? this.lastLoad.result : null;
    if (last?.error?.retryable === false) return false;
    if (this.set !== null) return !(this.confirmed && this.isFresh());
    return last !== null && !last.ok;
  }

  /**
   * Listen for the browser coming back online and start the event buffer. Not done on
   * construction, so a client that is never used, such as one built in a render React
   * discards, adds no listeners and touches no saved events.
   */
  private start(): void {
    if (this.started) return;
    this.started = true;
    this.listenForOnline();
    this.buffer?.start();
  }

  private listenForOnline(): void {
    const scope = browserScope();
    if (this.offline || typeof scope?.addEventListener !== "function") return;
    const onOnline = () => {
      const last = this.lastLoad;
      if (this.load !== null || this.closing !== null || this.context === null) return;
      if (last === null || last.generation !== this.generation || last.result.ok) return;
      if (last.result.error?.retryable === false) return;
      void this.startLoad();
    };
    scope.addEventListener("online", onOnline);
    this.detach.push(() => scope.removeEventListener("online", onOnline));
  }

  private snapshot(): string {
    return JSON.stringify([
      fingerprint(this.set),
      this.confirmed,
      this.source,
      this.errorsReported,
      this.lastSuccessfulFetchAt,
      this.buffer?.droppedCount ?? 0,
    ]);
  }

  private notifyIfChanged(): void {
    const snapshot = this.snapshot();
    if (snapshot === this.notified) return;
    this.notified = snapshot;
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      callGuarded(listener, (err) => this.logger.error("[cherto] a subscriber threw", { err }));
    }
  }

  private report(err: ChertoError, message: string | null, meta?: Record<string, unknown>) {
    this.lastError = err;
    this.lastErrorAt = Date.now();
    this.errorsReported++;
    this.logger.error(message ?? err.message, { ...meta, err });
    const onError = this.onErrorCallback;
    if (onError !== undefined) {
      callGuarded(
        () => onError(err),
        (thrown) => this.logger.error("[cherto] onError threw", { err: thrown }),
      );
    }
    this.notifyIfChanged();
  }

  private closedForEnrollment(): boolean {
    if (this.closing === null) return false;
    if (!this.warnedClosed) {
      this.warnedClosed = true;
      this.logger.warn("[cherto] the client is closed, so enrollment is no longer recorded");
    }
    return true;
  }

  private maybeEnroll(key: string, opts: ChertoReadOptions | undefined): void {
    if (opts?.track === false || this.closedForEnrollment()) return;
    const set = this.set;
    if (set === null) return;
    if (!this.confirmed) {
      this.defer(key, set);
      return;
    }
    // Exposure to a holdout counts even when the experiment itself isn't assigned.
    void this.enrollHoldouts(key, set);
    const entry = set.experiments.get(key);
    if (entry) void this.enroll(key, entry, set);
  }

  // Remember what a read of unconfirmed assignments would enroll, for enrollDeferred().
  private defer(key: string, set: AssignmentSet): void {
    const entry = set.experiments.get(key);
    const unitId = entry && unitIdOf(set, entry.unitTypeKey);
    const intent: Intent = { holdouts: [] };
    if (entry?.trackEnrollment && unitId !== undefined) {
      intent.experiment = { variant: entry.variant, startedAt: entry.startedAt, unitId };
    }
    for (const holdout of set.holdouts) {
      const holdoutUnitId = unitIdOf(set, holdout.unitTypeKey);
      if (holdout.experimentKeys.includes(key) && holdoutUnitId !== undefined) {
        intent.holdouts.push({
          key: holdout.key,
          variant: holdout.variant,
          startedAt: holdout.startedAt,
          unitId: holdoutUnitId,
        });
      }
    }
    if (intent.experiment !== undefined || intent.holdouts.length > 0) {
      this.deferred.set(key, intent);
    }
  }

  // Enroll what reads of unconfirmed assignments deferred, where the confirmed set agrees on
  // the variant, run and unit. A read of an assignment that changed enrolls when read again.
  private enrollDeferred(set: AssignmentSet): void {
    const intents = [...this.deferred];
    this.deferred.clear();
    for (const [key, intent] of intents) {
      const entry = set.experiments.get(key);
      const wanted = intent.experiment;
      if (
        entry !== undefined &&
        wanted !== undefined &&
        entry.variant === wanted.variant &&
        entry.startedAt === wanted.startedAt &&
        unitIdOf(set, entry.unitTypeKey) === wanted.unitId
      ) {
        void this.enroll(key, entry, set);
      }
      for (const arm of intent.holdouts) {
        const holdout = set.holdouts.find((h) => h.key === arm.key);
        if (
          holdout !== undefined &&
          holdout.variant === arm.variant &&
          holdout.startedAt === arm.startedAt &&
          holdout.experimentKeys.includes(key) &&
          unitIdOf(set, holdout.unitTypeKey) === arm.unitId
        ) {
          void this.enrollHoldout(holdout, arm.unitId);
        }
      }
    }
  }

  private enrollHoldouts(key: string, set: AssignmentSet): Array<Promise<void>> {
    const pending: Array<Promise<void>> = [];
    for (const holdout of set.holdouts) {
      if (!holdout.experimentKeys.includes(key)) continue;
      const unitId = unitIdOf(set, holdout.unitTypeKey);
      if (unitId !== undefined) pending.push(this.enrollHoldout(holdout, unitId));
    }
    return pending;
  }

  private enrollHoldout(holdout: WireHoldout, unitId: string): Promise<void> {
    const dedupe = dedupeKey(holdout.key, holdout.variant, holdout.startedAt, unitId);
    if (this.enrolledHoldouts.has(dedupe)) return Promise.resolve();
    this.enrolledHoldouts.add(dedupe);
    return this.tracker.track(eventFor(holdout.key, holdout.variant, unitId, holdout.startedAt));
  }

  private enroll(key: string, entry: AssignmentEntry, set: AssignmentSet): Promise<void> {
    if (!entry.trackEnrollment) return Promise.resolve();
    const unitId = unitIdOf(set, entry.unitTypeKey);
    if (unitId === undefined) return Promise.resolve();
    const dedupe = dedupeKey(key, entry.variant, entry.startedAt, unitId);
    if (this.enrolled.has(dedupe)) return Promise.resolve();
    this.enrolled.add(dedupe);
    return this.tracker.track(eventFor(key, entry.variant, unitId, entry.startedAt));
  }

  private get cacheKey(): string {
    return `${CACHE_KEY_PREFIX}${this.clientKey}`;
  }

  private readCacheEntries(): CacheEntry[] {
    const raw = this.storage?.getItem(this.cacheKey);
    if (raw === null || raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(
        (entry: unknown): entry is CacheEntry =>
          isRecord(entry) && typeof entry.k === "string" && typeof entry.t === "number",
      );
    } catch {
      return [];
    }
  }

  private readCache(key: string): { wire: WireAssignments; savedAt: number } | null {
    const entry = this.readCacheEntries().find((candidate) => candidate.k === key);
    if (entry === undefined) return null;
    const wire = parseAssignments(entry, this.warn);
    return wire === null ? null : { wire, savedAt: Math.min(entry.t, Date.now()) };
  }

  private writeCache(key: string, wire: WireAssignments, savedAt: number): void {
    if (this.storage === null) return;
    const entries = this.readCacheEntries().filter((entry) => entry.k !== key);
    entries.unshift({ k: key, t: savedAt, ...wire });
    this.storage.setItem(
      this.cacheKey,
      JSON.stringify({ v: 1, entries: entries.slice(0, MAX_CACHE_ENTRIES) }),
    );
  }
}

/** Names the unit types, never their ids, that keep a bootstrap from serving `units`. */
function unitMismatch(generatedFor: Readonly<UnitMap>, units: Readonly<UnitMap>): string {
  const types = Object.keys(generatedFor);
  const missing = types.filter((type) => !hasOwn(units, type));
  const changed = types.filter(
    (type) => hasOwn(units, type) && !sameUnit(generatedFor, units, type),
  );
  const why = [
    ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
    ...(changed.length > 0 ? [`another id: ${changed.join(", ")}`] : []),
  ];
  return `bootstrap ignored: the context's units don't match the ones it was generated for (${why.join("; ")})`;
}

function clientKeyProblem(clientKey: unknown): string | null {
  if (typeof clientKey !== "string" || clientKey === "") {
    return "clientKey is required: pass the client key (ck_…) from Settings → SDK & keys → Client key";
  }
  if (clientKey.startsWith("sk_")) {
    return (
      "clientKey is a server key (sk_…). Server keys are secrets: never put one in browser " +
      "code. Use the client key (ck_…) from Settings → SDK & keys → Client key, and revoke " +
      "this server key, since it has been exposed."
    );
  }
  if (!clientKey.startsWith("ck_")) {
    return "clientKey must be a client key (ck_…), from Settings → SDK & keys → Client key";
  }
  return null;
}

function apiUrlOf(value: unknown): string | { problem: string } {
  if (value === undefined) return DEFAULT_API_URL;
  if (typeof value !== "string") return { problem: "apiUrl must be a string" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: "apiUrl isn't a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { problem: "apiUrl must be an http or https URL" };
  }
  if (url.username !== "" || url.password !== "") {
    return { problem: "apiUrl must not contain credentials" };
  }
  if (url.search !== "" || url.hash !== "") {
    return { problem: "apiUrl must not have a query string or fragment" };
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function durationOf(
  name: string,
  value: unknown,
  fallback: number,
  invalid: (message: string) => void,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    invalid(`${name} must be a positive number of milliseconds; using ${fallback}`);
    return fallback;
  }
  return value;
}

function timeoutOf(value: unknown, fallback: number): number {
  return typeof value === "number" && !Number.isNaN(value) ? Math.max(value, 0) : fallback;
}

function trackingOf(
  value: unknown,
  invalid: (message: string) => void,
): ChertoEnrollmentTrackingConfig {
  if (value === undefined) return { mode: "cherto" };
  if (isRecord(value)) {
    const { mode, logger } = value;
    if (mode === "cherto" || mode === "none") return { mode };
    if (mode === "custom") {
      if (typeof logger === "function") return { mode, logger: (event) => logger(event) };
      invalid(
        'enrollmentTracking.logger must be a function when mode is "custom"; recording no enrollment',
      );
      return { mode: "none" };
    }
  }
  invalid('enrollmentTracking.mode must be "cherto", "custom" or "none"; recording no enrollment');
  return { mode: "none" };
}

const EVENT_BUFFER_MINIMUMS: EventBufferTuning = {
  flushIntervalMs: 0,
  maxBatchSize: 1,
  maxQueueSize: 1,
  maxFlushAttempts: 1,
  flushRetryBaseDelayMs: 0,
};

function eventBufferTuning(value: unknown, invalid: (message: string) => void): EventBufferTuning {
  const tuning: EventBufferTuning = { ...EVENT_BUFFER_DEFAULTS };
  if (value === undefined) return tuning;
  if (!isRecord(value)) {
    invalid("eventBuffer must be an object; using the defaults");
    return tuning;
  }
  for (const name of Object.keys(EVENT_BUFFER_MINIMUMS) as Array<keyof EventBufferTuning>) {
    const option = value[name];
    if (option === undefined) continue;
    const min = EVENT_BUFFER_MINIMUMS[name];
    if (typeof option !== "number" || !Number.isFinite(option) || option < min) {
      invalid(`eventBuffer.${name} must be a number of at least ${min}; using ${tuning[name]}`);
      continue;
    }
    tuning[name] = name === "maxBatchSize" ? Math.min(option, MAX_EVENTS_PER_REQUEST) : option;
  }
  return tuning;
}

function sdkWrapperOf(value: unknown): { name: string; version: string } | undefined {
  if (!isRecord(value)) return undefined;
  const { name, version } = value;
  return typeof name === "string" && typeof version === "string" ? { name, version } : undefined;
}

function assignmentOf(entry: AssignmentEntry): ChertoAssignment {
  return {
    variant: entry.variant,
    startedAt: entry.startedAt,
    ...(entry.customValue !== undefined ? { customValue: copyJson(entry.customValue) } : {}),
  };
}

function unitIdOf(set: AssignmentSet, unitTypeKey: string): string | undefined {
  return hasOwn(set.units, unitTypeKey) ? set.units[unitTypeKey] : undefined;
}

function eventFor(
  experimentKey: string,
  variantKey: string,
  unitId: string,
  startedAt: string,
): ChertoEnrollmentEvent {
  return {
    eventId: generateUuid(),
    experimentKey,
    variantKey,
    unitId,
    startedAt,
    occurredAt: new Date().toISOString(),
  };
}

/** A restart moves `startedAt`, so a unit is enrolled again in each run. */
function dedupeKey(key: string, variant: string, startedAt: string, unitId: string): string {
  return JSON.stringify([key, variant, startedAt, unitId]);
}

/** The page's or worker's global scope, or `undefined` outside a browser. */
function browserScope(): EventTarget | undefined {
  if (typeof window !== "undefined") return window;
  const scope = globalThis as typeof globalThis & { WorkerGlobalScope?: unknown };
  return scope.WorkerGlobalScope === undefined ? undefined : (scope as unknown as EventTarget);
}

function hasUnits(context: BoundContext): boolean {
  return Object.keys(context.input.units).length > 0;
}

function asError(err: unknown): ChertoError {
  return err instanceof ChertoError
    ? err
    : new ChertoError("bad_response", "[cherto] unexpected failure", { cause: err });
}
