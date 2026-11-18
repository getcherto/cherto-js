import {
  experimentProblem,
  holdoutCoverage,
  isServableHoldout,
  problemErrorCode,
  type ExperimentProblem,
} from "@cherto/eval-core";
import { ChertoError, isRecord, type ChertoAssignmentErrorCode, type WarnFn } from "@cherto/core";
import type { ChertoConfigSnapshot, Config, ConfigExperiment, ConfigHoldout } from "./types.js";

/**
 * Check a fetched config's shape. A body with no experiments list, or with a holdouts field
 * that isn't a list, throws `bad_response`. Malformed entries, experiments this build can't
 * evaluate or allocate, and the experiments a malformed holdout covers (all of them when its
 * coverage can't be read) are dropped with a warning, once, so they fail closed. Evaluation
 * applies the same checks again.
 */
export function parseConfig(body: unknown, warn: WarnFn): Config {
  if (!isRecord(body) || !Array.isArray(body.experiments)) {
    throw new ChertoError(
      "bad_response",
      "[cherto] config fetch returned a body with no experiments list",
    );
  }
  if (body.holdouts != null && !Array.isArray(body.holdouts)) {
    throw new ChertoError(
      "bad_response",
      "[cherto] config fetch returned a malformed holdouts list",
    );
  }

  const holdouts: ConfigHoldout[] = [];
  // Experiments covered by a malformed holdout; `null` when that could be any of them.
  let unservable: Set<string> | null = new Set();
  (body.holdouts ?? []).forEach((entry: unknown, index) => {
    if (isHoldout(entry)) {
      holdouts.push(entry);
      return;
    }
    const meta = { index, ...keyOf(entry, "holdoutKey") };
    const coverage = holdoutCoverage(entry);
    if (coverage !== "all") {
      for (const key of coverage) unservable?.add(key);
      warn(meta, "dropping a malformed holdout and skipping the experiments it covers");
    } else {
      unservable = null;
      warn(
        meta,
        "dropping a malformed holdout that could cover any experiment, so skipping them all",
      );
    }
  });

  const experiments: ConfigExperiment[] = [];
  const skipped = new Map<string, ChertoAssignmentErrorCode>();
  body.experiments.forEach((entry: unknown, index) => {
    if (!isExperiment(entry)) {
      const key = keyOf(entry, "experimentKey");
      if (key.experimentKey) skipped.set(key.experimentKey, "invalid_experiment");
      warn({ index, ...key }, "dropping a malformed experiment");
    } else if (unservable === null || unservable.has(entry.key)) {
      skipped.set(entry.key, "invalid_experiment");
    } else {
      const problem = experimentProblem(entry);
      if (problem === null) {
        experiments.push(entry);
      } else {
        const { message, meta } = describe(problem);
        skipped.set(entry.key, problemErrorCode(problem));
        warn({ experimentKey: entry.key, ...meta }, `${message}, skipping it`);
      }
    }
  });

  const config: Config = {
    version: typeof body.version === "number" && Number.isFinite(body.version) ? body.version : 0,
    configHash: typeof body.configHash === "string" ? body.configHash : "",
    experiments,
  };
  if (skipped.size > 0) config.skipped = skipped;
  if (Array.isArray(body.holdouts)) config.holdouts = holdouts;
  sources.set(config, body as unknown as ChertoConfigSnapshot);
  return config;
}

const sources = new WeakMap<Config, ChertoConfigSnapshot>();

/** The body `config` was parsed from, dropped entries included. */
export function sourceOf(config: Config): ChertoConfigSnapshot | undefined {
  return sources.get(config);
}

const indexes = new WeakMap<Config, ReadonlyMap<string, ConfigExperiment>>();

/** `config`'s experiments by key, built once per config. */
export function experimentsByKey(config: Config): ReadonlyMap<string, ConfigExperiment> {
  let index = indexes.get(config);
  if (index === undefined) {
    index = new Map(config.experiments.map((exp) => [exp.key, exp]));
    indexes.set(config, index);
  }
  return index;
}

function describe(problem: ExperimentProblem): {
  message: string;
  meta?: Record<string, unknown>;
} {
  switch (problem.code) {
    case "unsupported_status":
      return {
        message: "experiment has a status this SDK version doesn't support",
        meta: { status: problem.status },
      };
    case "unsupported_targeting":
      return { message: "experiment's targeting uses rules this SDK version can't evaluate" };
    case "unsupported_override":
      return {
        message: "experiment has a variant override this SDK version can't evaluate",
        meta: { overrideId: problem.overrideId },
      };
    case "concluded_without_variant":
      return { message: "concluded experiment names no winning variant" };
    case "missing_salt":
      return { message: "experiment has no bucketing salt" };
    case "invalid_allocation":
      return { message: problem.detail };
  }
}

function keyOf(entry: unknown, field: string): Record<string, string> {
  return isRecord(entry) && typeof entry.key === "string" ? { [field]: entry.key } : {};
}

function isExperiment(entry: unknown): entry is ConfigExperiment {
  return (
    isRecord(entry) &&
    typeof entry.key === "string" &&
    entry.key !== "" &&
    typeof entry.status === "string" &&
    Array.isArray(entry.variants)
  );
}

function isHoldout(entry: unknown): entry is ConfigHoldout {
  return isServableHoldout(entry);
}
