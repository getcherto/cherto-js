// Minimal semver for targeting: MAJOR[.MINOR[.PATCH]], an optional leading "v", a prerelease
// tag and ignored build metadata. Anything else is unparseable, and the clause fails closed.

interface ParsedVersion {
  /** [major, minor, patch], each defaulted to 0 (so "1.2" ⇒ 1.2.0). */
  main: [number, number, number];
  /** Dot-separated prerelease identifiers, or null for a release version. */
  pre: string[] | null;
}

export function parseSemver(raw: unknown): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^v/i, "");
  if (trimmed === "") return null;
  const core = trimmed.split("+", 1)[0]; // drop build metadata
  const dash = core.indexOf("-");
  const mainPart = dash === -1 ? core : core.slice(0, dash);
  const prePart = dash === -1 ? "" : core.slice(dash + 1);
  // A dash with nothing after it ("1.0.0-") is malformed, not a release.
  if (dash !== -1 && prePart === "") return null;

  const segs = mainPart.split(".");
  if (segs.length === 0 || segs.length > 3) return null;
  const nums: number[] = [];
  for (const seg of segs) {
    if (!/^\d+$/.test(seg)) return null;
    nums.push(Number(seg));
  }
  while (nums.length < 3) nums.push(0);
  const pre = prePart.length > 0 ? prePart.split(".") : null;
  if (pre && pre.some((id) => id.length === 0)) return null;
  return { main: [nums[0], nums[1], nums[2]], pre };
}

/** Compare two versions: -1, 0 or 1, or null when either is unparseable. */
export function compareSemver(a: unknown, b: unknown): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  for (let i = 0; i < 3; i++) {
    if (pa.main[i] !== pb.main[i]) return pa.main[i] < pb.main[i] ? -1 : 1;
  }

  // A prerelease ranks below its release: 1.0.0-rc < 1.0.0.
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;

  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    // A larger set of prerelease fields, all else equal, has higher precedence.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (x !== y) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn) {
      return -1; // numeric identifiers rank lower than alphanumeric
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
