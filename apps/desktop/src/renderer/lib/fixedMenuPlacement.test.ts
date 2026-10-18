/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedMenuAboveAnchorStyle } from "./fixedMenuPlacement";
import { __resetHostedWebZoomForTests, applyHostedWebZoom } from "./webZoom";

function rectOf(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

/**
 * Stub the body the way the hosted web client's zoom shows in the browser: the
 * body's layout width is `offsetWidth`, and its rect is that times the zoom.
 */
function stubZoomedBody(zoom: number) {
  Object.defineProperty(document.body, "offsetWidth", { configurable: true, value: 1000 });
  document.body.getBoundingClientRect = () => rectOf(0, 0, 1000 * zoom, 800 * zoom);
}

beforeEach(() => {
  window.innerWidth = 800;
  window.innerHeight = 600;
});

afterEach(() => {
  __resetHostedWebZoomForTests();
  delete (document.body as unknown as { offsetWidth?: number }).offsetWidth;
  delete (document.body as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

describe("fixedMenuAboveAnchorStyle", () => {
  const rect = { left: 120, top: 400, right: 200 };

  it("anchors with top + translateY so the gap is in style pixels", () => {
    const style = fixedMenuAboveAnchorStyle(rect, { width: 240 });
    expect(style.top).toBe(400);
    expect(style.left).toBe(120);
    expect(style.width).toBe(240);
    expect(style.transform).toBe("translateY(calc(-100% - 8px))");
  });

  it("right-aligns when asked and clamps to the viewport", () => {
    const aligned = fixedMenuAboveAnchorStyle(
      { left: 500, top: 400, right: 590 },
      { width: 240, align: "end", gutter: 8 },
    );
    expect(aligned.left).toBe(590 - 240);

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

  it("writes the anchor in layout pixels under the hosted web zoom (fails before the fix)", () => {
    applyHostedWebZoom(1.1);
    stubZoomedBody(1.1);
    // A 100px-wide box at layout x=100 is 110 on screen, so the menu's left is 100 in style px.
    const style = fixedMenuAboveAnchorStyle(
      { left: 110, top: 220, right: 220 },
      { width: 240 },
    );
    expect(style.left).toBeCloseTo(100, 6);
    expect(style.top).toBeCloseTo(200, 6);
  });

  it("right-aligns against the zoomed anchor edge and the zoomed viewport", () => {
    applyHostedWebZoom(1.1);
    stubZoomedBody(1.1);
    const style = fixedMenuAboveAnchorStyle(
      { left: 660, top: 220, right: 770 },
      { width: 240, align: "end", gutter: 8 },
    );
    // Right edge 770 on screen is 700 in style px; 800 on screen is 727.27 px of viewport.
    expect(style.left).toBeCloseTo(700 - 240, 6);
  });

  it("zoom 1 leaves placement identical to the unzoomed rect", () => {
    applyHostedWebZoom(1);
    stubZoomedBody(1);
    const style = fixedMenuAboveAnchorStyle(rect, { width: 240 });
    expect(style.left).toBe(120);
    expect(style.top).toBe(400);
  });

  it("places into a transformed container's space (a dialog panel scaled to 0.5)", () => {
    applyHostedWebZoom(1.1);
    stubZoomedBody(1.1);
    const panel = document.createElement("div");
    panel.style.transform = "scale(0.5)";
    document.body.appendChild(panel);
    // The panel's box on screen: origin at (300, 100), half of its layout size, times the zoom.
    panel.getBoundingClientRect = () => rectOf(300, 100, 200 * 1.1 * 0.5, 100 * 1.1 * 0.5);
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 100 });
    // An anchor at screen (400, 150) sits 100 screen px right and 50 down from the origin.
    const style = fixedMenuAboveAnchorStyle(
      { left: 400, top: 150, right: 410 },
      { width: 100, container: panel },
    );
    // Style px = screen px / (zoom 1.1 * scale 0.5) = 100 / 0.55 and 50 / 0.55.
    expect(style.left).toBeCloseTo(100 / 0.55, 6);
    expect(style.top).toBeCloseTo(50 / 0.55, 6);
    panel.remove();
  });
});
