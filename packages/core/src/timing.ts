// setTimeout fires at once for anything longer.
const MAX_TIMER_MS = 2_147_483_647;

export function timerMs(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_TIMER_MS);
}

/** Doubling backoff for retry `attempt` (from 1), capped at `maxMs`, jittered over its top half. */
export function backoffMs(baseMs: number, attempt: number, maxMs = Infinity): number {
  const ms = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  return ms / 2 + Math.random() * (ms / 2);
}

/** Settles with `work`, or resolves once `ms` has passed, whichever comes first. */
export function untilDeadline(work: Promise<void>, ms: number): Promise<void> {
  if (ms === Infinity) return work;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, timerMs(ms));
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
