/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import { fixedMenuAboveAnchorStyle } from "./fixedMenuPlacement";

beforeEach(() => {
  window.innerWidth = 800;
});

describe("fixedMenuAboveAnchorStyle", () => {
  const rect = { left: 120, top: 400, right: 200 };

  it("anchors with top + translateY so vertical math never mixes innerHeight", () => {
    const style = fixedMenuAboveAnchorStyle(rect, { width: 240 });
    expect(style.top).toBe(400);
    expect(style.left).toBe(120);
    expect(style.width).toBe(240);
    expect(style.transform).toBe("translateY(calc(-100% - 8px))");
  });

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

  it("honors a custom gap in the translate", () => {
    const style = fixedMenuAboveAnchorStyle(rect, { width: 240, gap: 4 });
    expect(style.transform).toBe("translateY(calc(-100% - 4px))");
  });

  it("opens below the anchor when asked, and only when it has the anchor's bottom", () => {
    const below = fixedMenuAboveAnchorStyle(
      { left: 120, top: 400, right: 200, bottom: 428 },
      { width: 240, below: true },
    );
    expect(below.top).toBe(428 + 8);
    // Nothing to hang off, so it stays above rather than landing at NaN.
    expect(below.transform).toBe("none");
    expect(below.left).toBe(120);

    const noBottom = fixedMenuAboveAnchorStyle(rect, { width: 240, below: true });
    expect(noBottom.top).toBe(400);
    expect(noBottom.transform).toBe("translateY(calc(-100% - 8px))");
  });
});
