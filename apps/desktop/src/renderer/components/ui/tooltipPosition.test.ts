import { describe, expect, it } from "vitest";
import {
  computeTooltipPosition,
  rectsOverlap,
  resolveTooltipSide,
  type TooltipRect,
} from "./tooltipPosition";

const VIEWPORT = { width: 1000, height: 800 };

function trigger(partial: Partial<TooltipRect> & { top: number; left: number; width: number; height: number }): TooltipRect {
  return {
    ...partial,
    right: partial.right ?? partial.left + partial.width,
    bottom: partial.bottom ?? partial.top + partial.height,
  };
}

describe("computeTooltipPosition", () => {
  it("keeps the preferred side when it fits", () => {
    const placement = computeTooltipPosition({
      preferredSide: "bottom",
      trigger: trigger({ top: 100, left: 400, width: 24, height: 24 }),
      tooltip: { width: 120, height: 26 },
      viewport: VIEWPORT,
    });
    expect(placement.side).toBe("bottom");
    expect(placement.y).toBeGreaterThanOrEqual(124);
  });

  it("flips to the opposite side rather than hanging off the window", () => {
    // A header dot 8px from the top: "top" has no room, "bottom" does.
    const box = trigger({ top: 8, left: 400, width: 20, height: 20 });
    expect(resolveTooltipSide({
      preferredSide: "top",
      trigger: box,
      tooltip: { width: 140, height: 30 },
      viewport: VIEWPORT,
    })).toBe("bottom");
  });

  it("shifts along the cross axis to stay inside the window — the clipped 'Clos' case", () => {
    // The pane's close button, hard against the right edge of a 1000px window.
    const closeButton = trigger({ top: 40, left: 964, width: 36, height: 36 });
    const placement = computeTooltipPosition({
      preferredSide: "bottom",
      trigger: closeButton,
      tooltip: { width: 150, height: 26 },
      viewport: VIEWPORT,
    });
    // Fully inside, both edges.
    expect(placement.x).toBeGreaterThanOrEqual(0);
    expect(placement.x + 150).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it("never overlaps the control it describes, on any side", () => {
    const box = trigger({ top: 300, left: 480, width: 40, height: 24 });
    const tooltip = { width: 160, height: 28 };
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const placement = computeTooltipPosition({ preferredSide: side, trigger: box, tooltip, viewport: VIEWPORT });
      expect(rectsOverlap({ x: placement.x, y: placement.y, ...tooltip }, box)).toBe(false);
    }
  });

  it("still clears the trigger when the window is too small for any side to fit", () => {
    // A 60px-tall window: nothing "fits", but the tooltip must not land on top
    // of the control — that is the failure the clamp used to produce.
    const tinyViewport = { width: 200, height: 60 };
    const box = trigger({ top: 20, left: 90, width: 20, height: 20 });
    const tooltip = { width: 150, height: 40 };
    const placement = computeTooltipPosition({
      preferredSide: "top",
      trigger: box,
      tooltip,
      viewport: tinyViewport,
    });
    expect(rectsOverlap({ x: placement.x, y: placement.y, ...tooltip }, box)).toBe(false);
  });

  it("falls back to the roomiest side when neither axis fits", () => {
    const box = trigger({ top: 10, left: 10, width: 20, height: 20 });
    const side = resolveTooltipSide({
      preferredSide: "top",
      trigger: box,
      tooltip: { width: 400, height: 400 },
      viewport: { width: 300, height: 300 },
    });
    // Right (300 - 30 = 270) and bottom (300 - 30 = 270) tie; either is honest,
    // but it must not stay on the 10px-deep "top".
    expect(side).not.toBe("top");
    expect(side).not.toBe("left");
  });
});
