import { describe, expect, it } from "vitest";
import { clampFixedPosition } from "./useClampedFixedPosition";

describe("clampFixedPosition", () => {
  it("keeps menus inside the viewport on both axes", () => {
    const result = clampFixedPosition(
      { x: 900, y: 700 },
      { width: 220, height: 320 },
      8,
      { width: 1024, height: 768 },
    );
    expect(result.left).toBe(796);
    expect(result.top).toBe(440);
  });

  it("respects padding when the menu is larger than the viewport", () => {
    const result = clampFixedPosition(
      { x: 12, y: 18 },
      { width: 1200, height: 900 },
      8,
      { width: 800, height: 600 },
    );
    expect(result.left).toBe(8);
    expect(result.top).toBe(8);
  });
});
