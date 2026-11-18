/**
 * The caller's id for `unitTypeKey`, or `undefined` when the map doesn't own one. Never an
 * inherited value: a unit type may be named `constructor` or `__proto__`.
 */
export function unitIdOf(
  units: Readonly<Record<string, string>>,
  unitTypeKey: string,
): string | undefined {
  return Object.hasOwn(units, unitTypeKey) ? units[unitTypeKey] : undefined;
}
