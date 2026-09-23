import { describe, expect, it } from "vitest";
import { COLORS } from "../../lanes/laneDesignTokens";
import {
  formatCompactCount,
  getPrChecksBadge,
  getPrCiDotColor,
} from "./prVisuals";

describe("prVisuals", () => {
  // ADE-135: an approved PR whose commit nothing verified used to inherit the
  // success colour from the approval alone, which is exactly the "CI passed"
  // illusion this ticket exists to kill.
  it("never paints a not_run PR green", () => {
    expect(getPrCiDotColor({ checksStatus: "not_run" })).toBe(COLORS.textMuted);
    expect(getPrChecksBadge("not_run").color).toBe(COLORS.textMuted);
  });

  describe("formatCompactCount", () => {
    it("returns the number as a string for values under 1000", () => {
      expect(formatCompactCount(0)).toBe("0");
      expect(formatCompactCount(42)).toBe("42");
      expect(formatCompactCount(999)).toBe("999");
    });

    it("returns a compact 'k' suffix for values at or above 1000", () => {
      expect(formatCompactCount(1000)).toBe("1k");
      expect(formatCompactCount(1500)).toBe("1.5k");
      expect(formatCompactCount(2345)).toBe("2.3k");
      expect(formatCompactCount(10000)).toBe("10k");
    });
  });
});
