import { describe, expect, it } from "vitest";
import type { AppleWindowLayoutAction } from "../../../shared/types/iosSimulator";
import { judgeAppleWindowLayout } from "./appleWindowLayout";

/**
 * Frames read back live from an iPad Pro 11-inch (M5), iPadOS 27.0, after each
 * window-menu layout, both ways up. The verdict decides `ade apple window`'s
 * exit code, so a correct layout must land and a wrong one must not.
 */
const PORTRAIT = { width: 834, height: 1210 };
const LANDSCAPE = { width: 1210, height: 834 };
const frame = (width: number, height: number, x: number, y: number) => ({ x, y, width, height });

describe("judgeAppleWindowLayout", () => {
  it.each<[string, AppleWindowLayoutAction, { width: number; height: number }, ReturnType<typeof frame>, boolean]>([
    ["portrait left", "left", PORTRAIT, frame(412, 1087, 0, 0), true],
    ["portrait right", "right", PORTRAIT, frame(412, 1087, 422, 0), true],
    ["portrait top", "top", PORTRAIT, frame(834, 600, 0, 0), true],
    ["portrait bottom", "bottom", PORTRAIT, frame(834, 600, 0, 610), true],
    ["portrait split", "split", PORTRAIT, frame(412, 1210, 0, 0), true],
    ["portrait thirds (the app's minimum width outgrows a third)", "thirds", PORTRAIT, frame(375, 1210, 0, 0), true],
    ["portrait quarters", "quarters", PORTRAIT, frame(412, 600, 0, 0), true],
    ["landscape left", "left", LANDSCAPE, frame(600, 711, 0, 0), true],
    ["landscape right", "right", LANDSCAPE, frame(600, 711, 610, 0), true],
    ["landscape top (minimum height outgrows the half)", "top", LANDSCAPE, frame(1210, 486, 0, 0), true],
    ["landscape bottom, running 37 pt past the bottom edge", "bottom", LANDSCAPE, frame(1210, 486, 0, 385), true],
    ["landscape split", "split", LANDSCAPE, frame(600, 834, 0, 0), true],
    ["landscape thirds", "thirds", LANDSCAPE, frame(396, 834, 0, 0), true],
    ["landscape quarters", "quarters", LANDSCAPE, frame(600, 486, 0, 0), true],
    ["landscape quarters, slightly narrower", "quarters", LANDSCAPE, frame(585, 486, 0, 0), true],
    ["portrait thirds centred on its slot, past the left edge", "thirds", PORTRAIT, frame(375, 1210, -52, 0), true],
    ["landscape slide over", "slide-over", LANDSCAPE, frame(375, 655, 815, 44), true],
    ["landscape fill", "fill", LANDSCAPE, frame(1210, 834, 0, 0), true],
    // Not landed.
    ["a filled window is no top half", "top", LANDSCAPE, frame(1210, 834, 0, 0), false],
    ["a portrait half is not a landscape half", "left", LANDSCAPE, frame(412, 1087, 0, 0), false],
    ["a thirds window too far off the left edge", "thirds", PORTRAIT, frame(375, 1210, -200, 0), false],
    ["a right half that is really on the left", "right", PORTRAIT, frame(412, 1087, 0, 0), false],
    ["a free window is no quarter", "quarters", LANDSCAPE, frame(500, 600, 356, 58), false],
  ])("%s", (_name, action, screen, after, landed) => {
    expect(judgeAppleWindowLayout(action, after, screen, frame(500, 600, 100, 100)).landed).toBe(landed);
  });

  it("says why a landed window runs off the screen", () => {
    expect(judgeAppleWindowLayout("thirds", frame(375, 1210, -52, 0), PORTRAIT, null).note)
      .toMatch(/width \(375\) is larger than the 271-point slot.*52 pt past the left edge/u);
    expect(judgeAppleWindowLayout("bottom", frame(1210, 486, 0, 385), LANDSCAPE, null).note)
      .toMatch(/height \(486\) is larger than the 412-point slot.*37 pt past the bottom edge/u);
  });
});
