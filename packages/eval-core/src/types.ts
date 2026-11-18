// A reader can meet a version, operator or `valueKind` newer than itself. `isEligible` reads
// what it can of those (an unknown version fails open), so a reader that can lag the writer
// checks `canEvaluateTargeting` first.

/** Scalar attribute value. No nested objects or arrays. */
export type AttributeValue = string | number | boolean;

export type TargetingOperator =
  "equals" | "notEquals" | "in" | "notIn" | "contains" | "gt" | "lt" | "gte" | "lte" | "exists";

/** How a clause's operands are compared. `"semver"` orders version strings by precedence. */
export type TargetingValueKind = "semver";

export interface TargetingClause {
  attribute: string;
  operator: TargetingOperator;
  /**
   * Operands, compared type-sensitively ("1" ≠ 1). Ignored by `exists`. The ordering operators
   * take a single number, or a version string when `valueKind` is `"semver"`.
   */
  values: AttributeValue[];
  /** Absent for a plain scalar comparison. */
  valueKind?: TargetingValueKind;
}

export interface TargetingRuleGroup {
  /** Reserved for saved segments: `canEvaluateTargeting` rejects a group that sets it. */
  segmentId: string | null;
  /** Clauses ANDed together. */
  clauses: TargetingClause[];
}

export interface TargetingEnvelope {
  version: number;
  /** Groups ORed together. Empty matches everyone. */
  rules: TargetingRuleGroup[];
}
