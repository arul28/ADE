/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  appleScreenContentSize,
  appleScreenMaxScale,
  measureAppleScreenBox,
} from "./AppleDeviceFlatView";

/** A 3× iPhone: 393×852 points, decoded at 1179×2556 pixels. */
const POINTS = { width: 393, height: 852 };
const PIXELS = { width: 1_179, height: 2_556 };

describe("appleScreenMaxScale (round 4 §A6)", () => {
  it("lets a 3× stream grow to 1.5× its point size on a 2× display", () => {
    expect(appleScreenMaxScale(POINTS, PIXELS, 2)).toBeCloseTo(1.5, 5);
  });

  it("lets it grow to 3× on a 1× display — one source pixel per screen pixel", () => {
    expect(appleScreenMaxScale(POINTS, PIXELS, 1)).toBeCloseTo(3, 5);
  });

  it("never goes below 1, whatever the stream says", () => {
    expect(appleScreenMaxScale(POINTS, null, 2)).toBe(1);
    expect(appleScreenMaxScale(POINTS, { width: 0, height: 0 }, 2)).toBe(1);
    // Content already measured in pixels: the round-3 behaviour, unchanged.
    expect(appleScreenMaxScale(PIXELS, PIXELS, 2)).toBe(1);
    expect(appleScreenMaxScale(POINTS, PIXELS, 0)).toBeCloseTo(3, 5);
  });
});

describe("measureAppleScreenBox (round 4 §A6)", () => {
  it("FILLS a large pane instead of sitting at its point size", () => {
    // Round 3's `Math.min(fit, 1)` answered 393 wide in BOTH of these — the
    // "large pane is mostly empty" defect this item exists to fix.
    const tall = measureAppleScreenBox({ width: 900, height: 2_000 }, POINTS, {
      nativePixelSize: PIXELS,
      pixelRatio: 2,
    });
    expect(tall?.width).toBeCloseTo(393 * 1.5, 5);
    expect(tall?.height).toBeCloseTo(852 * 1.5, 5);

    // A pane the device is taller than still grows to the height it has.
    const wide = measureAppleScreenBox({ width: 900, height: 1_000 }, POINTS, {
      nativePixelSize: PIXELS,
      pixelRatio: 2,
    });
    expect(wide?.height).toBeCloseTo(1_000, 5);
    expect(wide?.left).toBeCloseTo((900 - (1_000 / 852) * 393) / 2, 5);
  });

  it("stops at the stream's real resolution rather than upscaling into mush", () => {
    const box = measureAppleScreenBox({ width: 4_000, height: 4_000 }, POINTS, {
      nativePixelSize: PIXELS,
      pixelRatio: 2,
    });
    expect(box?.width).toBeCloseTo(589.5, 1);
  });

  it("still shrinks to fit a small pane, and stays centred", () => {
    const box = measureAppleScreenBox({ width: 200, height: 1_000 }, POINTS, {
      nativePixelSize: PIXELS,
      pixelRatio: 2,
    });
    expect(box?.width).toBeCloseTo(200, 5);
    expect(box?.left).toBeCloseTo(0, 5);
    expect(box?.top).toBeCloseTo((1_000 - (200 / 393) * 852) / 2, 5);
  });

  it("refuses a zero container or a zero frame", () => {
    expect(measureAppleScreenBox({ width: 0, height: 10 }, POINTS)).toBeNull();
    expect(measureAppleScreenBox({ width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
  });
});


describe("appleScreenContentSize (round 4 §A6)", () => {
  it("measures in points when the host knows them", () => {
    expect(appleScreenContentSize(POINTS, PIXELS)).toEqual(POINTS);
  });

  it("ignores a degenerate point size instead of letting it win the ??", () => {
    // The live defect: the stream reports {0,0} until its transport answers,
    // `devicePointSize ?? screenPixelSize` picked it, `measureAppleScreenBox`
    // refused a zero content size, and the pane drew no screen at all over a
    // device that was 500 decoded frames in.
    expect(appleScreenContentSize({ width: 0, height: 0 }, PIXELS)).toEqual(PIXELS);
    expect(appleScreenContentSize(null, PIXELS)).toEqual(PIXELS);
    expect(appleScreenContentSize(undefined, PIXELS)).toEqual(PIXELS);
  });

  it("is null only when neither size is real", () => {
    expect(appleScreenContentSize(null, null)).toBeNull();
    expect(appleScreenContentSize({ width: 0, height: 0 }, { width: 0, height: 0 })).toBeNull();
  });
});
