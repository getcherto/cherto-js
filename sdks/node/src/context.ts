import {
  copyJson,
  createBootstrap,
  generateUuid,
  ifTypeMatches,
  normalizeContext,
  paramOf,
} from "@cherto/core";
import type {
  Attributes,
  BootstrapExperiment,
  ChertoAssignment,
  ChertoAssignmentDetail,
  ChertoAssignmentErrorCode,
  ChertoBootstrap,
  ChertoContext,
  ChertoEnrollmentEvent,
  ChertoReadOptions,
  UnitMap,
  WarnFn,
} from "@cherto/core";
import {
  assess,
  resolveHoldouts,
  toEvaluation,
  type Assessment,
  type ContextHoldouts,
  type EvaluatedExperiment,
  type Evaluation,
} from "./evaluator.js";
import { experimentsByKey } from "./config.js";
import { enrollmentDedupeKey } from "./event-buffer.js";
import type { Config, ConfigExperiment } from "./types.js";

/** Where a context sends the enrollment events it records. */
export interface EnrollmentSink {
  track(event: ChertoEnrollmentEvent, dedupeKey: string): Promise<void>;
  /** Whether `track` sends events anywhere now: not in `"none"` mode, nor once closed. */
  sends(): boolean;
}

export interface NodeChertoContextOptions {
  /** The caller's `ChertoContextInput`, unchecked. */
  input: unknown;
  /** `null` while the client has no config yet. */
  config: Config | null;
  tracker: EnrollmentSink;
  warn: WarnFn;
}

/**
 * A {@link ChertoContext} bound to one config snapshot, which must come from `parseConfig`.
 * Assignments are evaluated lazily and cached per key. No accessor throws: a failed
 * evaluation serves the caller's default.
 */
export class NodeChertoContext implements ChertoContext {
  private readonly units: UnitMap;
  private readonly attributes: Attributes | undefined;
  private readonly tracker: EnrollmentSink;
  private readonly warn: WarnFn;
  private readonly experimentsByKey: ReadonlyMap<string, ConfigExperiment>;
  private readonly hasConfig: boolean;
  private readonly skipped: ReadonlyMap<string, ChertoAssignmentErrorCode> | undefined;
  private readonly cache = new Map<string, Evaluation>();
  private readonly enrolledKeys = new Set<string>();
  private readonly holdouts: ContextHoldouts;
  // One enrollment per holdout, however many of its experiments are read.
  private readonly enrolledHoldouts = new Set<string>();
  // The enrollments actually sent, which alone the bootstrap marks as enrolled.
  private readonly sentKeys = new Set<string>();
  private readonly sentHoldouts = new Set<string>();
  // `null` when assessing threw. Holds the holdout exposures alongside, so the served variant
  // and the recorded exposure never disagree.
  private readonly assessments = new Map<
    string,
    { assessment: Assessment | null; exposedTo: string[] }
  >();

  constructor(opts: NodeChertoContextOptions) {
    this.tracker = opts.tracker;
    this.warn = opts.warn;
    const { units, attributes } = normalizeContext(opts.input, this.warn);
    this.units = units;
    this.attributes = attributes;
    this.hasConfig = opts.config !== null;
    this.experimentsByKey = opts.config ? experimentsByKey(opts.config) : new Map();
    this.skipped = opts.config?.skipped;
    this.holdouts = resolveHoldouts(opts.config?.holdouts, this.units);
  }

  getVariant(key: string, defaultValue: string, opts?: ChertoReadOptions): string {
    const evaluated = this.resolve(key);
    this.maybeEnroll(key, evaluated, opts);
    return evaluated?.assignment.variant ?? defaultValue;
  }

  getVariantValue<T = Record<string, unknown>>(
    key: string,
    defaultValue: T,
    opts?: ChertoReadOptions,
  ): T {
    const evaluated = this.resolve(key);
    this.maybeEnroll(key, evaluated, opts);
    const customValue = evaluated?.assignment.customValue;
    if (customValue === undefined) return defaultValue;
    return ifTypeMatches(
      key,
      "the variant's value",
      copyJson(customValue),
      defaultValue,
      this.warn,
    );
  }

  getVariantParam<T = unknown>(
    key: string,
    paramKey: string,
    defaultValue: T,
    opts?: ChertoReadOptions,
  ): T {
    const evaluated = this.resolve(key);
    this.maybeEnroll(key, evaluated, opts);
    const value = paramOf(evaluated?.assignment.customValue, paramKey);
    if (value === undefined) return defaultValue;
    return ifTypeMatches(key, `param "${paramKey}"`, copyJson(value), defaultValue, this.warn);
  }

  getAssignment(key: string): ChertoAssignment | null {
    return this.assignmentOf(key);
  }

  getAssignmentDetail(key: string): ChertoAssignmentDetail {
    const { result, reason, errorCode } = this.evaluation(key);
    return {
      assignment: result === null ? null : copyAssignment(result.assignment),
      reason,
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }

  getAllAssignments(): Record<string, ChertoAssignment> {
    const result: Record<string, ChertoAssignment> = {};
    for (const key of this.experimentsByKey.keys()) {
      const assignment = this.assignmentOf(key);
      if (assignment !== null) result[key] = assignment;
    }
    return result;
  }

  async trackEnrollment(key: string): Promise<void> {
    const evaluated = this.resolve(key);
    // Holdout exposure counts even when the experiment itself didn't resolve.
    const pending = this.maybeEnrollHoldouts(key);
    if (evaluated !== null) pending.push(this.enroll(key, evaluated));
    await Promise.all(pending);
  }

  // Mirrors what `enroll` and `maybeEnrollHoldouts` send, minus this context's dedupe.
  getEnrollmentPayloads(key: string): ChertoEnrollmentEvent[] {
    const events: ChertoEnrollmentEvent[] = [];
    const evaluated = this.resolve(key);
    const unitId = this.unitIdFor(key);
    // The only guard keeping a suppressed (e.g. overridden) unit out of a self-published log.
    if (evaluated?.trackEnrollment && unitId !== undefined) {
      const { variant, startedAt } = evaluated.assignment;
      events.push(enrollmentEvent(key, variant, unitId, startedAt));
    }
    const exp = this.experimentsByKey.get(key);
    if (exp === undefined) return events;
    const exposedTo = this.exposedHoldoutsFor(exp);
    for (const { holdout, arm } of this.holdouts.arms) {
      if (!exposedTo.includes(holdout.key)) continue;
      const holdoutUnitId = this.units[holdout.unitTypeKey];
      if (holdoutUnitId === undefined) continue;
      events.push(enrollmentEvent(holdout.key, arm, holdoutUnitId, holdout.startedAt));
    }
    return events;
  }

  getBootstrap(): ChertoBootstrap {
    const experiments: BootstrapExperiment[] = [];
    for (const exp of this.experimentsByKey.values()) {
      const { result, reason } = this.evaluation(exp.key);
      if (result === null) continue;
      const unitId = this.unitIdFor(exp.key);
      experiments.push({
        key: exp.key,
        unitTypeKey: exp.unitTypeKey,
        ...(unitId !== undefined ? { unitId } : {}),
        assignment: result.assignment,
        ...(reason !== "assigned" ? { reason } : {}),
        ...(result.trackEnrollment ? {} : { trackEnrollment: false as const }),
      });
    }
    // The keys this unit is exposed to, not the config's, so the handoff matches a direct read.
    const exposedByHoldout = new Map<string, string[]>();
    for (const exp of this.experimentsByKey.values()) {
      for (const key of this.exposedHoldoutsFor(exp)) {
        const keys = exposedByHoldout.get(key);
        if (keys) keys.push(exp.key);
        else exposedByHoldout.set(key, [exp.key]);
      }
    }
    return createBootstrap({
      units: this.units,
      ...(this.attributes !== undefined ? { attributes: this.attributes } : {}),
      experiments,
      holdouts: this.holdouts.arms.map(({ holdout, arm }) => ({
        key: holdout.key,
        variant: arm,
        unitTypeKey: holdout.unitTypeKey,
        startedAt: holdout.startedAt,
        experimentKeys: exposedByHoldout.get(holdout.key) ?? [],
      })),
      enrolled: this.sentKeys,
      enrolledHoldouts: this.sentHoldouts,
    });
  }

  /** Memoized {@link assess}. Logs nothing but a failure: {@link toEvaluation} reports the rest. */
  private assessmentOf(exp: ConfigExperiment): {
    assessment: Assessment | null;
    exposedTo: string[];
  } {
    let entry = this.assessments.get(exp.key);
    if (entry === undefined) {
      entry = { assessment: null, exposedTo: [] };
      try {
        entry.assessment = assess(exp, this.units, this.attributes, this.holdouts);
        entry.exposedTo = entry.assessment.exposedHoldouts.map(({ holdout }) => holdout.key);
      } catch (err) {
        this.warnFailed(exp.key, err);
      }
      this.assessments.set(exp.key, entry);
    }
    return entry;
  }

  /** The holdouts reading `exp` exposes this unit to. */
  private exposedHoldoutsFor(exp: ConfigExperiment): string[] {
    return this.assessmentOf(exp).exposedTo;
  }

  private resolve(key: string): EvaluatedExperiment | null {
    return this.evaluation(key).result;
  }

  private evaluation(key: string): Evaluation {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const exp = this.experimentsByKey.get(key);
    let evaluation: Evaluation;
    if (exp === undefined) {
      const errorCode = this.skipped?.get(key);
      if (errorCode !== undefined) evaluation = { result: null, reason: "error", errorCode };
      else
        evaluation = { result: null, reason: this.hasConfig ? "unknown_experiment" : "not_ready" };
    } else {
      const { assessment } = this.assessmentOf(exp);
      evaluation = { result: null, reason: "error", errorCode: "evaluation_failed" };
      if (assessment !== null) {
        try {
          evaluation = toEvaluation(exp, assessment, this.warn);
        } catch (err) {
          this.warnFailed(key, err);
        }
      }
    }
    this.cache.set(key, evaluation);
    return evaluation;
  }

  private warnFailed(experimentKey: string, err: unknown): void {
    this.warn(
      { experimentKey, error: err instanceof Error ? err.message : String(err) },
      "experiment could not be evaluated, serving the default",
    );
  }

  private assignmentOf(key: string): ChertoAssignment | null {
    const evaluated = this.resolve(key);
    return evaluated === null ? null : copyAssignment(evaluated.assignment);
  }

  private unitIdFor(key: string): string | undefined {
    const unitTypeKey = this.experimentsByKey.get(key)?.unitTypeKey;
    return unitTypeKey !== undefined ? this.units[unitTypeKey] : undefined;
  }

  /** Enroll the assignment and its holdout exposures, unless the read opted out. */
  private maybeEnroll(
    key: string,
    evaluated: EvaluatedExperiment | null,
    opts: ChertoReadOptions | undefined,
  ): void {
    const track = opts?.track ?? true;
    // Not gated on `evaluated`: a unit outside the traffic gate is still exposed to a holdout.
    if (track) this.maybeEnrollHoldouts(key);
    if (evaluated === null) return;
    if (track) void this.enroll(key, evaluated);
  }

  /** Enroll the unit in each holdout reading `key` exposes it to, once per holdout per context. */
  private maybeEnrollHoldouts(key: string): Array<Promise<void>> {
    const pending: Array<Promise<void>> = [];
    if (this.holdouts.arms.length === 0) return pending;
    const exp = this.experimentsByKey.get(key);
    if (exp === undefined) return pending;
    const exposedTo = this.exposedHoldoutsFor(exp);
    for (const { holdout, arm } of this.holdouts.arms) {
      if (!exposedTo.includes(holdout.key)) continue;
      const unitId = this.units[holdout.unitTypeKey];
      if (unitId === undefined) continue;

      if (!this.enrolledHoldouts.has(holdout.key)) {
        this.enrolledHoldouts.add(holdout.key);
        if (this.tracker.sends()) this.sentHoldouts.add(holdout.key);
        const tracked = this.tracker.track(
          enrollmentEvent(holdout.key, arm, unitId, holdout.startedAt),
          enrollmentDedupeKey({
            experimentKey: holdout.key,
            variantKey: arm,
            unitTypeKey: holdout.unitTypeKey,
            unitId,
            startedAt: holdout.startedAt,
          }),
        );
        pending.push(tracked);
      }
    }
    return pending;
  }

  /**
   * Enroll once per context. Skipped without a unit id (a concluded experiment serves units
   * it can't attribute) or when the evaluation says not to track, as for an override.
   */
  private enroll(key: string, evaluated: EvaluatedExperiment): Promise<void> {
    if (this.enrolledKeys.has(key)) return Promise.resolve();
    if (!evaluated.trackEnrollment) return Promise.resolve();
    const unitTypeKey = this.experimentsByKey.get(key)?.unitTypeKey;
    const unitId = unitTypeKey !== undefined ? this.units[unitTypeKey] : undefined;
    if (unitTypeKey === undefined || unitId === undefined) return Promise.resolve();
    this.enrolledKeys.add(key);
    if (this.tracker.sends()) this.sentKeys.add(key);
    const { assignment } = evaluated;
    return this.tracker.track(
      enrollmentEvent(key, assignment.variant, unitId, assignment.startedAt),
      enrollmentDedupeKey({
        experimentKey: key,
        variantKey: assignment.variant,
        unitTypeKey,
        unitId,
        startedAt: assignment.startedAt,
      }),
    );
  }
}

function enrollmentEvent(
  experimentKey: string,
  variantKey: string,
  unitId: string,
  startedAt: string,
): ChertoEnrollmentEvent {
  return {
    eventId: generateUuid(),
    experimentKey,
    variantKey,
    unitId,
    startedAt,
    occurredAt: new Date().toISOString(),
  };
}

/** A copy for the caller: the cached evaluation shares its custom value with the config. */
function copyAssignment(assignment: ChertoAssignment): ChertoAssignment {
  const { customValue } = assignment;
  return customValue === undefined
    ? { ...assignment }
    : { ...assignment, customValue: copyJson(customValue) };
}
