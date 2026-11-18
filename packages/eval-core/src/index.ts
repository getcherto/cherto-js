export type {
  AttributeValue,
  TargetingOperator,
  TargetingClause,
  TargetingRuleGroup,
  TargetingEnvelope,
  TargetingValueKind,
} from "./types.js";

export { parseSemver, compareSemver } from "./semver.js";

export type { Variant, HashDomain, HoldoutArm } from "./hash.js";
export {
  isInTrafficGate,
  allocateVariant,
  allocateHoldout,
  variantAllocationProblem,
} from "./hash.js";

export type { Attributes, TargetingWarn } from "./targeting.js";
export { isEligible, canEvaluateTargeting } from "./targeting.js";

export type { VariantOverride, VariantOverrideMatch, ResolvedOverride } from "./overrides.js";
export { resolveOverride } from "./overrides.js";

export type {
  EvaluationPolicy,
  ExperimentSpec,
  HoldoutSpec,
  ResolvedHoldout,
  ResolvedHoldouts,
  HoldoutWarning,
  ExperimentProblem,
  EvaluationProblem,
  EvaluationReason,
  EvaluationErrorCode,
  EvaluationWarning,
  EvaluationInput,
  ExperimentEvaluation,
} from "./evaluate.js";
export {
  evaluateExperiment,
  resolveHoldouts,
  experimentProblem,
  problemErrorCode,
  isServableHoldout,
  holdoutCoverage,
} from "./evaluate.js";
