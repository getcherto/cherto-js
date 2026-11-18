import { vi, type Mock } from "vitest";
import { createBootstrap } from "@cherto/core";
import {
  ChertoClient,
  type ChertoBootstrap,
  type ChertoClientOptions,
  type ChertoEnrollmentEvent,
  type ChertoStorage,
} from "@cherto/browser";

export const API_URL = "https://api.example.com";
const STARTED_AT = "2026-01-01T00:00:00.000Z";

type LogFn = (message: string, meta?: Record<string, unknown>) => void;

/** A bootstrap assigning `checkout-copy` to `treatment` for user `u1`. */
export function checkoutBootstrap(
  customValue: Record<string, unknown> = { headline: "Save big", discount: 10 },
): ChertoBootstrap {
  return createBootstrap({
    units: { user: "u1" },
    experiments: [
      {
        key: "checkout-copy",
        unitTypeKey: "user",
        assignment: { variant: "treatment", startedAt: STARTED_AT, customValue },
      },
    ],
  });
}

export function memoryStorage(): ChertoStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

/** Load `checkout-copy` as `treatment` for user `u1` once, so `storage` has it saved. */
export async function saveAssignments(storage: ChertoStorage): Promise<void> {
  const { client } = makeClient({ storage, context: { units: { user: "u1" } } });
  await client.initialize();
  await client.close();
}

/**
 * A `fetch` answering `/v1/initialize` with `checkout-copy` assigned as `variantOf(units)`,
 * recording the units each request carried.
 */
export function fakeApi(variantOf: (units: Record<string, string>) => string = () => "treatment") {
  const requests: Array<Record<string, string>> = [];
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { context } = JSON.parse(String(init?.body)) as {
      context: { units: Record<string, string> };
    };
    requests.push(context.units);
    const experiments = [
      {
        key: "checkout-copy",
        variant: variantOf(context.units),
        unitTypeKey: "user",
        startedAt: STARTED_AT,
      },
    ];
    return new Response(JSON.stringify({ experiments }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}

/** Options for a client with a fake API, no storage, and enrollment recorded into `events`. */
export function clientOptions(
  overrides: Partial<ChertoClientOptions> = {},
  variantOf?: (units: Record<string, string>) => string,
) {
  const api = fakeApi(variantOf);
  const events: ChertoEnrollmentEvent[] = [];
  const logger: { warn: Mock<LogFn>; error: Mock<LogFn> } = { warn: vi.fn(), error: vi.fn() };
  const options: ChertoClientOptions = {
    clientKey: "ck_test",
    apiUrl: API_URL,
    fetch: api.fetch,
    storage: null,
    logger,
    enrollmentTracking: { mode: "custom", logger: (event) => events.push(event) },
    ...overrides,
  };
  return { options, api, events, logger };
}

export function makeClient(
  overrides: Partial<ChertoClientOptions> = {},
  variantOf?: (units: Record<string, string>) => string,
) {
  const made = clientOptions(overrides, variantOf);
  return { client: new ChertoClient(made.options), ...made };
}
