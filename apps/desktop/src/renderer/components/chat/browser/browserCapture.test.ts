/* @vitest-environment jsdom */

/**
 * The drag-to-crop arithmetic, tested without a browser view.
 *
 * The interesting cases are the letterboxed ones: the screenshot is drawn
 * `object-fit: contain` inside the stage, so screen coordinates and image
 * coordinates differ by an offset AND a scale. Getting that wrong crops the
 * wrong region of the right picture, which looks like a service bug.
 */
import { describe, expect, it } from "vitest";
import type { PointerEvent } from "react";
import {
  browserCaptureFrame,
  clampBrowserFrame,
  measureObjectContain,
  pointerToCapturePoint,
} from "./browserCapture";

/** An element of a fixed on-screen size, which is all these helpers read. */
function stageOf(width: number, height: number): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height,
    toJSON: () => ({}),
  }) as DOMRect;
  return element;
}

function pointerAt(x: number, y: number): PointerEvent<HTMLElement> {
  return { clientX: x, clientY: y } as PointerEvent<HTMLElement>;
}

describe("clampBrowserFrame", () => {
  it("keeps a crop inside the image it is a crop of", () => {
    expect(clampBrowserFrame({ x: -20, y: -20, width: 50, height: 50 }, 100, 100))
      .toEqual({ x: 0, y: 0, width: 50, height: 50 });
    expect(clampBrowserFrame({ x: 90, y: 90, width: 50, height: 50 }, 100, 100))
      .toEqual({ x: 50, y: 50, width: 50, height: 50 });
  });

  it("never yields a zero-sized crop, which has nothing to draw", () => {
    const frame = clampBrowserFrame({ x: 10, y: 10, width: 0, height: 0 }, 100, 100);
    expect(frame.width).toBe(1);
    expect(frame.height).toBe(1);
  });

  it("rounds to whole pixels, because a canvas draw does anyway", () => {
    expect(clampBrowserFrame({ x: 10.6, y: 10.4, width: 20.5, height: 20.4 }, 100, 100))
      .toEqual({ x: 11, y: 10, width: 21, height: 20 });
  });
});

describe("browserCaptureFrame", () => {
  it("normalizes a drag made in any direction", () => {
    const upLeft = browserCaptureFrame(
      { startX: 80, startY: 80, currentX: 20, currentY: 30, bounds: null as never },
      100,
      100,
    );
    expect(upLeft).toEqual({ x: 20, y: 30, width: 60, height: 50 });
  });

  it("clamps a drag that ran off the picture", () => {
    const frame = browserCaptureFrame(
      { startX: -40, startY: -40, currentX: 60, currentY: 60, bounds: null as never },
      100,
      100,
    );
    expect(frame.x).toBe(0);
    expect(frame.y).toBe(0);
  });
});

describe("measureObjectContain", () => {
  it("is null when there is nothing to measure against", () => {
    expect(measureObjectContain(stageOf(200, 100), 0, 0)).toBeNull();
    expect(measureObjectContain(stageOf(0, 0), 100, 100)).toBeNull();
  });

  it("letterboxes a square image inside a wide stage", () => {
    const bounds = measureObjectContain(stageOf(200, 100), 100, 100);
    expect(bounds).toEqual({ left: 50, top: 0, width: 100, height: 100, scaleX: 1, scaleY: 1 });
  });

  it("scales down an image larger than its stage, keeping both axes equal", () => {
    const bounds = measureObjectContain(stageOf(100, 100), 200, 200);
    expect(bounds?.scaleX).toBe(0.5);
    expect(bounds?.scaleY).toBe(0.5);
    expect(bounds?.left).toBe(0);
  });
});

describe("pointerToCapturePoint", () => {
  const stage = stageOf(200, 100);

  it("maps a screen point back through the letterbox offset and the scale", () => {
    // 100×100 image centred in a 200×100 stage: x=50 on screen is x=0 in image.
    expect(pointerToCapturePoint(pointerAt(50, 0), stage, 100, 100))
      .toMatchObject({ x: 0, y: 0 });
    expect(pointerToCapturePoint(pointerAt(150, 100), stage, 100, 100))
      .toMatchObject({ x: 100, y: 100 });
  });

  it("refuses a point in the letterbox bars unless asked to clamp", () => {
    expect(pointerToCapturePoint(pointerAt(10, 50), stage, 100, 100)).toBeNull();
    expect(pointerToCapturePoint(pointerAt(10, 50), stage, 100, 100, true))
      .toMatchObject({ x: 0, y: 50 });
  });

  it("is null when the stage cannot be measured at all", () => {
    expect(pointerToCapturePoint(pointerAt(10, 10), stageOf(0, 0), 100, 100)).toBeNull();
  });
});
