import { describe, expect, it } from "vitest";
import {
  composeFrameTransforms,
  frameToParentPoint,
  frameToParentRect,
  frameTransformFromBox,
  parentToFramePoint,
  type CdpBoxModelResponse,
  type FramePoint,
  type FrameRect,
} from "./cdpFrameTransform";

// Each iframe is 100x50 CSS pixels of content. Quads are listed as Chromium's
// DOM.getBoxModel draws them: top-left, top-right, bottom-right, bottom-left.
// Every expected value is worked out by hand from that geometry.
const moved: CdpBoxModelResponse = {
  model: { content: [10, 20, 110, 20, 110, 70, 10, 70], width: 100, height: 50 },
};
// transform: scale(0.5) with a 4px border, so the border box is 108x58 laid
// out and 54x29 drawn, and the content starts 2px in.
const scaledWithBorder: CdpBoxModelResponse = {
  model: {
    border: [0, 0, 54, 0, 54, 29, 0, 29],
    content: [2, 2, 52, 2, 52, 27, 2, 27],
    width: 108,
    height: 58,
  },
};
// transform: rotate(90deg) about the content's top-left corner at (10, 20).
const rotated: CdpBoxModelResponse = {
  model: { content: [10, 20, 10, 120, -40, 120, -40, 20], width: 100, height: 50 },
};
// transform: scaleX(-1): the frame's left edge is drawn on the right.
const mirrored: CdpBoxModelResponse = {
  model: { content: [110, 20, 10, 20, 10, 70, 110, 70], width: 100, height: 50 },
};

function expectPointNear(actual: FramePoint, expected: FramePoint): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
}

function expectRectNear(actual: FrameRect, expected: FrameRect): void {
  expectPointNear(actual, expected);
  expect(actual.width).toBeCloseTo(expected.width, 6);
  expect(actual.height).toBeCloseTo(expected.height, 6);
}

describe("cdpFrameTransform", () => {
  it.each([
    {
      name: "a moved iframe",
      box: moved,
      local: { x: 30, y: 10 },
      parent: { x: 40, y: 30 },
      localRect: { x: 30, y: 10, width: 20, height: 10 },
      parentRect: { x: 40, y: 30, width: 20, height: 10 },
    },
    {
      name: "a half-scale iframe with a border",
      box: scaledWithBorder,
      local: { x: 40, y: 20 },
      parent: { x: 22, y: 12 },
      localRect: { x: 40, y: 20, width: 20, height: 10 },
      parentRect: { x: 22, y: 12, width: 10, height: 5 },
    },
    {
      name: "a rotated iframe",
      box: rotated,
      local: { x: 30, y: 10 },
      parent: { x: 0, y: 50 },
      localRect: { x: 30, y: 10, width: 20, height: 10 },
      parentRect: { x: -10, y: 50, width: 10, height: 20 },
    },
    {
      name: "a mirrored iframe",
      box: mirrored,
      local: { x: 30, y: 10 },
      parent: { x: 80, y: 30 },
      localRect: { x: 30, y: 10, width: 20, height: 10 },
      parentRect: { x: 60, y: 30, width: 20, height: 10 },
    },
  ])("maps points and boxes through $name", ({ box, local, parent, localRect, parentRect }) => {
    const transform = frameTransformFromBox(box);

    expectPointNear(frameToParentPoint(local, transform), parent);
    expectPointNear(parentToFramePoint(parent, transform), local);
    expectRectNear(frameToParentRect(localRect, transform), parentRect);
  });

  it("maps a frame inside a frame through both, and back", () => {
    // The moved frame sits inside the half-scale frame: its (30, 10) is
    // (40, 30) in the half-scale frame, which is drawn at (2 + 20, 2 + 15).
    const nested = composeFrameTransforms(frameTransformFromBox(scaledWithBorder), frameTransformFromBox(moved));

    expectPointNear(frameToParentPoint({ x: 30, y: 10 }, nested), { x: 22, y: 17 });
    expectPointNear(parentToFramePoint({ x: 22, y: 17 }, nested), { x: 30, y: 10 });
    expectRectNear(frameToParentRect({ x: 30, y: 10, width: 20, height: 10 }, nested), { x: 22, y: 17, width: 10, height: 5 });
  });
});
