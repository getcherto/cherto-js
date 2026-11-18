import type { TargetingEnvelope, VariantOverride } from "@cherto/eval-core";
import type {
  ChertoAssignmentErrorCode,
  ChertoEnrollmentTrackingConfig,
  ChertoError,
  ChertoLogger,
} from "@cherto/core";

export type { ChertoContextInput, ChertoLogger } from "@cherto/core";

/** What {@link ChertoClient.getStatus} returns. */
export interface ChertoClientStatus {
  /** Whether a config is loaded. While `false`, every read serves the caller's default. */
  ready: boolean;
  /** The loaded config's version: `0` before one is loaded, or for a snapshot without one. */
  configVersion: number;
  /** When a config fetch last succeeded (an unchanged config included), or `null`. */
  lastSuccessfulFetchAt: Date | null;
  /** The latest background failure, or `null`. A later success doesn't clear it. */
  lastError: ChertoError | null;
  /** When `lastError` was reported, or `null`; compare it with `lastSuccessfulFetchAt`. */
  lastErrorAt: Date | null;
  /** `"cherto"` enrollment events dropped, undelivered or rejected since startup. */
  droppedEvents: number;
}

/**
 * The JSON body of `GET /v1/config`, saved whole, for
 * {@link ChertoClientOptions.initialConfig}. The SDK validates it when the client starts, so
 * treat its contents as opaque.
 */
export interface ChertoConfigSnapshot {
  experiments: readonly unknown[];
  holdouts?: readonly unknown[] | null;
  version?: number;
  configHash?: string;
}

/** Options for constructing a {@link ChertoClient}. */
export interface ChertoClientOptions {
  /**
   * The organization's secret server key (`sk_…`), which fetches config and sends enrollment.
   * Never expose it to browser code.
   */
  serverKey: string;
  /**
   * Base URL of the Cherto SDK API.
   * @defaultValue "https://api.getcherto.com"
   */
  apiUrl?: string | undefined;
  /**
   * How often to poll for config changes, in milliseconds. Jittered by ±10% and backed off
   * after a failure; values below 5,000 are raised to 5,000.
   * @defaultValue 30_000
   */
  pollIntervalMs?: number | undefined;
  /**
   * The longest `init()` waits for the first config, in milliseconds, retries included.
   * @defaultValue 10_000
   */
  initTimeoutMs?: number | undefined;
  /**
   * A config snapshot to serve at once: `init()` resolves without waiting for the network,
   * and the first successful fetch replaces the snapshot.
   */
  initialConfig?: ChertoConfigSnapshot | undefined;
  /**
   * What `init()` does when a retryable failure leaves it with no config after
   * `initTimeoutMs`: `"throw"` rejects with the last error, `"serveDefaults"` resolves a
   * client that serves callers' defaults until a background fetch succeeds.
   * @defaultValue "throw"
   */
  onInitFailure?: "throw" | "serveDefaults" | undefined;
  /**
   * Make no network requests, for tests and local development. The client serves
   * `initialConfig`, or callers' defaults, and `"custom"` tracking still calls your logger.
   * `serverKey` may be empty.
   * @defaultValue false
   */
  offline?: boolean | undefined;
  /**
   * Receives every message the SDK logs.
   * @defaultValue console
   */
  logger?: ChertoLogger | undefined;
  /**
   * Called with each background failure after it is logged: a failed config poll, a
   * `"serveDefaults"` init failure, a dropped enrollment batch, or a `"custom"` enrollment
   * logger that threw or rejected.
   */
  onError?: ((err: ChertoError) => void) | undefined;
  /**
   * How enrollment events are delivered. `"cherto"` sends them to Cherto with `serverKey`,
   * in batches, skipping an enrollment already recorded for the same unit, variant and run
   * in the last few minutes; `"custom"` calls `enrollmentTracking.logger`, deduplicated per
   * context; `"none"` sends nothing, for enrollment you record yourself.
   * @defaultValue `{ mode: "cherto" }`
   */
  enrollmentTracking?: ChertoEnrollmentTrackingConfig | undefined;
  /** Tuning for `"cherto"` enrollment delivery. */
  eventBuffer?:
    | {
        /**
         * The longest an event waits before its batch is sent, in milliseconds.
         * @defaultValue 2_000
         */
        flushIntervalMs?: number | undefined;
        /**
         * Events per request, capped at 5,000. A full batch is sent at once.
         * @defaultValue 5_000
         */
        maxBatchSize?: number | undefined;
        /**
         * Events held while waiting to be sent. When full, the oldest is dropped.
         * @defaultValue 10_000
         */
        maxQueueSize?: number | undefined;
        /**
         * Attempts per batch, the first send included. A rejected batch isn't retried.
         * @defaultValue 3
         */
        maxFlushAttempts?: number | undefined;
        /**
         * The longest wait before the first retry, in milliseconds, jittered down by up to half
         * and doubling per attempt. A `Retry-After` lengthens it; no wait exceeds 60 seconds.
         * @defaultValue 1_000
         */
        flushRetryBaseDelayMs?: number | undefined;
      }
    | undefined;
}

export interface ConfigVariant {
  key: string;
  allocationPercentage: number;
  customValue?: Record<string, unknown> | null;
}

export type ExperimentStatus = "draft" | "running" | "paused" | "concluded";

export interface ConfigExperiment {
  key: string;
  status: ExperimentStatus;
  trafficPercentage: number;
  /** Bucketing salt. A running experiment without one is skipped. */
  salt?: string;
  /** ISO start of the current run. Without one, assignments report the Unix epoch. */
  startedAt?: string;
  unitTypeKey: string;
  concludedVariant?: string;
  targeting?: TargetingEnvelope | null;
  variantOverrides?: VariantOverride[];
  variants: ConfigVariant[];
  /** The variant a held-out unit is served. Without one, a held-out unit gets no assignment. */
  controlVariantKey?: string | null;
}

/** A running holdout: its held-out units get the control of every experiment it covers. */
export interface ConfigHoldout {
  key: string;
  /** Frozen bucketing salt for the `:holdout` domain. */
  salt: string;
  unitTypeKey: string;
  /** The held-out share, in percent; the rest is the `released` arm. */
  percentage: number;
  startedAt: string;
  experimentKeys: string[];
}

export interface Config {
  version: number;
  configHash: string;
  experiments: ConfigExperiment[];
  /** Running holdouts. Absent when the organization has none. */
  holdouts?: ConfigHoldout[];
  /** Experiments dropped while parsing the config, and why. Absent when none were. */
  skipped?: Map<string, ChertoAssignmentErrorCode>;
}
