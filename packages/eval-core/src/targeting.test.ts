import { describe, it, expect, vi } from "vitest";
import { canEvaluateTargeting, isEligible, type Attributes } from "./targeting.js";
import type { TargetingClause, TargetingEnvelope, TargetingOperator } from "./types.js";

const noopWarn = () => {};

function envelope(clauses: TargetingClause[]): TargetingEnvelope {
  return { version: 1, rules: [{ segmentId: null, clauses }] };
}

function clause(
  attribute: string,
  operator: TargetingOperator,
  values: (string | number | boolean)[] = [],
): TargetingClause {
  return { attribute, operator, values };
}

function evalClause(c: TargetingClause, attrs: Attributes): boolean {
  return isEligible(envelope([c]), attrs, noopWarn);
}

describe("isEligible envelopes", () => {
  it("treats no targeting as matching everyone, without a warning", () => {
    const warn = vi.fn();
    expect(isEligible(null, undefined, warn)).toBe(true);
    expect(isEligible(undefined, { plan: "free" }, warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats empty rules as matching everyone", () => {
    expect(isEligible({ version: 1, rules: [] }, undefined, noopWarn)).toBe(true);
    expect(isEligible({ version: 1, rules: [] }, { plan: "free" }, noopWarn)).toBe(true);
  });

  it("fails open, with a warning, on an unsupported version", () => {
    const warn = vi.fn();
    const future = {
      version: 999,
      rules: [{ segmentId: null, clauses: [clause("plan", "equals", ["x"])] }],
    };
    expect(isEligible(future as unknown as TargetingEnvelope, {}, warn)).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { version: 999 },
      "targeting: unsupported or malformed envelope; failing open (eligible)",
    );
  });

  it("excludes a caller with no attributes from a non-empty rule", () => {
    const env = envelope([clause("plan", "in", ["premium"])]);
    expect(isEligible(env, undefined, noopWarn)).toBe(false);
    expect(isEligible(env, {}, noopWarn)).toBe(false);
  });

  it("requires every clause in a group to match", () => {
    const env = envelope([
      clause("plan", "in", ["premium"]),
      clause("isAuthenticated", "equals", [true]),
    ]);
    expect(isEligible(env, { plan: "premium", isAuthenticated: true }, noopWarn)).toBe(true);
    expect(isEligible(env, { plan: "premium", isAuthenticated: false }, noopWarn)).toBe(false);
    expect(isEligible(env, { plan: "premium" }, noopWarn)).toBe(false);
  });

  it("matches when any group matches", () => {
    const env: TargetingEnvelope = {
      version: 1,
      rules: [
        { segmentId: null, clauses: [clause("plan", "equals", ["premium"])] },
        { segmentId: null, clauses: [clause("role", "equals", ["admin"])] },
      ],
    };
    expect(isEligible(env, { plan: "premium" }, noopWarn)).toBe(true);
    expect(isEligible(env, { role: "admin" }, noopWarn)).toBe(true);
    expect(isEligible(env, { plan: "free", role: "user" }, noopWarn)).toBe(false);
  });
});

describe("operators", () => {
  describe("equals / in", () => {
    it("match an equal value of the same type", () => {
      expect(evalClause(clause("plan", "equals", ["premium"]), { plan: "premium" })).toBe(true);
      expect(evalClause(clause("seats", "equals", [5]), { seats: 5 })).toBe(true);
      expect(evalClause(clause("flag", "equals", [true]), { flag: true })).toBe(true);
    });

    it('never match across types, so "5" doesn\'t equal 5', () => {
      expect(evalClause(clause("seats", "equals", ["5"]), { seats: 5 })).toBe(false);
      expect(evalClause(clause("seats", "equals", [5]), { seats: "5" })).toBe(false);
      expect(evalClause(clause("flag", "equals", ["true"]), { flag: true })).toBe(false);
    });

    it("`in` matches any of its values", () => {
      const c = clause("plan", "in", ["premium", "enterprise"]);
      expect(evalClause(c, { plan: "premium" })).toBe(true);
      expect(evalClause(c, { plan: "enterprise" })).toBe(true);
      expect(evalClause(c, { plan: "free" })).toBe(false);
    });
  });

  describe("notEquals / notIn", () => {
    it("match a present attribute that differs", () => {
      expect(evalClause(clause("plan", "notEquals", ["free"]), { plan: "premium" })).toBe(true);
      expect(evalClause(clause("plan", "notIn", ["free", "trial"]), { plan: "premium" })).toBe(
        true,
      );
    });

    it("don't match an equal attribute", () => {
      expect(evalClause(clause("plan", "notEquals", ["free"]), { plan: "free" })).toBe(false);
      expect(evalClause(clause("plan", "notIn", ["free", "trial"]), { plan: "trial" })).toBe(false);
    });

    it("don't match an absent attribute", () => {
      expect(evalClause(clause("plan", "notEquals", ["free"]), {})).toBe(false);
      expect(evalClause(clause("plan", "notIn", ["free"]), {})).toBe(false);
    });
  });

  describe("contains", () => {
    it("matches a substring", () => {
      expect(evalClause(clause("email", "contains", ["@acme.com"]), { email: "a@acme.com" })).toBe(
        true,
      );
      expect(evalClause(clause("email", "contains", ["@other.com"]), { email: "a@acme.com" })).toBe(
        false,
      );
    });
  });

  describe("gt / lt / gte / lte", () => {
    it("compare numbers", () => {
      expect(evalClause(clause("seats", "gt", [10]), { seats: 11 })).toBe(true);
      expect(evalClause(clause("seats", "gt", [10]), { seats: 10 })).toBe(false);
      expect(evalClause(clause("seats", "lt", [10]), { seats: 9 })).toBe(true);
      expect(evalClause(clause("seats", "lt", [10]), { seats: 10 })).toBe(false);
      expect(evalClause(clause("seats", "gte", [10]), { seats: 10 })).toBe(true);
      expect(evalClause(clause("seats", "gte", [10]), { seats: 9 })).toBe(false);
      expect(evalClause(clause("seats", "lte", [10]), { seats: 10 })).toBe(true);
      expect(evalClause(clause("seats", "lte", [10]), { seats: 11 })).toBe(false);
    });
  });

  describe("exists", () => {
    it("matches a present attribute, even a falsy one", () => {
      expect(evalClause(clause("plan", "exists"), { plan: "free" })).toBe(true);
      expect(evalClause(clause("flag", "exists"), { flag: false })).toBe(true);
      expect(evalClause(clause("seats", "exists"), { seats: 0 })).toBe(true);
    });

    it("doesn't match an absent attribute", () => {
      expect(evalClause(clause("plan", "exists"), {})).toBe(false);
    });
  });

  describe("semver", () => {
    function semver(
      operator: TargetingOperator,
      values: string[],
      appVersion: string | undefined,
    ): boolean {
      const attrs: Attributes = appVersion === undefined ? {} : { appVersion };
      return evalClause({ attribute: "appVersion", operator, values, valueKind: "semver" }, attrs);
    }

    it("orders versions by precedence, not as strings", () => {
      expect(semver("gt", ["1.9.0"], "1.10.0")).toBe(true);
      expect(semver("lt", ["1.9.0"], "1.10.0")).toBe(false);
      expect(semver("gt", ["2.0.0"], "1.10.0")).toBe(false);
      expect(semver("gte", ["1.10.0"], "1.10")).toBe(true);
      expect(semver("lte", ["1.10.0"], "1.10.0")).toBe(true);
      expect(semver("lte", ["1.9.0"], "1.10.0")).toBe(false);
    });

    it("equals and in compare by precedence, so 1.2 equals 1.2.0", () => {
      expect(semver("equals", ["1.2.0"], "1.2")).toBe(true);
      expect(semver("equals", ["1.2.0"], "1.2.1")).toBe(false);
      expect(semver("in", ["1.0.0", "2.0.0"], "2.0.0")).toBe(true);
    });

    it("notEquals and notIn match only a different version", () => {
      expect(semver("notEquals", ["1.2.3"], "2.0.0")).toBe(true);
      expect(semver("notIn", ["1.2.3", "1.3.0"], "2.0.0")).toBe(true);
      expect(semver("notEquals", ["1.2.3"], "1.2.3")).toBe(false);
      expect(semver("notIn", ["1.0.0", "2.0.0"], "2.0")).toBe(false);
    });
  });
});

describe("canEvaluateTargeting", () => {
  it("accepts an envelope of supported clauses", () => {
    expect(canEvaluateTargeting(null)).toBe(true);
    expect(canEvaluateTargeting(envelope([clause("plan", "equals", ["pro"])]))).toBe(true);
  });

  it("rejects a version or operator it doesn't know", () => {
    const newerVersion = { ...envelope([clause("plan", "equals", ["pro"])]), version: 2 };
    const newerOperator = envelope([clause("plan", "startsWith" as TargetingOperator, ["p"])]);

    expect(canEvaluateTargeting(newerVersion)).toBe(false);
    expect(canEvaluateTargeting(newerOperator)).toBe(false);
  });
});
