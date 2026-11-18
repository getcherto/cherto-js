import { vi, type Mock } from "vitest";
import { createBootstrap, type BootstrapExperiment, type BootstrapHoldout } from "@cherto/core";
import type { ChertoBootstrap, ChertoEnrollmentEvent, ChertoError } from "@cherto/core";
import { ChertoClient } from "./client.js";
import { EVENT_BUFFER_DEFAULTS, EventBuffer, type EventBufferOptions } from "./event-buffer.js";
import type { ChertoClientOptions, ChertoStorage } from "./types.js";

export const API = "https://api.example.com";
export const STARTED_AT = "2026-01-01T00:00:00.000Z";
export const PENDING_KEY = "cherto:events:pending:ck_test";

export interface Call {
  url: string;
  init: RequestInit;
  body: unknown;
}

export type Responder = (call: Call, index: number) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An experiment as `/v1/initialize` returns it, on the `user` unit type. */
export function exp(key: string, variant: string, extra: Record<string, unknown> = {}) {
  return { key, variant, unitTypeKey: "user", startedAt: STARTED_AT, ...extra };
}

export function assigned(...experiments: unknown[]): Response {
  return json({ experiments });
}

/** A fetch that records each call and answers with `respond`. */
export function fakeServer(respond: Responder = () => assigned()) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      init: init ?? {},
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    initCalls: () => calls.filter((call) => call.url.endsWith("/v1/initialize")),
  };
}

/** The units an `/v1/initialize` call was made for. */
export function unitsOf(call: Call): Record<string, string | undefined> {
  return (call.body as { context: { units: Record<string, string | undefined> } }).context.units;
}

export function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  };
  return { storage: storage satisfies ChertoStorage, store };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type LogFn = (message: string, meta?: Record<string, unknown>) => void;

export function quietLogger(): { warn: Mock<LogFn>; error: Mock<LogFn> } {
  return { warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
}

/** A client with recording fetch, logger, onError and custom enrollment sink. */
export function makeClient(options: Partial<ChertoClientOptions> = {}, respond?: Responder) {
  const server = fakeServer(respond);
  const events: ChertoEnrollmentEvent[] = [];
  const errors: ChertoError[] = [];
  const logger = quietLogger();
  const client = new ChertoClient({
    clientKey: "ck_test",
    apiUrl: API,
    fetch: server.fetch,
    storage: null,
    logger,
    onError: (err) => {
      errors.push(err);
    },
    enrollmentTracking: {
      mode: "custom",
      logger: (event) => {
        events.push(event);
      },
    },
    ...options,
  });
  return { client, server, events, errors, logger };
}

/** Save `experiments` for `units` in `storage`, as an earlier page load would. */
export async function primeCache(
  storage: ChertoStorage,
  units: Record<string, string>,
  experiments: unknown[],
): Promise<void> {
  const { client } = makeClient({ storage, context: { units } }, () => assigned(...experiments));
  await client.initialize();
}

/** What a server context hands the browser, as `ctx.getBootstrap()` builds it. */
export function bootstrapOf(parts: {
  units?: Record<string, string>;
  attributes?: Record<string, string | number | boolean>;
  experiments?: Array<
    Omit<BootstrapExperiment, "unitTypeKey" | "assignment"> & {
      variant: string;
      unitTypeKey?: string;
      customValue?: Record<string, unknown>;
      startedAt?: string;
    }
  >;
  holdouts?: BootstrapHoldout[];
  enrolled?: string[];
  enrolledHoldouts?: string[];
  generatedAt?: Date;
}): ChertoBootstrap {
  const units = parts.units ?? { user: "u1" };
  return createBootstrap({
    units,
    ...(parts.attributes ? { attributes: parts.attributes } : {}),
    experiments: (parts.experiments ?? []).map(
      ({ variant, customValue, startedAt, unitTypeKey, ...rest }) => ({
        ...rest,
        unitTypeKey: unitTypeKey ?? "user",
        assignment: {
          variant,
          startedAt: startedAt ?? STARTED_AT,
          ...(customValue ? { customValue } : {}),
        },
      }),
    ),
    ...(parts.holdouts ? { holdouts: parts.holdouts } : {}),
    ...(parts.enrolled ? { enrolled: new Set(parts.enrolled) } : {}),
    ...(parts.enrolledHoldouts ? { enrolledHoldouts: new Set(parts.enrolledHoldouts) } : {}),
    now: parts.generatedAt ?? new Date(),
  });
}

/** Wait one macrotask, so pending fetches and their bodies resolve. Fake timers don't affect it. */
export async function settle(): Promise<void> {
  const { port1, port2 } = new MessageChannel();
  await new Promise<void>((resolve) => {
    port1.onmessage = () => resolve();
    port2.postMessage(null);
  });
  port1.close();
}

let seq = 0;

export function event(overrides: Partial<ChertoEnrollmentEvent> = {}): ChertoEnrollmentEvent {
  seq++;
  return {
    eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    experimentKey: "hero",
    variantKey: "treatment",
    unitId: `u${seq}`,
    startedAt: STARTED_AT,
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

export interface Page {
  sendBeacon: Mock<(url: string, data: Blob) => boolean>;
  hide(): void;
  show(): void;
  unload(): void;
}

/** Stub `window`, `document` and `navigator.sendBeacon`, with controls for page visibility. */
export function stubPage(beaconAccepts: () => boolean = () => true): Page {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const sendBeacon = vi.fn<(url: string, data: Blob) => boolean>(() => beaconAccepts());
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { userAgent: "test", sendBeacon });
  const setVisibility = (state: string) => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return {
    sendBeacon,
    hide: () => setVisibility("hidden"),
    show: () => setVisibility("visible"),
    unload: () => void win.dispatchEvent(new Event("pagehide")),
  };
}

/** An EventBuffer with a recording fetch, logger and onError, and no retry delay. */
export function makeBuffer(
  options: Partial<EventBufferOptions> = {},
  respond: Responder = () => json({ accepted: 1 }),
) {
  const server = fakeServer(respond);
  const errors: ChertoError[] = [];
  const logger = quietLogger();
  const buffer = new EventBuffer({
    clientKey: "ck_test",
    apiUrl: API,
    sdkIdentity: "browser/1.0.0",
    fetch: server.fetch,
    storage: null,
    logger,
    onError: (err) => errors.push(err),
    ...EVENT_BUFFER_DEFAULTS,
    flushRetryBaseDelayMs: 0,
    ...options,
  });
  const sentEvents = () =>
    server.calls.flatMap((call) => (call.body as { events: ChertoEnrollmentEvent[] }).events);
  return { buffer, server, errors, logger, sentEvents };
}
