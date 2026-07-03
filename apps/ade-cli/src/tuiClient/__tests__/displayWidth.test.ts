import { describe, expect, it } from "vitest";
import { splitByDisplayCells, terminalDisplayWidth, truncateDisplayEnd } from "../displayWidth";

describe("splitByDisplayCells", () => {
  it("assigns a wide cluster that crosses a split boundary to one segment", () => {
    expect(splitByDisplayCells("ab界cd", 2, 3)).toEqual({
      before: "ab",
      selected: "界",
      after: "cd",
    });
  });
});

describe("truncateDisplayEnd", () => {
  it("never exceeds maxCells when a wide grapheme straddles the ellipsis boundary", () => {
    const truncated = truncateDisplayEnd("界面设置", 2);
    expect(terminalDisplayWidth(truncated)).toBeLessThanOrEqual(2);
    expect(truncated).toBe("…");
  });

  it("keeps whole wide clusters that fit before the ellipsis", () => {
    const truncated = truncateDisplayEnd("界面设置", 5);
    expect(truncated).toBe("界面…");
    expect(terminalDisplayWidth(truncated)).toBe(5);
  });

  it("leaves narrow text untouched below the budget and truncates above it", () => {
    expect(truncateDisplayEnd("abc", 4)).toBe("abc");
    expect(truncateDisplayEnd("abcdef", 4)).toBe("abc…");
    expect(truncateDisplayEnd("ab", 1)).toBe("a");
  });
});
