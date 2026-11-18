import corpus from "./fixtures/evaluation-cases.json" with { type: "json" };

/** What a reader serves for one experiment. */
export interface ExpectedEvaluation {
  /** The served variant, or `null` when the caller's default is served. */
  variant: string | null;
  reason: string;
  errorCode?: string;
  /** Present, and `false`, when the served variant must not be enrolled. */
  trackEnrollment?: false;
}

/** One resolved holdout: the unit's arm, and the experiments this read is an exposure for. */
export interface ExpectedHoldout {
  arm: "holdout" | "released";
  /** Sorted by key. */
  exposures: string[];
}

/** One config, the units and attributes of one read, and what a reader serves. */
export interface EvaluationCase {
  name: string;
  experiments: Array<{ key: string } & Record<string, unknown>>;
  holdouts?: Array<{ key: string } & Record<string, unknown>>;
  units: Record<string, string>;
  attributes?: Record<string, string | number | boolean>;
  /** By experiment key; holds under both policies unless `expectFailClosed` replaces it. */
  expect: Record<string, ExpectedEvaluation>;
  expectFailClosed?: Record<string, ExpectedEvaluation>;
  /** By holdout key, for every holdout the units resolve. Absent when none do. */
  expectHoldouts?: Record<string, ExpectedHoldout>;
  expectHoldoutsFailClosed?: Record<string, ExpectedHoldout>;
}

/** The shared evaluation cases every reader runs. Synthetic data only. */
export const evaluationCases = corpus.cases as unknown as readonly EvaluationCase[];

/** A case's expectations for a reader that fails closed or one that doesn't. */
export function expectationsFor(
  testCase: EvaluationCase,
  failClosed: boolean,
): {
  experiments: Record<string, ExpectedEvaluation>;
  holdouts: Record<string, ExpectedHoldout>;
} {
  return {
    experiments: failClosed
      ? { ...testCase.expect, ...testCase.expectFailClosed }
      : testCase.expect,
    holdouts:
      (failClosed ? testCase.expectHoldoutsFailClosed : undefined) ?? testCase.expectHoldouts ?? {},
  };
}
