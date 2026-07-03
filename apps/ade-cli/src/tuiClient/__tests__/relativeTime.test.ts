import { describe, expect, it } from "vitest";
import { formatRelativePastTime } from "../relativeTime";

describe("formatRelativePastTime", () => {
  it("uses a neutral fallback for missing or invalid timestamps", () => {
    expect(formatRelativePastTime(null)).toBe("recently");
    expect(formatRelativePastTime("not-a-date")).toBe("recently");
  });
});
