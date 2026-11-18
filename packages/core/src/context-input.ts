import type { WarnFn } from "./logger.js";
import type { Attributes, ChertoAttributeValue, UnitMap } from "./types.js";
import { isRecord, shapeOf } from "./values.js";

/** The units and attributes assignments are evaluated for. */
export interface ChertoContextInput {
  /**
   * Unit-type key to unit id, e.g. `{ user: "u_123" }`. A bigint, or a number that is a safe
   * integer, is converted to a decimal string; pass larger ids as strings. An `undefined` id
   * leaves the unit absent, and experiments on it are skipped.
   */
  units: Readonly<Record<string, string | number | bigint | undefined>>;
  /**
   * Attributes for audience targeting: strings, finite numbers and booleans. An `undefined`
   * value is treated as absent.
   */
  attributes?: Readonly<Record<string, ChertoAttributeValue | undefined>>;
}

export interface NormalizedContext {
  units: UnitMap;
  attributes: Attributes | undefined;
}

/** {@link normalizeUnits} and {@link normalizeAttributes} of a caller's context. */
export function normalizeContext(input: unknown, warn: WarnFn): NormalizedContext {
  if (!isRecord(input)) {
    if (input !== undefined) {
      warn({ type: shapeOf(input) }, "context must be an object with units, treating it as empty");
    }
    return { units: Object.create(null) as UnitMap, attributes: undefined };
  }
  return {
    units: normalizeUnits(input.units, warn),
    attributes: normalizeAttributes(input.attributes, warn),
  };
}

/**
 * A null-prototype copy of `units` with every id a string. A bigint, or a number that is a
 * safe integer, becomes its decimal string; an `undefined` id is absent; any other id is
 * absent with a warning.
 */
export function normalizeUnits(units: unknown, warn: WarnFn): UnitMap {
  const copy = Object.create(null) as UnitMap;
  if (!isRecord(units)) {
    if (units !== undefined) {
      warn({ type: shapeOf(units) }, "units must be an object, treating every unit as absent");
    }
    return copy;
  }
  for (const [unitTypeKey, unitId] of Object.entries(units)) {
    if (unitId === undefined) continue;
    if (typeof unitId === "string" && unitId !== "") {
      copy[unitTypeKey] = unitId;
    } else if (typeof unitId === "bigint") {
      copy[unitTypeKey] = unitId.toString();
    } else if (typeof unitId === "number") {
      if (Number.isSafeInteger(unitId)) {
        copy[unitTypeKey] = String(unitId);
      } else {
        warn(
          { unitTypeKey },
          `unit id for "${unitTypeKey}" is a number that isn't a safe integer, treating the ` +
            "unit as absent; pass the id as a string",
        );
      }
    } else if (unitId === null || unitId === "") {
      warn({ unitTypeKey }, `unit id for "${unitTypeKey}" is empty, treating the unit as absent`);
    } else {
      warn(
        { unitTypeKey, type: shapeOf(unitId) },
        `unit id for "${unitTypeKey}" isn't a string, number or bigint, treating the unit as absent`,
      );
    }
  }
  return copy;
}

/**
 * A null-prototype copy of `attributes` holding only strings, finite numbers and booleans.
 * An `undefined` value is absent; any other is absent with a warning naming its type, never
 * its value.
 */
export function normalizeAttributes(attributes: unknown, warn: WarnFn): Attributes | undefined {
  if (attributes === undefined || attributes === null) return undefined;
  if (!isRecord(attributes)) {
    warn(
      { type: shapeOf(attributes) },
      "attributes must be an object, treating every attribute as absent",
    );
    return undefined;
  }
  const copy = Object.create(null) as Attributes;
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "boolean") {
      copy[name] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      copy[name] = value === 0 ? 0 : value; // -0 becomes 0
    } else {
      warn(
        { attribute: name, type: shapeOf(value) },
        `attribute "${name}" isn't a string, finite number or boolean, treating it as absent`,
      );
    }
  }
  return copy;
}

/** `record`'s entries in key order, so serializing them ignores the order keys were set in. */
export function sortedEntries<T>(record: Readonly<Record<string, T>>): Array<[string, T]> {
  return Object.keys(record)
    .sort()
    .map((key) => [key, record[key]]);
}

/** A cyrb53 digest: short and stable, not cryptographic. */
export function digest(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A digest of {@link normalizeAttributes}' output, the same in every SDK. No attributes and
 * empty ones digest alike.
 */
export function attributesDigest(attributes: Readonly<Attributes> | undefined): string {
  return digest(JSON.stringify(sortedEntries(attributes ?? {})));
}
