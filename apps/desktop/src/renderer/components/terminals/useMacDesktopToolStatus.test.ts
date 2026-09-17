import { describe, expect, it } from "vitest";

import type { MacDesktopDisplay } from "../../../shared/types/macDesktop";
import { macDesktopStatusLineText } from "./useMacDesktopToolStatus";

/**
 * The Mac Desktop picker card's line.
 *
 * The card used to print the catalogue hint forever — "A private screen per
 * lane" whether the lane had a screen up or not — which is the one card in the
 * pane that never reported anything measured.
 */

function display(): MacDesktopDisplay {
  return {
    laneId: "lane-a",
    displayId: 65,
    name: "ADE · lane-a",
    mode: "virtual",
    width: 2560,
    height: 1440,
    scale: 1,
    origin: { x: -2560, y: 0 },
    createdAt: new Date().toISOString(),
    windowCount: 0,
    lastActivityAt: new Date().toISOString(),
  };
}

describe("macDesktopStatusLineText", () => {
  it("asks for the screen to be started when the lane has none", () => {
    expect(macDesktopStatusLineText(null)).toEqual({
      line: "Start Mac Desktop for this lane",
      live: false,
    });
    expect(macDesktopStatusLineText({ display: null, windowCount: 0 })).toEqual({
      line: "Start Mac Desktop for this lane",
      live: false,
    });
  });

  it("reports a live screen, and counts the windows only when there are some", () => {
    expect(macDesktopStatusLineText({ display: display(), windowCount: 0 }))
      .toEqual({ line: "Mac Desktop active", live: true });
    expect(macDesktopStatusLineText({ display: display(), windowCount: 1 }).line)
      .toBe("Mac Desktop active · 1 window");
    expect(macDesktopStatusLineText({ display: display(), windowCount: 3 }).line)
      .toBe("Mac Desktop active · 3 windows");
  });
});
