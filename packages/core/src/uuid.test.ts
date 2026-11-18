import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUuid } from "./uuid.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("generateUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("produces a well-formed UUIDv4", () => {
    expect(generateUuid()).toMatch(UUID_V4_PATTERN);
  });

  it("produces distinct values across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateUuid()));
    expect(ids.size).toBe(50);
  });
});
