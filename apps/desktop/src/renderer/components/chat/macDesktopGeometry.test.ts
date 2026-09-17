import { describe, expect, it } from "vitest";
import {
  displayPointToViewPoint,
  macDesktopContentBox,
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
