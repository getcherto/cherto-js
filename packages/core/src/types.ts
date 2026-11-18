// Copies of eval-core's AttributeValue and Attributes: eval-core needs node:crypto, and this
// package also runs in browsers.

/** Scalar attribute value used for audience targeting. */
export type ChertoAttributeValue = string | number | boolean;

/** Caller-supplied attributes for audience targeting, keyed by attribute name. */
export type Attributes = Record<string, ChertoAttributeValue>;

/** Unit-type key (e.g. `"user"`) to unit id. An experiment whose unit is absent is skipped. */
export type UnitMap = Record<string, string>;

/** Which variant a unit gets in one experiment. */
export interface ChertoAssignment {
  /** The key of the assigned variant (e.g. `"control"` or `"treatment"`). */
  variant: string;
  /** Custom data attached to the variant in the dashboard; `undefined` when there is none. */
  customValue?: Record<string, unknown>;
  /**
   * ISO start of the experiment's current run. Moves on every restart. The Unix epoch when
   * Cherto has no start for it.
   */
  startedAt: string;
}

/** Records that a unit was enrolled in an experiment or a holdout. Deduplicated by `eventId`. */
export interface ChertoEnrollmentEvent {
  /** A UUID, the same on every delivery of this event. */
  eventId: string;
  /** The experiment's key, or the holdout's for a holdout enrollment. */
  experimentKey: string;
  /** The variant's key, or `"holdout"` or `"released"` for a holdout enrollment. */
  variantKey: string;
  /** The id of the enrolled unit. */
  unitId: string;
  /** The run the unit was enrolled in: the assignment's `startedAt`, or the holdout's. */
  startedAt: string;
  /** When the unit was enrolled, as an ISO 8601 timestamp. */
  occurredAt: string;
}

/**
 * How enrollment events are delivered: `"cherto"` sends them to `POST /v1/events`, `"custom"`
 * hands them to `enrollmentTracking.logger`, and `"none"` sends nothing, for enrollment
 * recorded elsewhere.
 */
export type ChertoEnrollmentTrackingMode = "none" | "cherto" | "custom";

/** Where enrollment events go. See {@link ChertoEnrollmentTrackingMode}. */
export type ChertoEnrollmentTrackingConfig =
  | { mode: "cherto" }
  | { mode: "none" }
  | {
      mode: "custom";
      /**
       * Called with each enrollment event. A returned promise is awaited by
       * `trackEnrollment()`, `flush()` and `close()`; any other return value is ignored.
       */
      logger: (event: ChertoEnrollmentEvent) => unknown;
    };

/**
 * Why `getAssignmentDetail()` returned what it did. `"assigned"`, `"concluded"`, `"override"`
 * (forced, not enrolled) and `"holdout"` (served the control, enrolled in the holdout) come
 * with an assignment, the rest with `null`. `"not_assigned"` comes from the browser SDK: the
 * loaded assignments don't include the experiment. New reasons may be added in minor versions.
 */
export type ChertoAssignmentReason =
  | "assigned"
  | "concluded"
  | "override"
  | "holdout"
  | "not_running"
  | "not_eligible"
  | "unit_missing"
  | "not_in_traffic"
  | "unknown_experiment"
  | "not_assigned"
  | "not_ready"
  | "error";

/**
 * Why an experiment couldn't be evaluated: `"unsupported"` (newer than this SDK version),
 * `"invalid_experiment"` (inconsistent configuration) or `"evaluation_failed"` (an unexpected
 * error). New codes may be added in minor versions.
 */
export type ChertoAssignmentErrorCode = "unsupported" | "invalid_experiment" | "evaluation_failed";

/** An assignment decision with the reason for it. */
export interface ChertoAssignmentDetail {
  /** The assignment, or `null` when the caller's default is served. */
  assignment: ChertoAssignment | null;
  /** Why the assignment, or the caller's default, is served. */
  reason: ChertoAssignmentReason;
  /** Present only when `reason` is `"error"`. */
  errorCode?: ChertoAssignmentErrorCode;
}

/** Options accepted by read accessors that can optionally enroll. */
export interface ChertoReadOptions {
  /** Enroll (`true`) or not (`false`) on this read, overriding the accessor's default. */
  track?: boolean | undefined;
}

/**
 * A serializable snapshot of a server context's assignments, from `ctx.getBootstrap()` in
 * `@cherto/node`, for the browser SDK's `bootstrap` option. Its contents are versioned and
 * private: pass it through unchanged. To embed it in HTML, serialize it with `JSON.stringify`
 * and escape `<`, U+2028 and U+2029 as `\u003c`, `\u2028` and `\u2029`, so a custom value
 * can't end the script tag or the line.
 */
export interface ChertoBootstrap {
  /** The format version. */
  readonly v: 1;
}

/**
 * Units and attributes bound for one request, returned by the client's `context()`.
 *
 * @sealed Members may be added in minor versions, so don't implement it yourself. For tests,
 * use a context from a client created with `offline: true` and an `initialConfig`.
 */
export interface ChertoContext {
  /** Read a variant key, enrolling by default. */
  getVariant(key: string, defaultValue: string, opts?: ChertoReadOptions): string;
  /**
   * Read a variant's custom value, enrolling by default. Returns `defaultValue` when there is
   * none, or when a string, number or boolean default doesn't match the value's type. An
   * object value isn't checked against `T`.
   */
  getVariantValue<T = Record<string, unknown>>(
    key: string,
    defaultValue: T,
    opts?: ChertoReadOptions,
  ): T;
  /**
   * Read one param of a variant's custom value, enrolling by default. Returns `defaultValue`
   * when it is absent, or when a string, number or boolean default doesn't match its type. An
   * object param isn't checked against `T`.
   */
  getVariantParam<T = unknown>(
    key: string,
    paramKey: string,
    defaultValue: T,
    opts?: ChertoReadOptions,
  ): T;
  /** Read the assignment decision without enrolling. */
  getAssignment(key: string): ChertoAssignment | null;
  /** Read every experiment's assignment decision without enrolling. */
  getAllAssignments(): Record<string, ChertoAssignment>;
  /** Read the assignment decision for `key` with the reason for it, without enrolling. */
  getAssignmentDetail(key: string): ChertoAssignmentDetail;
  /**
   * Enroll the unit in `key`, and in any holdout the read exposes it to. With `"cherto"`
   * tracking it resolves once the events are queued; call the client's `flush()` to await
   * delivery. Never rejects.
   */
  trackEnrollment(key: string): Promise<void>;
  /**
   * The events `trackEnrollment(key)` would send, for callers who record enrollment
   * themselves: the experiment's, unless the unit isn't enrolled in it (as for an override),
   * followed by one per holdout the read exposes the unit to. Empty when nothing would be
   * enrolled. Sends nothing and marks nothing sent, so deduplicate holdout events by holdout
   * key.
   */
  getEnrollmentPayloads(key: string): ChertoEnrollmentEvent[];
  /**
   * A snapshot of this context's units and every resolvable assignment, for the browser SDK's
   * `bootstrap` option. It marks as already enrolled only what this context sent, so in
   * `"none"` mode the browser records every enrollment.
   */
  getBootstrap(): ChertoBootstrap;
}
