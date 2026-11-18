import {
  ChertoError,
  asTransportError,
  backoffMs,
  httpError,
  timerMs,
  type WarnFn,
} from "@cherto/core";
import { parseAssignments, type WireAssignments } from "./assignments.js";

const WHAT = "assignment request";
const RETRY_BASE_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 2_000;
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export interface LoadOptions {
  fetch: typeof fetch;
  url: string;
  headers: Record<string, string>;
  body: string;
  /** The whole call's budget, retries and body reads included. */
  budgetMs: number;
  /** How long past the budget a request may still complete, for {@link onLate}. */
  graceMs: number;
  warn: WarnFn;
  /** Receives a response that completed after the budget ran out. */
  onLate(wire: WireAssignments): void;
  /** Aborting it aborts every request. */
  signal: AbortSignal | undefined;
}

export type LoadOutcome = { ok: true; wire: WireAssignments } | { ok: false; error: ChertoError };

/**
 * POST `/v1/initialize`, retrying network failures, timeouts, 429 and 502-504 with backoff
 * while the budget lasts. Never rejects.
 */
export async function loadAssignments(opts: LoadOptions): Promise<LoadOutcome> {
  const deadline = Date.now() + opts.budgetMs;
  for (let attempt = 1; ; attempt++) {
    const pending = request(opts, deadline + opts.graceMs);
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      pending.then(
        (wire) => ({ kind: "done" as const, wire }),
        (error: unknown) => ({ kind: "failed" as const, error: asTransportError(error, WHAT) }),
      ),
      new Promise<{ kind: "expired" }>((resolve) => {
        budgetTimer = setTimeout(
          () => resolve({ kind: "expired" }),
          timerMs(deadline - Date.now()),
        );
      }),
    ]);
    clearTimeout(budgetTimer);
    if (raced.kind === "done") return { ok: true, wire: raced.wire };
    if (raced.kind === "expired") {
      pending.then(opts.onLate, () => {});
      return {
        ok: false,
        error: new ChertoError("timeout", `[cherto] ${WHAT} timed out after ${opts.budgetMs} ms`),
      };
    }
    const { error } = raced;
    if (!shouldRetry(error) || opts.signal?.aborted) return { ok: false, error };
    const delay = Math.max(
      backoffMs(RETRY_BASE_DELAY_MS, attempt, MAX_RETRY_DELAY_MS),
      error.retryAfterMs ?? 0,
    );
    if (Date.now() + delay >= deadline) return { ok: false, error };
    await sleep(delay);
  }
}

function shouldRetry(err: ChertoError): boolean {
  if (err.status !== undefined) return err.status === 429 || RETRYABLE_STATUSES.has(err.status);
  return err.code === "network" || err.code === "timeout";
}

/** One request, its body read included, abandoned at `hardDeadline`. */
async function request(opts: LoadOptions, hardDeadline: number): Promise<WireAssignments> {
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  const abort = () => controller?.abort();
  opts.signal?.addEventListener("abort", abort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        abort();
        reject(new ChertoError("timeout", `[cherto] ${WHAT} timed out`));
      },
      timerMs(hardDeadline - Date.now()),
    );
  });
  expired.catch(() => {});
  try {
    if (opts.signal?.aborted) throw new ChertoError("timeout", `[cherto] ${WHAT} was cancelled`);
    const res = await Promise.race([
      opts.fetch(opts.url, {
        method: "POST",
        headers: opts.headers,
        body: opts.body,
        ...(controller ? { signal: controller.signal } : {}),
      }),
      expired,
    ]);
    const text = await Promise.race([res.text(), expired]);
    if (!res.ok) {
      throw httpError(
        { status: res.status, retryAfter: res.headers.get("retry-after"), body: text },
        WHAT,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (cause) {
      throw new ChertoError("bad_response", `[cherto] ${WHAT} returned unparseable JSON`, {
        cause,
      });
    }
    const wire = parseAssignments(body, opts.warn);
    if (wire === null) {
      throw new ChertoError("bad_response", `[cherto] ${WHAT} returned an unexpected body`);
    }
    return wire;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timerMs(ms)));
}
