import type {
  AttributeValue,
  TargetingClause,
  TargetingEnvelope,
  TargetingOperator,
  TargetingValueKind,
} from "./types.js";
import { compareSemver, parseSemver } from "./semver.js";

/** Caller-supplied attributes evaluated against targeting rules. Scalar values only. */
export type Attributes = Record<string, AttributeValue>;

/** Receives evaluation warnings. `obj` never holds an attribute value. */
export type TargetingWarn = (obj: Record<string, unknown>, msg: string) => void;

const SUPPORTED_VERSION = 1;

const KNOWN_OPERATORS: Record<TargetingOperator, true> = {
  equals: true,
  notEquals: true,
  in: true,
  notIn: true,
  contains: true,
  gt: true,
  lt: true,
  gte: true,
  lte: true,
  exists: true,
};

const KNOWN_VALUE_KINDS: Record<TargetingValueKind, true> = { semver: true };

/**
 * Whether this build can evaluate `targeting` as written: a supported version, no saved
 * segment, and only known operators and `valueKind`s. A reader that can lag the writer calls
 * this first and skips the experiment when it returns `false`.
 */
export function canEvaluateTargeting(targeting: unknown): boolean {
  if (targeting == null) return true;
  if (typeof targeting !== "object") return false;
  const { version, rules } = targeting as Partial<TargetingEnvelope>;
  if (version !== SUPPORTED_VERSION || !Array.isArray(rules)) return false;
  return rules.every(
    (group) =>
      typeof group === "object" &&
      group !== null &&
      group.segmentId == null &&
      Array.isArray(group.clauses) &&
      group.clauses.every(isEvaluableClause),
  );
}

function isEvaluableClause(clause: unknown): boolean {
  if (typeof clause !== "object" || clause === null) return false;
  const { attribute, operator, values, valueKind } = clause as Partial<TargetingClause>;
  return (
    typeof attribute === "string" &&
    typeof operator === "string" &&
    Object.hasOwn(KNOWN_OPERATORS, operator) &&
    (valueKind == null || Object.hasOwn(KNOWN_VALUE_KINDS, valueKind)) &&
    (Array.isArray(values) || operator === "exists")
  );
}

/**
 * Whether a unit's attributes pass `targeting`. No targeting matches everyone. An unsupported
 * or malformed envelope fails open with a warning; an unknown operator fails its clause
 * closed. Attribute values can be PII, so no warning includes one.
 */
export function isEligible(
  targeting: TargetingEnvelope | null | undefined,
  attributes: Attributes | undefined,
  warn: TargetingWarn,
): boolean {
  if (targeting == null) return true;

  if (
    typeof targeting !== "object" ||
    targeting.version !== SUPPORTED_VERSION ||
    !Array.isArray(targeting.rules)
  ) {
    warn(
      { version: (targeting as { version?: unknown }).version },
      "targeting: unsupported or malformed envelope; failing open (eligible)",
    );
    return true;
  }

  // Empty rules match everyone, so clearing the last rule never zeroes traffic.
  if (targeting.rules.length === 0) return true;

  const attrs: Attributes = attributes ?? {};
  return targeting.rules.some(
    (group) =>
      Array.isArray(group?.clauses) &&
      group.clauses.every((clause) => evaluateClause(clause, attrs)),
  );
}

function evaluateClause(clause: TargetingClause, attrs: Attributes): boolean {
  const { attribute, operator } = clause;
  const present = Object.prototype.hasOwnProperty.call(attrs, attribute);

  // Every operator but `exists` is false for an absent attribute, `notEquals` included.
  if (operator === "exists") return present;
  if (!present) return false;

  const actual = attrs[attribute];
  const values = Array.isArray(clause.values) ? clause.values : [];

  if (clause.valueKind === "semver") return evaluateSemverClause(operator, actual, values);

  switch (operator) {
    case "equals":
    case "in":
      return values.some((v) => v === actual);
    case "notEquals":
    case "notIn":
      return !values.some((v) => v === actual);
    case "contains":
      // Substring, not set membership.
      return (
        typeof actual === "string" &&
        values.some((v) => typeof v === "string" && actual.includes(v))
      );
    case "gt":
      return typeof actual === "number" && typeof values[0] === "number" && actual > values[0];
    case "lt":
      return typeof actual === "number" && typeof values[0] === "number" && actual < values[0];
    case "gte":
      return typeof actual === "number" && typeof values[0] === "number" && actual >= values[0];
    case "lte":
      return typeof actual === "number" && typeof values[0] === "number" && actual <= values[0];
    default: {
      // A new operator fails to compile until it is handled here.
      const _exhaustive: never = operator;
      void _exhaustive;
      return false;
    }
  }
}

// Fails closed on an unparseable version. `contains` matches nothing.
function evaluateSemverClause(
  operator: TargetingOperator,
  actual: AttributeValue,
  values: AttributeValue[],
): boolean {
  switch (operator) {
    case "equals":
    case "in":
      return values.some((v) => compareSemver(actual, v) === 0);
    case "notEquals":
    case "notIn":
      // Any unparseable version fails closed, or the negation would match everyone.
      return (
        parseSemver(actual) !== null &&
        values.every((v) => parseSemver(v) !== null) &&
        !values.some((v) => compareSemver(actual, v) === 0)
      );
    case "gt": {
      const c = compareSemver(actual, values[0]);
      return c !== null && c > 0;
    }
    case "lt": {
      const c = compareSemver(actual, values[0]);
      return c !== null && c < 0;
    }
    case "gte": {
      const c = compareSemver(actual, values[0]);
      return c !== null && c >= 0;
    }
    case "lte": {
      const c = compareSemver(actual, values[0]);
      return c !== null && c <= 0;
    }
    default:
      return false;
  }
}
