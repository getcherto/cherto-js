// One experiment's evaluation, in the order every reader applies it: status, variant override,
// targeting, holdout, the concluded winner, then unit, traffic gate and allocation. Pure and
// synchronous; what it passes over comes back as warnings for the caller to log.
import type { Attributes } from "./targeting.js";
import type { TargetingEnvelope } from "./types.js";
import type { VariantOverride } from "./overrides.js";
import {
  allocateHoldout,
  allocateVariant,
  isInTrafficGate,
  variantAllocationProblem,
  type HoldoutArm,
  type Variant,
} from "./hash.js";
import { canEvaluateTargeting, isEligible } from "./targeting.js";
import { resolveOverride } from "./overrides.js";
import { unitIdOf } from "./units.js";

/** How a reader treats a config it can't fully evaluate. */
export interface EvaluationPolicy {
  /**
   * Skip, with reason `"error"`, an experiment this build can't evaluate as written: an unknown
   * status, targeting or override match, a running experiment with no salt or unusable
   * allocations, or one a malformed holdout may cover. For a reader that can lag the config's
   * writer. Otherwise evaluate what it can: unknown statuses run, unreadable targeting fails
   * open and unreadable overrides are ignored.
   */
  failClosed: boolean;
}

/** An experiment as a reader receives it. */
export interface ExperimentSpec {
  key: string;
  status: string;
  trafficPercentage: number;
  salt?: string | null;
  unitTypeKey: string;
  concludedVariant?: string | null;
  targeting?: TargetingEnvelope | null;
  variantOverrides?: VariantOverride[] | null;
  variants: Variant[];
  /** The variant a held-out unit is served. Absent or empty: no unit can be held out. */
  controlVariantKey?: string | null;
}

/** A running holdout as a reader receives it. */
export interface HoldoutSpec {
  key: string;
  salt: string;
  unitTypeKey: string;
  percentage: number;
  experimentKeys: string[];
}

/** A holdout hashed for one set of units. */
export interface ResolvedHoldout<H extends HoldoutSpec = HoldoutSpec> {
  holdout: H;
  arm: HoldoutArm;
  covers: ReadonlySet<string>;
}

export interface HoldoutWarning {
  code: "holdout_missing_salt";
  holdoutKey: string;
}

/** Holdouts resolved once per set of units, for every experiment read with them. */
export interface ResolvedHoldouts<H extends HoldoutSpec = HoldoutSpec> {
  /** Each holdout whose unit is present, with that unit's arm, in config order. */
  arms: ResolvedHoldout<H>[];
  /** Experiments a malformed holdout may cover, when failing closed. */
  unservable: ReadonlySet<string> | "all";
  /** Holdouts ignored for these units. */
  warnings: HoldoutWarning[];
}

/** Why {@link experimentProblem} rejects an experiment. */
export type ExperimentProblem =
  | { code: "unsupported_status"; status: string }
  | { code: "unsupported_targeting" }
  | { code: "unsupported_override"; overrideId: unknown }
  | { code: "concluded_without_variant" }
  | { code: "missing_salt" }
  | { code: "invalid_allocation"; detail: string };

/** Why an evaluation served the caller's default with reason `"error"`. */
export type EvaluationProblem =
  | ExperimentProblem
  | { code: "malformed_holdout" }
  | {
      code: "holdout_control_unavailable";
      holdoutKey: string;
      control: "absent" | "unknown_variant";
    };

export type EvaluationReason =
  | "assigned"
  | "concluded"
  | "override"
  | "holdout"
  | "not_running"
  | "not_eligible"
  | "unit_missing"
  | "not_in_traffic"
  | "error";

export type EvaluationErrorCode = "unsupported" | "invalid_experiment";

/** Something evaluation passed over. Never carries a unit id or an attribute value. */
export type EvaluationWarning =
  | { code: "targeting" | "override"; meta: Record<string, unknown>; message: string }
  | { code: "override_unknown_variant"; overrideId: string };

/** The units and attributes of one read. */
export interface EvaluationInput<H extends HoldoutSpec = HoldoutSpec> {
  units: Readonly<Record<string, string>>;
  attributes?: Attributes;
  /** From {@link resolveHoldouts}, for the same units and policy. */
  holdouts?: ResolvedHoldouts<H>;
}

/** What one read of an experiment serves, and why. */
export interface ExperimentEvaluation<H extends HoldoutSpec = HoldoutSpec> {
  /** The variant to serve, or `null` for the caller's default. */
  variantKey: string | null;
  reason: EvaluationReason;
  /** Set when `reason` is `"error"`. */
  errorCode?: EvaluationErrorCode;
  /** Set when `reason` is `"error"`. */
  problem?: EvaluationProblem;
  /** `false` unless the served variant is enrolled against this experiment. */
  trackEnrollment: boolean;
  /** For reason `"override"`. */
  overrideId?: string;
  /** For reason `"holdout"`: the holdout that held the unit out. */
  holdoutKey?: string;
  /** The holdouts this read is an exposure for, in config order. */
  exposedHoldouts: ResolvedHoldout<H>[];
  warnings: EvaluationWarning[];
}

const NOT_SERVING: ReadonlySet<string> = new Set(["draft", "paused"]);
const KNOWN_STATUSES: ReadonlySet<string> = new Set([...NOT_SERVING, "running", "concluded"]);

/** The error code a problem is reported under. */
export function problemErrorCode(problem: EvaluationProblem): EvaluationErrorCode {
  return problem.code.startsWith("unsupported_") ? "unsupported" : "invalid_experiment";
}

/**
 * Why a reader that fails closed can't serve `exp` as written, or `null` when it can. Only a
 * running experiment needs a salt and usable allocations, and only a concluded one a winner.
 */
export function experimentProblem(exp: ExperimentSpec): ExperimentProblem | null {
  if (!KNOWN_STATUSES.has(exp.status)) return { code: "unsupported_status", status: exp.status };
  if (!canEvaluateTargeting(exp.targeting)) return { code: "unsupported_targeting" };
  const override = unevaluableOverride(exp.variantOverrides);
  if (override !== undefined) return { code: "unsupported_override", overrideId: override.id };
  if (exp.status === "concluded" && !exp.concludedVariant) {
    return { code: "concluded_without_variant" };
  }
  if (exp.status !== "running") return null;
  if (typeof exp.salt !== "string" || exp.salt === "") return { code: "missing_salt" };
  const allocation = variantAllocationProblem(exp.variants);
  return allocation === null ? null : { code: "invalid_allocation", detail: allocation };
}

// Ignoring an override this build can't match would bucket the unit it forces. A malformed
// override forces nobody, so it isn't one.
function unevaluableOverride(overrides: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(overrides)) return undefined;
  return (overrides as unknown[]).find((override): override is Record<string, unknown> => {
    const match = isRecord(override) ? override.match : undefined;
    if (!isRecord(match) || typeof match.type !== "string" || match.type === "unit_id") {
      return false;
    }
    return match.type !== "targeting_group" || !canEvaluateTargeting(match.targeting);
  });
}

/** Whether untrusted `entry` has every field a holdout needs to be resolved. */
export function isServableHoldout(entry: unknown): entry is HoldoutSpec {
  return (
    isRecord(entry) &&
    typeof entry.key === "string" &&
    entry.key !== "" &&
    typeof entry.salt === "string" &&
    entry.salt !== "" &&
    typeof entry.unitTypeKey === "string" &&
    typeof entry.percentage === "number" &&
    Number.isFinite(entry.percentage) &&
    Array.isArray(entry.experimentKeys)
  );
}

/** The experiments a malformed holdout may cover: its listed keys, or `"all"` with no list. */
export function holdoutCoverage(entry: unknown): string[] | "all" {
  const keys = isRecord(entry) ? entry.experimentKeys : undefined;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : "all";
}

/**
 * Hash each holdout into an arm for these units. A holdout whose unit is absent doesn't
 * apply, and one with no salt is ignored with a warning. When failing closed, a malformed
 * holdout instead makes the experiments it may cover unservable.
 */
export function resolveHoldouts<H extends HoldoutSpec>(
  holdouts: readonly H[] | null | undefined,
  units: Readonly<Record<string, string>>,
  policy: EvaluationPolicy,
): ResolvedHoldouts<H> {
  const arms: ResolvedHoldout<H>[] = [];
  const warnings: HoldoutWarning[] = [];
  let unservable: Set<string> | "all" = new Set();
  for (const holdout of holdouts ?? []) {
    if (policy.failClosed && !isServableHoldout(holdout)) {
      const coverage = holdoutCoverage(holdout);
      if (coverage === "all") unservable = "all";
      else if (unservable !== "all") for (const key of coverage) unservable.add(key);
      continue;
    }
    const unitId = unitIdOf(units, holdout.unitTypeKey);
    if (unitId === undefined) continue;
    // Hashing an absent salt would bucket every unit on the string "undefined".
    if (!holdout.salt) {
      warnings.push({ code: "holdout_missing_salt", holdoutKey: holdout.key });
      continue;
    }
    arms.push({
      holdout,
      arm: allocateHoldout(holdout.salt, unitId, holdout.percentage),
      covers: new Set(holdout.experimentKeys),
    });
  }
  return { arms, unservable, warnings };
}

/**
 * Evaluate one experiment for one read.
 *
 * Neither targeting nor an override feeds a hash, so a unit that leaves and re-enters the
 * audience, or loses an override, lands where it was.
 */
export function evaluateExperiment<H extends HoldoutSpec>(
  exp: ExperimentSpec,
  input: EvaluationInput<H>,
  policy: EvaluationPolicy,
): ExperimentEvaluation<H> {
  const { units, attributes, holdouts } = input;
  const warnings: EvaluationWarning[] = [];
  const exposedHoldouts: ResolvedHoldout<H>[] = [];
  const outcome = (
    variantKey: string | null,
    reason: EvaluationReason,
    fields: Partial<ExperimentEvaluation<H>> = {},
  ): ExperimentEvaluation<H> => ({
    variantKey,
    reason,
    trackEnrollment: variantKey !== null && reason !== "override" && reason !== "holdout",
    exposedHoldouts,
    warnings,
    ...fields,
  });
  const fail = (problem: EvaluationProblem) =>
    outcome(null, "error", { errorCode: problemErrorCode(problem), problem });

  if (policy.failClosed) {
    const unservable = holdouts?.unservable;
    if (unservable === "all" || unservable?.has(exp.key)) {
      return fail({ code: "malformed_holdout" });
    }
    const problem = experimentProblem(exp);
    if (problem !== null) return fail(problem);
  }
  if (NOT_SERVING.has(exp.status)) return outcome(null, "not_running");
  if (exp.status === "concluded" && !exp.concludedVariant) {
    return fail({ code: "concluded_without_variant" });
  }
  const concluded = exp.status === "concluded";

  // A concluded winner ships to its whole audience, so overrides stop applying. A unit-id
  // override matches any unit type the caller sends, not just the experiment's.
  if (!concluded) {
    const forced = resolveOverride(exp.variantOverrides, units, attributes, collect("override"));
    if (forced !== null) {
      if (hasVariant(exp, forced.variantKey)) {
        return outcome(forced.variantKey, "override", { overrideId: forced.overrideId });
      }
      warnings.push({ code: "override_unknown_variant", overrideId: forced.overrideId });
    }
  }

  if (!isEligible(exp.targeting, attributes, collect("targeting"))) {
    return outcome(null, "not_eligible");
  }

  // After targeting, so a unit outside the audience isn't held out of anything; before the
  // gate and the concluded winner, so a held-out unit gets the control either way. Exposure
  // doesn't depend on the gate, or a released arm's share would drift from its declared split.
  const arms = holdouts?.arms ?? [];
  let heldOutBy: string | undefined;
  let blockedBy: string | undefined;
  if (arms.length > 0 && (concluded || unitIdOf(units, exp.unitTypeKey) !== undefined)) {
    const control = exp.controlVariantKey;
    const suppressible = Boolean(control) && hasVariant(exp, control!);
    for (const resolved of arms) {
      if (!resolved.covers.has(exp.key)) continue;
      if (resolved.arm === "holdout" && !suppressible) {
        blockedBy ??= resolved.holdout.key;
        continue;
      }
      exposedHoldouts.push(resolved);
      if (resolved.arm === "holdout") heldOutBy ??= resolved.holdout.key;
    }
  }
  // Fail closed: allocating would hand a held-out unit the treatment.
  if (blockedBy !== undefined) {
    return fail({
      code: "holdout_control_unavailable",
      holdoutKey: blockedBy,
      control: exp.controlVariantKey ? "unknown_variant" : "absent",
    });
  }
  if (heldOutBy !== undefined) {
    return outcome(exp.controlVariantKey!, "holdout", { holdoutKey: heldOutBy });
  }

  if (concluded) return outcome(exp.concludedVariant!, "concluded");

  // Never another unit type's id: it would corrupt the experiment's sample ratio.
  const unitId = unitIdOf(units, exp.unitTypeKey);
  if (unitId === undefined) return outcome(null, "unit_missing");
  const salt = exp.salt;
  if (!salt) return fail({ code: "missing_salt" });
  if (!isInTrafficGate(salt, unitId, exp.trafficPercentage)) {
    return outcome(null, "not_in_traffic");
  }
  const allocation = variantAllocationProblem(exp.variants);
  if (allocation !== null) return fail({ code: "invalid_allocation", detail: allocation });
  return outcome(allocateVariant(salt, unitId, exp.variants), "assigned");

  function collect(code: "targeting" | "override") {
    return (meta: Record<string, unknown>, message: string) => {
      warnings.push({ code, meta, message });
    };
  }
}

function hasVariant(exp: ExperimentSpec, key: string): boolean {
  return exp.variants.some((variant) => variant.key === key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
