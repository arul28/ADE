/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import { fixedMenuAboveAnchorStyle } from "./fixedMenuPlacement";

beforeEach(() => {
  window.innerWidth = 800;
});

describe("fixedMenuAboveAnchorStyle", () => {
  it("right-aligns when asked and clamps to the viewport", () => {
    const aligned = fixedMenuAboveAnchorStyle(
      { left: 700, top: 400, right: 790 },
      { width: 240, align: "end", gutter: 8 },
    );
    expect(aligned.left).toBe(790 - 240);

    const clamped = fixedMenuAboveAnchorStyle(
      { left: 760, top: 400, right: 800 },
      { width: 240, align: "end", gutter: 8 },
    );
    expect(clamped.left).toBe(800 - 240 - 8);
  });
});
