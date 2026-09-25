/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { AppleDeviceOrientation } from "../../../shared/types";
import { appleDragIntent, appleWheelIntent } from "./AppleDevice3DView";
import { appleCanvasHasDecoded, appleDeviceInputSize, orientedToPortrait } from "./appleDeviceScene";
import { createDeviceModelLoader } from "./appleDeviceModelLoader";

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


describe("appleCanvasHasDecoded", () => {
  function canvas(width: number, height: number): HTMLCanvasElement {
    const node = document.createElement("canvas");
    node.width = width;
    node.height = height;
    return node;
  }

  it("refuses the untouched 300×150 default", () => {
    // The placeholder is LANDSCAPE, so a layout measured from it comes back
    // rotated — and the body writes its UVs once, at install. A device that
    // goes idle at that moment keeps a sideways screen forever.
    expect(appleCanvasHasDecoded(document.createElement("canvas"))).toBe(false);
    expect(appleCanvasHasDecoded(canvas(300, 150))).toBe(false);
  });

  it("refuses a canvas with no size, and no canvas at all", () => {
    expect(appleCanvasHasDecoded(canvas(0, 0))).toBe(false);
    expect(appleCanvasHasDecoded(null)).toBe(false);
  });

  it("accepts a real decoded frame, portrait or landscape", () => {
    expect(appleCanvasHasDecoded(canvas(1_179, 2_556))).toBe(true);
    expect(appleCanvasHasDecoded(canvas(2_556, 1_179))).toBe(true);
    // 300 wide is fine as long as it is not the 300×150 pair.
    expect(appleCanvasHasDecoded(canvas(300, 650))).toBe(true);
  });
});

describe("createDeviceModelLoader", () => {
  it("loads embedded textures through an <img>, which the CSP allows", async () => {
    // GLTFLoader picks ImageBitmapLoader in Chromium, which fetch()es each
    // embedded image's blob: URL. The renderer CSP refuses blob: in
    // connect-src, so all 17 textures of every model failed and the body
    // rendered with bare materials. TextureLoader goes through img-src.
    const THREE = await import("three");
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const loader = createDeviceModelLoader(THREE, GLTFLoader);
    const manager = new THREE.LoadingManager();
    const parser = { textureLoader: new THREE.ImageBitmapLoader(), options: { manager } };

    // Registered plugins run against the parser when it is created.
    const plugins = (loader as unknown as { pluginCallbacks: Array<(p: unknown) => unknown> }).pluginCallbacks;
    for (const callback of plugins) callback(parser);

    expect(parser.textureLoader).toBeInstanceOf(THREE.TextureLoader);
    expect((parser.textureLoader as unknown as InstanceType<typeof THREE.TextureLoader>).manager).toBe(manager);
  });
});

