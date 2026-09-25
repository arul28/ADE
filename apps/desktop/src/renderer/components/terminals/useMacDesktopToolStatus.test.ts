import { describe, expect, it } from "vitest";

import type { MacDesktopDisplay, MacDesktopStatus } from "../../../shared/types/macDesktop";
import { macDesktopStatusLineText, macDesktopToolStateFromEntry } from "./useMacDesktopToolStatus";

/**
 * The Mac Desktop picker card's line.
 *
 * The card used to print the catalogue hint forever — "A private screen per
 * lane" whether the lane had a screen up or not — which is the one card in the
 * pane that never reported anything measured.
 */

// Fixed, not `new Date()`: two calls a millisecond apart made unequal
// objects, and the `toEqual` below failed now and then under load.
const STAMP = "2026-09-24T12:00:00.000Z";

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
    createdAt: STAMP,
    windowCount: 0,
    lastActivityAt: STAMP,
  };
}

describe("macDesktopStatusLineText", () => {
  it("asks for the screen to be started when the lane has none", () => {
    expect(macDesktopStatusLineText(null)).toEqual({
      line: "Mac Desktop is off",
      live: false,
    });
    expect(macDesktopStatusLineText({ display: null, windowCount: 0 })).toEqual({
      line: "Mac Desktop is off",
      live: false,
    });
  });

  it("never says active about a screen the host did not just confirm", () => {
    expect(macDesktopStatusLineText({ display: display(), windowCount: 1, confirmed: false })).toEqual({
      line: "Mac Desktop is not answering",
      live: false,
    });
  });

  it("reads the pane's entry, so the card and the pane say the same thing", () => {
    const status = { display: display(), windows: [{ onDisplayId: 65 }, { onDisplayId: 1 }] } as unknown as MacDesktopStatus;
    expect(macDesktopToolStateFromEntry({ status, confirmed: true })).toEqual({
      display: display(),
      windowCount: 1,
      confirmed: true,
    });
    expect(macDesktopToolStateFromEntry(null)).toBeNull();
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
