import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  isInTrafficGate,
  allocateVariant,
  allocateHoldout,
  variantAllocationProblem,
} from "./hash.js";
import type { Variant } from "./hash.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface BucketingVector {
  description: string;
  salt: string;
  unitId: string;
  domain: "include" | "variant" | "holdout";
  input: string;
  sha256: string;
  h64: string;
  bucket: number;
  sortedVariantsWithCutoffs: { key: string; allocationPercentage: number; cutoff: number }[] | null;
  chosenVariant: string | null;
  /** Holdout-domain vectors only: the declared p% and the arm it yields. */
  holdoutPercentage?: number;
  holdoutArm?: "holdout" | "released";
  note?: string;
}

const vectors: BucketingVector[] = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures/bucketing-vectors.json"), "utf8"),
);

// Mirrors hash.ts, to check the per-stage values it doesn't export.
function rawBucket(salt: string, unitId: string, domain: "include" | "variant" | "holdout") {
  const input = `${salt}:${unitId}:${domain}`;
  const digest = createHash("sha256").update(input, "utf8").digest();
  const h64 =
    (BigInt(digest[0]) << 56n) |
    (BigInt(digest[1]) << 48n) |
    (BigInt(digest[2]) << 40n) |
    (BigInt(digest[3]) << 32n) |
    (BigInt(digest[4]) << 24n) |
    (BigInt(digest[5]) << 16n) |
    (BigInt(digest[6]) << 8n) |
    BigInt(digest[7]);
  return {
    input,
    sha256: digest.toString("hex"),
    h64: h64.toString(),
    bucket: Number(h64 % 100_000n),
  };
}

const TEST_SALT = "002a000000000000";

// The cross-language bucketing contract: every SDK must produce these values for the same
// salt, unit id and domain.
describe("bucketing conformance fixture", () => {
  for (const vec of vectors) {
    it(vec.description, () => {
      const { input, sha256, h64, bucket } = rawBucket(vec.salt, vec.unitId, vec.domain);

      expect(input).toBe(vec.input);
      expect(sha256).toBe(vec.sha256);
      expect(h64).toBe(vec.h64);
      expect(bucket).toBe(vec.bucket);

      if (vec.domain === "include") {
        expect(isInTrafficGate(vec.salt, vec.unitId, (vec.bucket + 1) / 1000)).toBe(true);
        expect(isInTrafficGate(vec.salt, vec.unitId, vec.bucket / 1000)).toBe(false);
      }

      if (vec.domain === "variant" && vec.sortedVariantsWithCutoffs && vec.chosenVariant) {
        const variants: Variant[] = vec.sortedVariantsWithCutoffs.map((v) => ({
          key: v.key,
          allocationPercentage: v.allocationPercentage,
        }));
        expect(allocateVariant(vec.salt, vec.unitId, variants)).toBe(vec.chosenVariant);
      }

      if (vec.domain === "holdout") {
        expect(vec.holdoutPercentage).toBeDefined();
        expect(allocateHoldout(vec.salt, vec.unitId, vec.holdoutPercentage!)).toBe(vec.holdoutArm);
      }
    });
  }
});

describe("allocateHoldout", () => {
  it("releases everyone at 0% and holds out everyone at 100%", () => {
    expect(allocateHoldout(TEST_SALT, "anyone", 0)).toBe("released");
    expect(allocateHoldout(TEST_SALT, "anyone", 100)).toBe("holdout");
  });
});

describe("isInTrafficGate", () => {
  it("admits everyone at 100%", () => {
    for (let i = 0; i < 100; i++) {
      expect(isInTrafficGate(TEST_SALT, `user-${i}`, 100)).toBe(true);
    }
  });

  it("admits nobody at 0%", () => {
    for (let i = 0; i < 100; i++) {
      expect(isInTrafficGate(TEST_SALT, `user-${i}`, 0)).toBe(false);
    }
  });
});

describe("allocateVariant", () => {
  const twoWaySplit: Variant[] = [
    { key: "control", allocationPercentage: 50 },
    { key: "treatment", allocationPercentage: 50 },
  ];

  const threeWaySplit: Variant[] = [
    { key: "blue", allocationPercentage: 34 },
    { key: "green", allocationPercentage: 33 },
    { key: "orange", allocationPercentage: 33 },
  ];

  it("reaches every variant of a three-way split", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(allocateVariant(TEST_SALT, `user-${i}`, threeWaySplit));
    }
    expect(seen.size).toBe(3);
  });

  it("re-buckets a unit when the salt changes", () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const salt = i.toString(16).padStart(16, "0");
      results.add(allocateVariant(salt, "user-1", twoWaySplit));
    }
    expect(results.size).toBe(2);
  });

  it("serves the only variant of a 100% split", () => {
    const single: Variant[] = [{ key: "only-one", allocationPercentage: 100 }];
    expect(allocateVariant(TEST_SALT, "any-user", single)).toBe("only-one");
  });

  it("allocates around a zero-percent variant", () => {
    const edge: Variant[] = [
      { key: "a", allocationPercentage: 0 },
      { key: "b", allocationPercentage: 100 },
    ];
    expect(allocateVariant(TEST_SALT, "user-1", edge)).toBe("b");
  });

  it.each<[string, Variant[], string]>([
    ["no variants", [], "allocateVariant: experiment has no variants"],
    [
      "allocations that don't sum to 100",
      [
        { key: "a", allocationPercentage: 50 },
        { key: "b", allocationPercentage: 30 },
      ],
      "allocateVariant: allocations sum to 80, expected 100",
    ],
    [
      "an allocation outside 0 to 100, even when they sum to 100",
      [
        { key: "a", allocationPercentage: 150 },
        { key: "b", allocationPercentage: -50 },
      ],
      "allocateVariant: experiment has a variant allocation outside 0 to 100",
    ],
    [
      "two variants with the same key",
      [
        { key: "a", allocationPercentage: 50 },
        { key: "a", allocationPercentage: 50 },
      ],
      "allocateVariant: experiment has two variants with the same key",
    ],
  ])("throws on %s", (_, variants, message) => {
    expect(() => allocateVariant(TEST_SALT, "user-1", variants)).toThrow(message);
  });

  it("allocates the same whatever order the variants are listed in", () => {
    const reversed = [...threeWaySplit].reverse();
    const shuffled = [threeWaySplit[1], threeWaySplit[2], threeWaySplit[0]];

    for (let i = 0; i < 300; i++) {
      const unit = `user-${i}`;
      const expected = allocateVariant(TEST_SALT, unit, threeWaySplit);
      expect(allocateVariant(TEST_SALT, unit, reversed)).toBe(expected);
      expect(allocateVariant(TEST_SALT, unit, shuffled)).toBe(expected);
    }
  });
});

describe("variantAllocationProblem", () => {
  it.each([
    [
      "nothing for a split that sums to 100",
      [
        { key: "a", allocationPercentage: 33.33 },
        { key: "b", allocationPercentage: 66.67 },
      ],
      null,
    ],
    ["no variants", [], "experiment has no variants"],
    [
      "allocations that don't sum to 100",
      [
        { key: "a", allocationPercentage: 30 },
        { key: "b", allocationPercentage: 50 },
      ],
      "experiment's variant allocations don't sum to 100",
    ],
    [
      "an allocation outside 0 to 100",
      [
        { key: "a", allocationPercentage: 150 },
        { key: "b", allocationPercentage: -50 },
      ],
      "experiment has a variant allocation outside 0 to 100",
    ],
    [
      "two variants with the same key",
      [
        { key: "a", allocationPercentage: 50 },
        { key: "a", allocationPercentage: 50 },
      ],
      "experiment has two variants with the same key",
    ],
  ])("reports %s", (_, variants, problem) => {
    expect(variantAllocationProblem(variants)).toBe(problem);
  });
});
