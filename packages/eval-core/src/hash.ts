import { createHash } from "node:crypto";

export interface Variant {
  key: string;
  allocationPercentage: number;
}

// Bucketing is a bit-exact contract that every language port must reproduce:
//   bucket = uint64 big-endian of sha256(utf8(`${salt}:${unitId}:${domain}`))[0..8] % 100_000
//   cutoff = round(percentage * 1000), never floor; a unit is in when bucket < cutoff.
// Variants are walked sorted by key in UTF-16 code-unit order, with cumulative allocations
// summed in integer hundredths of a percent, which must total 10_000. The salt is the only
// per-experiment input; the domain keeps the gate, allocation and holdout independent.

const BUCKET_COUNT = 100_000;
const TOTAL_HUNDREDTHS = 10_000;

const hundredthsOf = (percentage: number): number => Math.round(percentage * 100);

/** Separates the traffic gate, variant allocation and holdout hashes for one unit. */
export type HashDomain = "include" | "variant" | "holdout";

function computeBucket(salt: string, unitId: string, domain: HashDomain): number {
  const input = `${salt}:${unitId}:${domain}`;
  const digest = createHash("sha256").update(input, "utf8").digest();
  // BigInt, since a Number can't hold every uint64 exactly.
  const h64 =
    (BigInt(digest[0]) << 56n) |
    (BigInt(digest[1]) << 48n) |
    (BigInt(digest[2]) << 40n) |
    (BigInt(digest[3]) << 32n) |
    (BigInt(digest[4]) << 24n) |
    (BigInt(digest[5]) << 16n) |
    (BigInt(digest[6]) << 8n) |
    BigInt(digest[7]);
  return Number(h64 % BigInt(BUCKET_COUNT));
}

/** Whether a unit is inside an experiment's traffic gate. */
export function isInTrafficGate(salt: string, unitId: string, percentage: number): boolean {
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;
  const bucket = computeBucket(salt, unitId, "include");
  // round, not floor: float error can land just under the integer (2.01 * 1000 = 2009.999…).
  const cutoff = Math.round(percentage * 1000);
  return bucket < cutoff;
}

const UNSUMMED = "experiment's variant allocations don't sum to 100";

/**
 * Why {@link allocateVariant} can't allocate across `variants`, or `null` when it can. For
 * untrusted input: checks every variant's shape, and never throws.
 */
export function variantAllocationProblem(variants: unknown): string | null {
  if (!Array.isArray(variants) || variants.length === 0) return "experiment has no variants";
  const keys = new Set<string>();
  let hundredths = 0;
  for (const variant of variants as Array<Partial<Variant> | null>) {
    const percentage = variant?.allocationPercentage;
    if (
      typeof variant?.key !== "string" ||
      typeof percentage !== "number" ||
      !Number.isFinite(percentage)
    ) {
      return "experiment has a malformed variant";
    }
    // Out-of-range or repeated entries can still sum to 100, but send every unit to one key.
    if (percentage < 0 || percentage > 100) {
      return "experiment has a variant allocation outside 0 to 100";
    }
    if (keys.has(variant.key)) return "experiment has two variants with the same key";
    keys.add(variant.key);
    hundredths += hundredthsOf(percentage);
  }
  return hundredths === TOTAL_HUNDREDTHS ? null : UNSUMMED;
}

/** Allocate a variant key for this unit. Throws exactly when variantAllocationProblem objects. */
export function allocateVariant(salt: string, unitId: string, variants: Variant[]): string {
  const problem = variantAllocationProblem(variants);
  if (problem === UNSUMMED) {
    const floatSum = variants.reduce((s, v) => s + v.allocationPercentage, 0);
    throw new Error(`allocateVariant: allocations sum to ${floatSum}, expected 100`);
  }
  if (problem !== null) throw new Error(`allocateVariant: ${problem}`);

  const bucket = computeBucket(salt, unitId, "variant");

  // Sorted by key, so allocation never depends on the order variants arrive in.
  const ordered = variants
    .map((v) => ({ key: v.key, hundredths: hundredthsOf(v.allocationPercentage) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // One hundredth of a percent is 10 buckets.
  let cumHundredths = 0;
  for (const entry of ordered) {
    cumHundredths += entry.hundredths;
    const cutoff = cumHundredths * 10;
    if (bucket < cutoff) {
      return entry.key;
    }
  }

  // Unreachable: the last cutoff is 100,000.
  return ordered[ordered.length - 1].key;
}

/** The two arms of a holdout. */
export type HoldoutArm = "holdout" | "released";

/**
 * Allocate a unit to a holdout arm: `holdout` for the bottom `percentage`% of buckets, else
 * `released`. Hashed on the holdout's own salt, so the arm holds across its experiments.
 */
export function allocateHoldout(salt: string, unitId: string, percentage: number): HoldoutArm {
  if (percentage >= 100) return "holdout";
  if (percentage <= 0) return "released";
  const bucket = computeBucket(salt, unitId, "holdout");
  return bucket < Math.round(percentage * 1000) ? "holdout" : "released";
}
