import { asTransportError } from "@cherto/core";

export const FETCH_TIMEOUT_MS = 10_000;

/** `fetch` that gives up after `timeoutMs`, at most {@link FETCH_TIMEOUT_MS}. */
export async function timedFetch(
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, FETCH_TIMEOUT_MS))),
    });
  } catch (err) {
    throw asTransportError(err, what);
  }
}
