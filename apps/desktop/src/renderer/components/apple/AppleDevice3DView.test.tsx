/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  appleDeviceInputSize,
  appleDragIntent,
  appleWheelIntent,
  orientedToPortrait,
  type AppleDeviceOrientation,
} from "./AppleDevice3DView";

describe("appleDragIntent (round 4 §A3)", () => {
  it("drives the device when the drag starts on the glass", () => {
    expect(appleDragIntent({ onScreen: true, altKey: false, interactive: true })).toBe("input");
  });

  it("orbits when the drag starts off the glass", () => {
    expect(appleDragIntent({ onScreen: false, altKey: false, interactive: true })).toBe("orbit");
  });

  it("orbits when Alt is held, even over the glass", () => {
    expect(appleDragIntent({ onScreen: true, altKey: true, interactive: true })).toBe("orbit");
  });

  it("orbits while the device cannot take input at all", () => {
    expect(appleDragIntent({ onScreen: true, altKey: false, interactive: false })).toBe("orbit");
  });
});

describe("appleWheelIntent (ported from t3code phoneTrackpad.ts)", () => {
  it("scrolls the device on a plain wheel over the glass", () => {
    expect(appleWheelIntent({ ctrlKey: false, metaKey: false, onScreen: true, interactive: true }))
      .toBe("scroll");
  });

  it("zooms the camera on ctrl- or cmd-wheel, even over the glass", () => {
    expect(appleWheelIntent({ ctrlKey: true, metaKey: false, onScreen: true, interactive: true }))
      .toBe("zoom");
    expect(appleWheelIntent({ ctrlKey: false, metaKey: true, onScreen: true, interactive: true }))
      .toBe("zoom");
  });

  it("zooms off the glass, and while the device takes no input", () => {
    expect(appleWheelIntent({ ctrlKey: false, metaKey: false, onScreen: false, interactive: true }))
      .toBe("zoom");
    expect(appleWheelIntent({ ctrlKey: false, metaKey: false, onScreen: true, interactive: false }))
      .toBe("zoom");
  });
});

describe("orientedToPortrait", () => {
  const ORIENTATIONS: AppleDeviceOrientation[] = [
    "portrait",
    "portrait-upside-down",
    "landscape-left",
    "landscape-right",
  ];

  // The 3D inspect overlay projects device points back onto the panel, so this
  // has to be the exact inverse of the tap mapping or the frames land in the
  // wrong place on a rotated device.
  it("is the inverse of the panel → oriented mapping, in every orientation", () => {
    for (const orientation of ORIENTATIONS) {
      for (const u of [0, 0.25, 1]) {
        for (const vFromBottom of [0, 0.6, 1]) {
          const oriented = portraitToOriented(u, vFromBottom, orientation);
          const back = orientedToPortrait(oriented.x, oriented.y, orientation);
          expect(back.u, `${orientation} u`).toBeCloseTo(u, 10);
          expect(back.vFromBottom, `${orientation} v`).toBeCloseTo(vFromBottom, 10);
        }
      }
    }
  });
});

/** The private forward mapping, restated here so the inverse has something to be the inverse OF. */
function portraitToOriented(
  u: number,
  vFromBottom: number,
  orientation: AppleDeviceOrientation,
): { x: number; y: number } {
  switch (orientation) {
    case "portrait":
      return { x: u, y: 1 - vFromBottom };
    case "portrait-upside-down":
      return { x: 1 - u, y: vFromBottom };
    case "landscape-left":
      return { x: vFromBottom, y: u };
    case "landscape-right":
      return { x: 1 - vFromBottom, y: 1 - u };
  }
}


describe("appleDeviceInputSize (round 4 §A3/§A4)", () => {
  const PIXELS = { width: 1_179, height: 2_556 };
  const POINTS = { width: 393, height: 852 };

  it("answers in POINTS — the space the device and its frames speak", () => {
    expect(appleDeviceInputSize(POINTS, PIXELS)).toEqual(POINTS);
  });

  it("falls back to pixels only when the host never said what the points are", () => {
    expect(appleDeviceInputSize(null, PIXELS)).toEqual(PIXELS);
    expect(appleDeviceInputSize(undefined, PIXELS)).toEqual(PIXELS);
    expect(appleDeviceInputSize({ width: 0, height: 0 }, PIXELS)).toEqual(PIXELS);
  });
});
