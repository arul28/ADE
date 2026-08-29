import { describe, expect, it } from "vitest";
import { fixedMenuAboveAnchorStyle } from "./fixedMenuPlacement";

describe("fixedMenuAboveAnchorStyle", () => {
  const rect = { left: 120, top: 400, right: 200 };

  it("anchors with top + translateY so vertical math never mixes innerHeight", () => {
    const style = fixedMenuAboveAnchorStyle(rect, { width: 240, viewportWidth: 800 });
    expect(style.top).toBe(400);
    expect(style.left).toBe(120);
    expect(style.width).toBe(240);
    expect(style.transform).toBe("translateY(calc(-100% - 8px))");
  });

  it("right-aligns when asked and clamps to the viewport", () => {
    const aligned = fixedMenuAboveAnchorStyle(
      { left: 700, top: 400, right: 790 },
      { width: 240, align: "end", gutter: 8, viewportWidth: 800 },
    );
    expect(aligned.left).toBe(790 - 240);

    const clamped = fixedMenuAboveAnchorStyle(
      { left: 760, top: 400, right: 800 },
      { width: 240, align: "end", gutter: 8, viewportWidth: 800 },
    );
    expect(clamped.left).toBe(800 - 240 - 8);
  });

  it("honors a custom gap in the translate", () => {
    const style = fixedMenuAboveAnchorStyle(rect, { width: 240, gap: 4, viewportWidth: 800 });
    expect(style.transform).toBe("translateY(calc(-100% - 4px))");
  });
});
