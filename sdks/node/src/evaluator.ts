import {
  evaluateExperiment,
  resolveHoldouts as resolveHoldoutArms,
  type EvaluationPolicy,
  type ExperimentEvaluation,
  type ResolvedHoldouts,
} from "@cherto/eval-core";
import type {
  Attributes,
  ChertoAssignment,
  ChertoAssignmentErrorCode,
  ChertoAssignmentReason,
  WarnFn,
} from "@cherto/core";
import type { ConfigExperiment, ConfigHoldout } from "./types.js";

/** The SDK can lag the server, so it skips anything it can't evaluate as written. */
export const SDK_POLICY: EvaluationPolicy = { failClosed: true };

// A stable sentinel rather than "now", for configs that omit `startedAt`.
const EPOCH_STARTED_AT = "1970-01-01T00:00:00.000Z";

/** One evaluated experiment: the public decision plus internal enrollment directives. */
export interface EvaluatedExperiment {
  assignment: ChertoAssignment;
  /** `false` when the assignment must not be enrolled, as for an override. */
  trackEnrollment: boolean;
}

/** An {@link EvaluatedExperiment}, or `null`, with the reason for it. */
export interface Evaluation {
  result: EvaluatedExperiment | null;
  reason: ChertoAssignmentReason;
  errorCode?: ChertoAssignmentErrorCode;
}

/** A context's holdouts, hashed once for its units. */
export type ContextHoldouts = ResolvedHoldouts<ConfigHoldout>;

/** What evaluating one experiment for one context found, before anything is logged. */
export type Assessment = ExperimentEvaluation<ConfigHoldout>;

/** Hash each holdout into an arm for these units. One whose unit type is absent doesn't apply. */
export function resolveHoldouts(
  holdouts: ConfigHoldout[] | undefined,
  units: Record<string, string>,
): ContextHoldouts {
  return resolveHoldoutArms(holdouts, units, SDK_POLICY);
}

/**
 * Evaluate one experiment, in the same order as the hosted `/v1/initialize`. The single
 * source of truth for both the served variant and the holdout exposures it records.
 */
export function assess(
  exp: ConfigExperiment,
  units: Record<string, string>,
  attributes: Attributes | undefined,
  holdouts?: ContextHoldouts,
): Assessment {
  return evaluateExperiment(exp, { units, attributes, holdouts }, SDK_POLICY);
}

/**
 * The public decision an {@link Assessment} makes, logging what it passed over. Attributes may
 * hold PII, so `warn` only ever receives their shape.
 */
export function toEvaluation(
  exp: ConfigExperiment,
  assessment: Assessment,
  warn: WarnFn,
): Evaluation {
  for (const warning of assessment.warnings) {
    if (warning.code === "override_unknown_variant") {
      warn(
        { experimentKey: exp.key, overrideId: warning.overrideId },
        "variant override names a variant not in the config; ignoring",
      );
    } else {
      warn({ experimentKey: exp.key, ...warning.meta }, warning.message);
    }
  }
  const { variantKey, problem } = assessment;
  if (problem?.code === "holdout_control_unavailable") {
    warn(
      { experimentKey: exp.key, holdoutKey: problem.holdoutKey },
      "held-out unit has no usable control variant; omitting the experiment",
    );
  }
  if (variantKey === null) {
    return {
      result: null,
      reason: assessment.reason,
      ...(assessment.errorCode !== undefined ? { errorCode: assessment.errorCode } : {}),
    };
  }
  const customValue = exp.variants.find((v) => v.key === variantKey)?.customValue;
  return {
    result: {
      assignment: {
        variant: variantKey,
        startedAt: exp.startedAt ?? EPOCH_STARTED_AT,
        // Omitted when empty, as `/v1/initialize` omits it.
        ...(customValue != null && Object.keys(customValue).length > 0 ? { customValue } : {}),
      },
      trackEnrollment: assessment.trackEnrollment,
    },
    reason: assessment.reason,
  };
}
