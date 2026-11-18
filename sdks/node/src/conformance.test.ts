import type { BootstrapV1, ChertoContext } from "@cherto/core";
import { describe, it, expect } from "vitest";
import { evaluationCases, expectationsFor } from "@cherto/eval-core/conformance";
import { ChertoClient } from "./client.js";

/** The wire form behind a context's opaque bootstrap. */
function wireOf(ctx: ChertoContext): BootstrapV1 {
  return ctx.getBootstrap() as BootstrapV1;
}

// The SDK fails closed: an experiment it can't evaluate as written serves the caller's default.
describe("shared evaluation cases", () => {
  for (const testCase of evaluationCases) {
    it(testCase.name, async () => {
      const expected = expectationsFor(testCase, true);
      const client = await ChertoClient.init({
        serverKey: "",
        offline: true,
        initialConfig: {
          version: 1,
          configHash: "hash",
          experiments: testCase.experiments.map((exp) => ({
            startedAt: "2026-03-01T00:00:00.000Z",
            ...exp,
          })),
          ...(testCase.holdouts && {
            holdouts: testCase.holdouts.map((holdout) => ({
              startedAt: "2026-02-01T00:00:00.000Z",
              ...holdout,
            })),
          }),
        },
        logger: { warn: () => {}, error: () => {} },
      });
      const ctx = client.context({ units: testCase.units, attributes: testCase.attributes });
      const bootstrap = wireOf(ctx);
      const untracked = new Set(
        bootstrap.experiments.filter((e) => e.trackEnrollment === false).map((e) => e.key),
      );

      const experiments = Object.fromEntries(
        testCase.experiments.map(({ key }) => {
          const detail = ctx.getAssignmentDetail(key);
          return [
            key,
            {
              variant: detail.assignment?.variant ?? null,
              reason: detail.reason,
              ...(detail.errorCode !== undefined ? { errorCode: detail.errorCode } : {}),
              ...(untracked.has(key) ? { trackEnrollment: false } : {}),
            },
          ];
        }),
      );
      const holdouts = Object.fromEntries(
        (bootstrap.holdouts ?? []).map((h) => [
          h.key,
          { arm: h.variant, exposures: [...h.experimentKeys].sort() },
        ]),
      );

      expect(experiments).toEqual(expected.experiments);
      expect(holdouts).toEqual(expected.holdouts);
      await client.close();
    });
  }
});
