import { describe, expect, it } from "vitest";
import {
  displayFrameToViewRect,
  displayPointToViewPoint,
  macDesktopAdvanceLockedPoint,
  macDesktopContentBox,
  macDesktopDisplayCentre,
  viewPointToDisplayPoint,
} from "./macDesktopGeometry";

/**
 * A click landing on the wrong pixel is invisible in a screenshot and obvious
 * here, which is the entire reason this mapping is a pure function.
 */

// 2560x1440 on the global plane, offset the way a second display actually is.
const display = { width: 2560, height: 1440, origin: { x: 3000, y: 0 } };

describe("macDesktopContentBox", () => {
  it("letterboxes a wide view with bars on the left and right", () => {
    const box = macDesktopContentBox({ left: 0, top: 0, width: 1600, height: 450 }, display);
    expect(box).not.toBeNull();
    expect(box?.scale).toBeCloseTo(450 / 1440);
    expect(box?.offsetY).toBeCloseTo(0);
    expect(box?.offsetX).toBeGreaterThan(0);
  });

  it("refuses a view or a display with no area", () => {
    expect(macDesktopContentBox({ left: 0, top: 0, width: 0, height: 100 }, display)).toBeNull();
    expect(macDesktopContentBox(
      { left: 0, top: 0, width: 100, height: 100 },
      { width: 0, height: 0, origin: { x: 0, y: 0 } },
    )).toBeNull();
  });
});

describe("viewPointToDisplayPoint", () => {
  const rect = { left: 100, top: 50, width: 1280, height: 720 };

  it("maps the centre of the view to the centre of the display", () => {
    const point = viewPointToDisplayPoint({
      clientX: 100 + 640,
      clientY: 50 + 360,
      rect,
      display,
    });
    expect(point).toEqual({ x: 3000 + 1280, y: 720 });
  });

  it("maps the top-left of the picture to the display's own origin", () => {
    const point = viewPointToDisplayPoint({ clientX: 100, clientY: 50, rect, display });
    expect(point).toEqual({ x: 3000, y: 0 });
  });

  it("returns null for a point in the letterbox bars rather than clamping it", () => {
    // Same aspect ratio in the other direction: a tall view has bars top and
    // bottom, and a click on a bar is not a click on the screen.
    const tall = { left: 0, top: 0, width: 1280, height: 1000 };
    const box = macDesktopContentBox(tall, display);
    expect(box?.offsetY).toBeGreaterThan(0);
    expect(viewPointToDisplayPoint({ clientX: 640, clientY: 2, rect: tall, display })).toBeNull();
  });

  it("round-trips through the inverse used by the agent cursor", () => {
    const view = { clientX: 100 + 900, clientY: 50 + 200 };
    const point = viewPointToDisplayPoint({ ...view, rect, display });
    expect(point).not.toBeNull();
    const back = displayPointToViewPoint({ x: point!.x, y: point!.y, rect, display });
    expect(back?.x).toBeCloseTo(view.clientX - rect.left);
    expect(back?.y).toBeCloseTo(view.clientY - rect.top);
  });

  it("drops a global point that is not on this display", () => {
    // A window on the user's real screen, not on the lane's.
    expect(displayPointToViewPoint({ x: 10, y: 10, rect, display })).toBeNull();
  });
});

describe("displayFrameToViewRect", () => {
  // 1600x900 display letterboxed into an 800x600 view: scale 0.5, 75px bars.
  const display = { width: 1600, height: 900, origin: { x: 0, y: 0 } };
  const rect = { left: 0, top: 0, width: 800, height: 600 };

  it("places a window frame on the picture", () => {
    expect(displayFrameToViewRect({ frame: { x: 200, y: 100, width: 400, height: 300 }, rect, display }))
      .toEqual({ left: 100, top: 125, width: 200, height: 150 });
  });

  it("clips a window hanging off the display instead of dropping it", () => {
    expect(displayFrameToViewRect({ frame: { x: -200, y: 0, width: 400, height: 200 }, rect, display }))
      .toEqual({ left: 0, top: 75, width: 100, height: 100 });
  });

  it("is null for a frame that does not touch the picture at all", () => {
    expect(displayFrameToViewRect({ frame: { x: 2000, y: 0, width: 100, height: 100 }, rect, display }))
      .toBeNull();
  });

  it("follows a display origin that is not at zero", () => {
    expect(displayFrameToViewRect({
      frame: { x: 3000, y: 500, width: 160, height: 90 },
      rect,
      display: { width: 1600, height: 900, origin: { x: 3000, y: 500 } },
    })).toEqual({ left: 0, top: 75, width: 80, height: 45 });
  });
});


describe("macDesktopAdvanceLockedPoint", () => {
  const display = { width: 1600, height: 900, origin: { x: 3000, y: 500 } };

  it("turns view-pixel movement into display points at the picture's scale", () => {
    // Half scale: the picture is drawn at half size, so a 40px hand movement
    // is 80 points on the lane's screen — the same ground it appears to cover.
    expect(macDesktopAdvanceLockedPoint({
      from: { x: 3100, y: 600 },
      movementX: 40,
      movementY: -20,
      display,
      scale: 0.5,
    })).toEqual({ x: 3180, y: 560 });
  });

  it("holds at the edges instead of wandering off the display", () => {
    // A locked pointer has no edge to stop at: the person can push in one
    // direction forever, and a point off the display reaches no window.
    expect(macDesktopAdvanceLockedPoint({
      from: { x: 3010, y: 510 },
      movementX: -9999,
      movementY: -9999,
      display,
      scale: 1,
    })).toEqual({ x: 3000, y: 500 });
    expect(macDesktopAdvanceLockedPoint({
      from: { x: 4000, y: 1000 },
      movementX: 9999,
      movementY: 9999,
      display,
      scale: 1,
    })).toEqual({ x: 4600, y: 1400 });
  });

  it("treats a zero scale as one rather than dividing by it", () => {
    expect(macDesktopAdvanceLockedPoint({
      from: { x: 3100, y: 600 },
      movementX: 10,
      movementY: 10,
      display,
      scale: 0,
    })).toEqual({ x: 3110, y: 610 });
  });

  it("starts a takeover in the middle when nothing was hovered", () => {
    expect(macDesktopDisplayCentre(display)).toEqual({ x: 3800, y: 950 });
  });
});
