import { hasOwn, sortedEntries, type NormalizedContext, type UnitMap } from "@cherto/core";

/**
 * The canonical form of a normalized context: keys sorted, and `"1"` kept apart from `1` as
 * targeting does. The cache stores only its digest, so attribute values never reach storage; a
 * collision only serves another context's assignments until the next load.
 */
export function contextIdentity(context: NormalizedContext): string {
  return JSON.stringify([sortedEntries(context.units), sortedEntries(context.attributes ?? {})]);
}

/** Whether both contexts have the same attributes. */
export function sameAttributes(a: NormalizedContext, b: NormalizedContext): boolean {
  return (
    JSON.stringify(sortedEntries(a.attributes ?? {})) ===
    JSON.stringify(sortedEntries(b.attributes ?? {}))
  );
}

/** Whether `unitTypeKey` has the same id in both maps. */
export function sameUnit(a: Readonly<UnitMap>, b: Readonly<UnitMap>, unitTypeKey: string): boolean {
  return hasOwn(a, unitTypeKey) && hasOwn(b, unitTypeKey) && a[unitTypeKey] === b[unitTypeKey];
}

/** Whether every unit in `subset` is in `units` with the same id. */
export function unitsWithin(subset: Readonly<UnitMap>, units: Readonly<UnitMap>): boolean {
  return Object.keys(subset).every((type) => sameUnit(subset, units, type));
}
