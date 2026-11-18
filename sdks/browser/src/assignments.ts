import { isRecord, type BootstrapV1, type WarnFn } from "@cherto/core";
import type { ChertoAssignmentReason, UnitMap } from "@cherto/core";

/** One experiment in a `/v1/initialize` response, as the cache also stores it. */
export interface WireExperiment {
  key: string;
  variant: string;
  unitTypeKey: string;
  startedAt: string;
  value?: Record<string, unknown>;
  /** `false` when the assignment must never be enrolled, as for an override. */
  trackEnrollment?: boolean;
  reason?: string;
}

/** One holdout arm in a `/v1/initialize` response. */
export interface WireHoldout {
  key: string;
  variant: "holdout" | "released";
  unitTypeKey: string;
  startedAt: string;
  experimentKeys: string[];
}

export interface WireAssignments {
  experiments: WireExperiment[];
  holdouts?: WireHoldout[];
}

export interface AssignmentEntry {
  variant: string;
  startedAt: string;
  customValue: Record<string, unknown> | undefined;
  unitTypeKey: string;
  trackEnrollment: boolean;
  reason: ChertoAssignmentReason;
}

/** Loaded assignments, with the units they were evaluated for, which enrollment is sent for. */
export interface AssignmentSet {
  experiments: Map<string, AssignmentEntry>;
  holdouts: WireHoldout[];
  units: UnitMap;
}

const ASSIGNED_REASONS: ReadonlySet<string> = new Set<ChertoAssignmentReason>([
  "assigned",
  "concluded",
  "override",
  "holdout",
]);

/**
 * Validate a `/v1/initialize` body or a cached one. `null` when it isn't usable at all; a
 * malformed experiment or holdout is dropped with a warning.
 */
export function parseAssignments(body: unknown, warn: WarnFn): WireAssignments | null {
  if (!isRecord(body) || !Array.isArray(body.experiments)) return null;
  const experiments: WireExperiment[] = [];
  for (const entry of body.experiments as unknown[]) {
    const experiment = parseExperiment(entry);
    if (experiment) experiments.push(experiment);
    else warn({}, "dropped a malformed experiment from the assignments response");
  }
  const result: WireAssignments = { experiments };
  if (Array.isArray(body.holdouts)) {
    const holdouts: WireHoldout[] = [];
    for (const entry of body.holdouts as unknown[]) {
      const holdout = parseHoldout(entry);
      if (holdout) holdouts.push(holdout);
      else warn({}, "dropped a malformed holdout from the assignments response");
    }
    if (holdouts.length > 0) result.holdouts = holdouts;
  }
  return result;
}

function parseExperiment(value: unknown): WireExperiment | null {
  if (!isRecord(value)) return null;
  const { key, variant, unitTypeKey, startedAt, value: custom, trackEnrollment, reason } = value;
  if (!isNonEmptyString(key) || !isNonEmptyString(variant) || !isNonEmptyString(unitTypeKey)) {
    return null;
  }
  if (typeof startedAt !== "string") return null;
  if (custom !== undefined && custom !== null && !isRecord(custom)) return null;
  if (trackEnrollment !== undefined && typeof trackEnrollment !== "boolean") return null;
  return {
    key,
    variant,
    unitTypeKey,
    startedAt,
    ...(isRecord(custom) && Object.keys(custom).length > 0 ? { value: custom } : {}),
    ...(trackEnrollment === false ? { trackEnrollment } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

function parseHoldout(value: unknown): WireHoldout | null {
  if (!isRecord(value)) return null;
  const { key, variant, unitTypeKey, startedAt, experimentKeys } = value;
  if (!isNonEmptyString(key) || !isNonEmptyString(unitTypeKey)) return null;
  if (variant !== "holdout" && variant !== "released") return null;
  if (typeof startedAt !== "string") return null;
  if (!Array.isArray(experimentKeys) || !experimentKeys.every(isNonEmptyString)) return null;
  return { key, variant, unitTypeKey, startedAt, experimentKeys: [...experimentKeys] };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function reasonOf(reason: string | undefined): ChertoAssignmentReason {
  return reason !== undefined && ASSIGNED_REASONS.has(reason)
    ? (reason as ChertoAssignmentReason)
    : "assigned";
}

export function setFromWire(wire: WireAssignments, units: UnitMap): AssignmentSet {
  const experiments = new Map<string, AssignmentEntry>();
  for (const exp of wire.experiments) {
    experiments.set(exp.key, {
      variant: exp.variant,
      startedAt: exp.startedAt,
      customValue: exp.value,
      unitTypeKey: exp.unitTypeKey,
      trackEnrollment: exp.trackEnrollment !== false,
      reason: reasonOf(exp.reason),
    });
  }
  return { experiments, holdouts: wire.holdouts ?? [], units };
}

export function setFromBootstrap(bootstrap: BootstrapV1): AssignmentSet {
  const experiments = new Map<string, AssignmentEntry>();
  for (const exp of bootstrap.experiments) {
    experiments.set(exp.key, {
      variant: exp.assignment.variant,
      startedAt: exp.assignment.startedAt,
      customValue: exp.assignment.customValue,
      unitTypeKey: exp.unitTypeKey,
      trackEnrollment: exp.trackEnrollment !== false,
      reason: reasonOf(exp.reason),
    });
  }
  return { experiments, holdouts: bootstrap.holdouts ?? [], units: bootstrap.units };
}

/** What reads of a set could tell apart. */
export function fingerprint(set: AssignmentSet | null): string {
  if (set === null) return "";
  const entries = [...set.experiments]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, e]) => [key, e.variant, e.startedAt, e.reason, e.customValue ?? null]);
  return JSON.stringify(entries);
}
