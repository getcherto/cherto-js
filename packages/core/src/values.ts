import type { WarnFn } from "./logger.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `Object.hasOwn` is missing from some browsers the SDK still supports.
export function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** The JSON-style type name of `value`, for logs that must not include the value itself. */
export function shapeOf(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** A deep copy of a JSON value, so a caller mutating it can't change what later reads see. */
export function copyJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyJson) as T;
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // Plain assignment would call the `__proto__` setter instead of copying the key.
      if (key === "__proto__") setOwn(copy, key, copyJson(item));
      else copy[key] = copyJson(item);
    }
    return copy as T;
  }
  return value;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** Whether `value` is an ISO 8601 date-time, the format `POST /v1/events` accepts. */
export function isDateTime(value: unknown): value is string {
  return typeof value === "string" && DATE_TIME.test(value);
}

/** Assign `key` as an own property, even `__proto__`. */
export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** One param of a variant's custom value, ignoring inherited properties such as `toString`. */
export function paramOf(
  customValue: Readonly<Record<string, unknown>> | undefined,
  paramKey: string,
): unknown {
  if (customValue === undefined || typeof paramKey !== "string") return undefined;
  return hasOwn(customValue, paramKey) ? customValue[paramKey] : undefined;
}

/**
 * `value`, or the default (with a warning) when a string, number or boolean default doesn't
 * match its type. Any other default is trusted.
 */
export function ifTypeMatches<T>(
  experimentKey: string,
  what: string,
  value: unknown,
  defaultValue: T,
  warn: WarnFn,
): T {
  const expected = typeof defaultValue;
  if (expected !== "string" && expected !== "number" && expected !== "boolean") {
    return value as T;
  }
  if (typeof value === expected) return value as T;
  warn(
    { experimentKey, expected, actual: shapeOf(value) },
    `${what} doesn't match the type of the caller's default, serving the default`,
  );
  return defaultValue;
}
