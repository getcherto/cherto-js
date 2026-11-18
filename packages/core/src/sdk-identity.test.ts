import { describe, expect, it } from "vitest";
import { formatSdkIdentity } from "./sdk-identity.js";

describe("formatSdkIdentity", () => {
  it.each([
    [[], "browser/1.4.2"],
    [["chrome/124"], "browser/1.4.2 (chrome/124)"],
    [["react/0.1.0", "chrome/124"], "browser/1.4.2 (react/0.1.0; chrome/124)"],
  ])("formats extras %j", (extras, expected) => {
    expect(formatSdkIdentity("browser", "1.4.2", extras)).toBe(expected);
  });
});
