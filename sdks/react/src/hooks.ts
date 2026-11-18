import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ChertoAssignment, ChertoClient, ChertoReadOptions } from "@cherto/browser";
import { HYDRATING, isRetired, useChertoContextValue } from "./provider.js";

const READ_ONLY = { track: false } as const;
const hydrating = () => HYDRATING;

/**
 * While the component hydrates, React takes the server snapshot, so it reads from the
 * provider's hydration client, which serves what the server rendered even after the provider
 * has applied a context. A provider given a `client` has none.
 */
function useReader(): { client: ChertoClient; reader: ChertoClient; version: number } {
  const { client, hydrationClient, store } = useChertoContextValue();
  const version = useSyncExternalStore(store.subscribe, store.getVersion, hydrating);
  const reader = version === HYDRATING && hydrationClient !== undefined ? hydrationClient : client;
  return { client, reader, version };
}

/**
 * Enroll in an effect, never during render, so a server render records nothing. `version`
 * re-runs it when assignments change, such as when they load after mount.
 */
function useEnrollment(
  client: ChertoClient,
  version: number,
  key: string,
  opts: ChertoReadOptions | undefined,
): void {
  const track = opts?.track ?? true;
  useEffect(() => {
    if (track && !isRetired(client)) void client.trackEnrollment(key);
  }, [client, version, key, track]);
}

/**
 * The object returned last while `read` is JSON-equal to it, so effects and memos keyed on a
 * value don't re-run each render. `fallback` is returned as is.
 */
function useStable<T>(read: T, fallback?: T): T {
  const last = useRef<{ value: T } | null>(null);
  if (read === null || typeof read !== "object" || Object.is(read, fallback)) return read;
  const kept = last.current;
  if (kept !== null && JSON.stringify(kept.value) === JSON.stringify(read)) return kept.value;
  last.current = { value: read };
  return read;
}

/** Read a variant key, enrolling by default. Returns `defaultValue` when there is no assignment. */
export function useChertoVariant(
  key: string,
  defaultValue: string,
  opts?: ChertoReadOptions,
): string {
  const { client, reader, version } = useReader();
  useEnrollment(client, version, key, opts);
  return reader.getVariant(key, defaultValue, READ_ONLY);
}

/**
 * Read a variant's custom value, enrolling by default. Returns `defaultValue` when there is
 * none, or when a string, number or boolean default doesn't match the value's type. Returns
 * the same copy across renders while the value is unchanged.
 */
export function useChertoVariantValue<T = Record<string, unknown>>(
  key: string,
  defaultValue: T,
  opts?: ChertoReadOptions,
): T {
  const { client, reader, version } = useReader();
  useEnrollment(client, version, key, opts);
  return useStable(reader.getVariantValue(key, defaultValue, READ_ONLY), defaultValue);
}

/**
 * Read one param of a variant's custom value, enrolling by default. Returns `defaultValue`
 * when it is absent, or when a string, number or boolean default doesn't match its type. An
 * object or array param is the same copy across renders while it is unchanged.
 */
export function useChertoVariantParam<T = unknown>(
  key: string,
  paramKey: string,
  defaultValue: T,
  opts?: ChertoReadOptions,
): T {
  const { client, reader, version } = useReader();
  useEnrollment(client, version, key, opts);
  return useStable(reader.getVariantParam(key, paramKey, defaultValue, READ_ONLY), defaultValue);
}

/**
 * Read the assignment for `key` without enrolling, or `null` when there is none. Returns the
 * same object across renders while the assignment is unchanged.
 */
export function useChertoAssignment(key: string): ChertoAssignment | null {
  return useStable(useReader().reader.getAssignment(key));
}
