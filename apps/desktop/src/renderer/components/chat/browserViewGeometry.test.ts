import { describe, expect, it } from "vitest";
import {
  browserLetterboxFrame,
  clampBrowserViewBounds,
  emulationCaption,
} from "./browserViewGeometry";

describe("browserLetterboxFrame", () => {
  it("fills the stage inside the hairline when nothing is emulated", () => {
    expect(browserLetterboxFrame({ width: 600, height: 400 }, null)).toEqual({
      left: 1,
      top: 1,
      width: 598,
      height: 398,
      scale: 1,
    });
  });

  it("centres the exact CSS size of the emulated device", () => {
    expect(browserLetterboxFrame({ width: 800, height: 1000 }, { width: 393, height: 852 })).toEqual({
      left: 1 + Math.floor((798 - 393) / 2),
      top: 1 + Math.floor((998 - 852) / 2),
      width: 393,
      height: 852,
      scale: 1,
    });
  });

  it("scales a device that does not fit instead of cropping one edge of it", () => {
    const frame = browserLetterboxFrame({ width: 300, height: 400 }, { width: 393, height: 852 });
    // 398/852 is the binding constraint, so both axes shrink by it and the
    // whole phone stays on screen rather than losing its right-hand side.
    expect(frame.scale).toBeCloseTo(398 / 852, 5);
    expect(frame.width).toBe(Math.round(393 * (398 / 852)));
    expect(frame.height).toBe(398);
    expect(frame.width).toBeLessThanOrEqual(298);
    expect(frame.left).toBeGreaterThan(1);
  });

  it("keeps a landscape phone inside a narrow pane", () => {
    const frame = browserLetterboxFrame({ width: 578, height: 700 }, { width: 852, height: 393 });
    expect(frame.width).toBeLessThanOrEqual(576);
    expect(frame.height / frame.width).toBeCloseTo(393 / 852, 2);
    expect(frame.scale).toBeLessThan(1);
  });

  it("treats a zero-sized emulation as no emulation", () => {
    expect(browserLetterboxFrame({ width: 500, height: 300 }, { width: 0, height: 0 })).toEqual({
      left: 1,
      top: 1,
      width: 498,
      height: 298,
      scale: 1,
    });
  });
});

describe("clampBrowserViewBounds", () => {
  it("trims a stale measurement back into the pane", () => {
    expect(clampBrowserViewBounds(
      { x: 1_160, y: 60, width: 640, height: 800 },
      { left: 1_160, top: 60, right: 1_460, bottom: 860 },
    )).toEqual({ x: 1_160, y: 60, width: 300, height: 800 });
  });

  it("collapses to nothing rather than reporting a negative size", () => {
    // A frame entirely outside the box reads as zero-width, which is what the
    // panel treats as "not visible" — never as a negative rectangle.
    expect(clampBrowserViewBounds(
      { x: 900, y: 10, width: 200, height: 200 },
      { left: 0, top: 0, right: 400, bottom: 400 },
    )).toEqual({ x: 900, y: 10, width: 0, height: 200 });
  });
});

describe("emulationCaption", () => {
  it("reads as the device's CSS size", () => {
    expect(emulationCaption({ width: 393, height: 852 })).toBe("393 × 852");
    expect(emulationCaption(null)).toBeNull();
    expect(emulationCaption({ width: 0, height: 0 })).toBeNull();
  });

  it("admits when the pane was too small to show the device at 1:1", () => {
    expect(emulationCaption({ width: 393, height: 852 }, 0.82)).toBe("393 × 852 · fit 82%");
    // A rounding-error scale is not a fit, and saying "fit 100%" would read as
    // a warning about nothing.
    expect(emulationCaption({ width: 393, height: 852 }, 0.999)).toBe("393 × 852");
    expect(emulationCaption({ width: 393, height: 852 }, 1)).toBe("393 × 852");
  });
});
