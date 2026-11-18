// Overrides force a matching unit into a variant ahead of targeting, the traffic gate and
// allocation. They never touch the hash input, so no other unit is re-bucketed.
import type { Attributes, TargetingWarn } from "./targeting.js";
import type { TargetingEnvelope } from "./types.js";
import { isEligible } from "./targeting.js";
import { unitIdOf } from "./units.js";

/**
 * When an override applies: `unit_id` matches a `(unitTypeKey, unitId)` pair against any unit
 * the caller sends; `targeting_group` matches the group's rules, inlined as `targeting`.
 */
export type VariantOverrideMatch =
  | { type: "unit_id"; unitTypeKey: string; unitId: string }
  | { type: "targeting_group"; targetingGroupId: string; targeting: TargetingEnvelope | null };

/** One override in an experiment's config. */
export interface VariantOverride {
  id: string;
  match: VariantOverrideMatch;
  variantKey: string;
  /** Priority: lowest wins, ties broken by `id`. `unit_id` overrides always rank first. */
  position: number;
}

/** The override that applies, and the variant it forces. */
export interface ResolvedOverride {
  overrideId: string;
  variantKey: string;
}

/**
 * The first override in `overrides` that matches this unit, or null. `overrides` must already
 * be in priority order (see {@link VariantOverride.position}); it isn't re-sorted here.
 *
 * Fails closed, unlike isEligible: a malformed entry, an unknown match type or an envelope
 * isEligible would wave through matches nobody, since honoring it would force all traffic.
 * Unit ids and attribute values never reach a warning.
 */
export function resolveOverride(
  overrides: VariantOverride[] | null | undefined,
  units: Record<string, string>,
  attributes: Attributes | undefined,
  warn: TargetingWarn,
): ResolvedOverride | null {
  if (!Array.isArray(overrides) || overrides.length === 0) return null;

  for (const override of overrides) {
    if (!isWellFormed(override)) {
      warn(
        { overrideId: (override as { id?: unknown })?.id },
        "variant override: malformed entry; ignoring (no force)",
      );
      continue;
    }
    const { match } = override;
    if (match.type === "unit_id") {
      if (unitIdOf(units, match.unitTypeKey) === match.unitId) {
        return { overrideId: override.id, variantKey: override.variantKey };
      }
      continue;
    }
    if (!isOverrideEnvelope(match.targeting)) {
      warn(
        {
          overrideId: override.id,
          targetingGroupId: match.targetingGroupId,
          envelopeVersion: (match.targeting as { version?: unknown } | null)?.version,
        },
        "variant override: envelope absent, unsupported, or has no conditions; " +
          "ignoring (honoring it would force all traffic)",
      );
      continue;
    }
    if (isEligible(match.targeting, attributes, warn)) {
      return { overrideId: override.id, variantKey: override.variantKey };
    }
  }

  return null;
}

/** Must match `SUPPORTED_VERSION` in targeting.ts. */
const SUPPORTED_ENVELOPE_VERSION = 1;

/** Whether `isEligible` will evaluate this envelope on its merits rather than fail open. */
function isOverrideEnvelope(targeting: TargetingEnvelope | null | undefined): boolean {
  if (targeting == null || typeof targeting !== "object") return false;
  if (targeting.version !== SUPPORTED_ENVELOPE_VERSION) return false;
  if (!Array.isArray(targeting.rules) || targeting.rules.length === 0) return false;
  // Every group needs a clause: one empty group matches everyone.
  return targeting.rules.every(
    (group) => Array.isArray(group?.clauses) && group.clauses.length > 0,
  );
}

// An older reader can meet a shape a newer server wrote.
function isWellFormed(override: VariantOverride | null | undefined): override is VariantOverride {
  if (override == null || typeof override !== "object") return false;
  if (typeof override.id !== "string" || override.id === "") return false;
  if (typeof override.variantKey !== "string" || override.variantKey === "") return false;
  if (typeof override.position !== "number" || !Number.isFinite(override.position)) return false;
  const match = override.match;
  if (match == null || typeof match !== "object") return false;
  if (match.type === "unit_id") {
    return (
      typeof match.unitTypeKey === "string" &&
      match.unitTypeKey !== "" &&
      typeof match.unitId === "string" &&
      match.unitId !== ""
    );
  }
  if (match.type === "targeting_group") {
    return typeof match.targetingGroupId === "string" && match.targetingGroupId !== "";
  }
  return false;
}
