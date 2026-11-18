import { attributesDigest } from "./context-input.js";
import type { Attributes, ChertoAssignment, ChertoAssignmentReason, UnitMap } from "./types.js";
import { copyJson, hasOwn, isDateTime, isRecord } from "./values.js";

/** One experiment's entry in a {@link BootstrapV1}. */
export interface BootstrapExperiment {
  key: string;
  /** The unit-type key the experiment is allocated on. */
  unitTypeKey: string;
  /** The context's id for `unitTypeKey`, when it had one. */
  unitId?: string;
  assignment: ChertoAssignment;
  /** Absent means `"assigned"`. */
  reason?: ChertoAssignmentReason;
  /** `false` when the assignment must never be enrolled, as for an override. */
  trackEnrollment?: false;
}

/** One holdout's arm for the context. */
export interface BootstrapHoldout {
  key: string;
  variant: "holdout" | "released";
  unitTypeKey: string;
  startedAt: string;
  /** The covered experiments this context is exposed to. */
  experimentKeys: string[];
}

/**
 * The wire form behind the opaque public `ChertoBootstrap`. Readers ignore fields they don't
 * know, and an absent optional field means its safe default, so fields can be added without a
 * new version.
 */
export interface BootstrapV1 {
  v: 1;
  /** When the server evaluated it, as an ISO 8601 timestamp. */
  generatedAt: string;
  units: Record<string, string>;
  /** {@link attributesDigest} of the attributes it was evaluated for. */
  attributesDigest: string;
  experiments: BootstrapExperiment[];
  holdouts?: BootstrapHoldout[];
  /** Experiments the server already enrolled this unit in. */
  enrolled?: string[];
  /** Holdouts the server already enrolled this unit in. */
  enrolledHoldouts?: string[];
}

/** Build a {@link BootstrapV1}. Empty optional lists are omitted. */
export function createBootstrap(parts: {
  units: Readonly<UnitMap>;
  attributes?: Readonly<Attributes>;
  experiments: Iterable<BootstrapExperiment>;
  holdouts?: readonly BootstrapHoldout[];
  enrolled?: ReadonlySet<string>;
  enrolledHoldouts?: ReadonlySet<string>;
  now?: Date;
}): BootstrapV1 {
  const bootstrap: BootstrapV1 = {
    v: 1,
    generatedAt: (parts.now ?? new Date()).toISOString(),
    // fromEntries keeps a `__proto__` unit type an own property.
    units: Object.fromEntries(Object.entries(parts.units)),
    attributesDigest: attributesDigest(parts.attributes),
    experiments: [...parts.experiments].map((experiment) => ({
      ...experiment,
      assignment: copyJson(experiment.assignment),
    })),
  };
  if (parts.holdouts && parts.holdouts.length > 0) bootstrap.holdouts = [...parts.holdouts];
  if (parts.enrolled && parts.enrolled.size > 0) bootstrap.enrolled = [...parts.enrolled];
  if (parts.enrolledHoldouts && parts.enrolledHoldouts.size > 0) {
    bootstrap.enrolledHoldouts = [...parts.enrolledHoldouts];
  }
  return bootstrap;
}

export type BootstrapParseResult = { ok: true; value: BootstrapV1 } | { ok: false; reason: string };

/**
 * Validate a bootstrap from outside the process. Returns a normalized copy, or why it can't be
 * used; never throws. Reasons name fields, never their values.
 */
export function parseBootstrap(value: unknown): BootstrapParseResult {
  try {
    return { ok: true, value: parse(value) };
  } catch (err) {
    return { ok: false, reason: err instanceof InvalidBootstrap ? err.message : "it is malformed" };
  }
}

class InvalidBootstrap extends Error {}

function fail(reason: string): never {
  throw new InvalidBootstrap(reason);
}

function parse(value: unknown): BootstrapV1 {
  if (typeof value === "string") {
    fail("it is a string; pass the parsed object, not its JSON text");
  }
  if (!isRecord(value)) fail("it isn't an object");
  if (value.v !== 1) {
    fail(
      value.v === undefined
        ? "it has no version; create it with getBootstrap() from a current @cherto/node"
        : "its version isn't supported by this SDK version",
    );
  }
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    fail("generatedAt isn't an ISO timestamp");
  }
  const units = parseUnits(value.units);
  if (!isNonEmptyString(value.attributesDigest)) {
    fail("attributesDigest isn't a non-empty string");
  }
  if (!Array.isArray(value.experiments)) fail("experiments isn't an array");
  const experiments: BootstrapExperiment[] = [];
  const keys = new Set<string>();
  value.experiments.forEach((entry: unknown, index: number) => {
    const experiment = parseExperiment(entry, `experiments[${index}]`, units);
    if (keys.has(experiment.key)) fail(`experiments[${index}] repeats an experiment key`);
    keys.add(experiment.key);
    experiments.push(experiment);
  });
  const bootstrap: BootstrapV1 = {
    v: 1,
    generatedAt: value.generatedAt,
    units,
    attributesDigest: value.attributesDigest,
    experiments,
  };
  if (value.holdouts !== undefined) {
    if (!Array.isArray(value.holdouts)) fail("holdouts isn't an array");
    bootstrap.holdouts = value.holdouts.map((entry: unknown, index: number) =>
      parseHoldout(entry, `holdouts[${index}]`),
    );
  }
  if (value.enrolled !== undefined) bootstrap.enrolled = parseKeys(value.enrolled, "enrolled");
  if (value.enrolledHoldouts !== undefined) {
    bootstrap.enrolledHoldouts = parseKeys(value.enrolledHoldouts, "enrolledHoldouts");
  }
  return bootstrap;
}

function parseUnits(value: unknown): Record<string, string> {
  if (!isRecord(value)) fail("units isn't an object");
  const units = Object.create(null) as Record<string, string>;
  for (const [unitTypeKey, unitId] of Object.entries(value)) {
    if (!isNonEmptyString(unitId)) fail(`units.${unitTypeKey} isn't a non-empty string`);
    units[unitTypeKey] = unitId;
  }
  return units;
}

function parseExperiment(
  value: unknown,
  path: string,
  units: Record<string, string>,
): BootstrapExperiment {
  if (!isRecord(value)) fail(`${path} isn't an object`);
  const { key, unitTypeKey, unitId, assignment, reason, trackEnrollment } = value;
  if (!isNonEmptyString(key)) fail(`${path}.key isn't a non-empty string`);
  if (!isNonEmptyString(unitTypeKey)) fail(`${path}.unitTypeKey isn't a non-empty string`);
  if (unitId !== undefined) {
    if (!isNonEmptyString(unitId)) fail(`${path}.unitId isn't a non-empty string`);
    if (!hasOwn(units, unitTypeKey)) units[unitTypeKey] = unitId;
    else if (units[unitTypeKey] !== unitId) fail(`${path}.unitId disagrees with units`);
  }
  if (!isRecord(assignment)) fail(`${path}.assignment isn't an object`);
  const { variant, customValue, startedAt } = assignment;
  if (!isNonEmptyString(variant)) fail(`${path}.assignment.variant isn't a non-empty string`);
  if (!isDateTime(startedAt)) fail(`${path}.assignment.startedAt isn't an ISO timestamp`);
  if (customValue !== undefined && !isRecord(customValue)) {
    fail(`${path}.assignment.customValue isn't an object`);
  }
  if (reason !== undefined && typeof reason !== "string") fail(`${path}.reason isn't a string`);
  if (trackEnrollment !== undefined && typeof trackEnrollment !== "boolean") {
    fail(`${path}.trackEnrollment isn't a boolean`);
  }
  return {
    key,
    unitTypeKey,
    ...(unitId !== undefined ? { unitId } : {}),
    assignment: {
      variant,
      startedAt,
      ...(customValue !== undefined && Object.keys(customValue).length > 0
        ? { customValue: copyJson(customValue) }
        : {}),
    },
    ...(reason !== undefined ? { reason: reason as ChertoAssignmentReason } : {}),
    ...(trackEnrollment === false ? { trackEnrollment: false as const } : {}),
  };
}

function parseHoldout(value: unknown, path: string): BootstrapHoldout {
  if (!isRecord(value)) fail(`${path} isn't an object`);
  const { key, variant, unitTypeKey, startedAt, experimentKeys } = value;
  if (!isNonEmptyString(key)) fail(`${path}.key isn't a non-empty string`);
  if (variant !== "holdout" && variant !== "released") {
    fail(`${path}.variant isn't "holdout" or "released"`);
  }
  if (!isNonEmptyString(unitTypeKey)) fail(`${path}.unitTypeKey isn't a non-empty string`);
  if (!isDateTime(startedAt)) fail(`${path}.startedAt isn't an ISO timestamp`);
  return {
    key,
    variant,
    unitTypeKey,
    startedAt,
    experimentKeys: parseKeys(experimentKeys, `${path}.experimentKeys`),
  };
}

function parseKeys(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    fail(`${path} isn't an array of non-empty strings`);
  }
  return [...value];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
