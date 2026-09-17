import { describe, expect, it } from "vitest";

import type { MacDesktopWindow } from "../../../shared/types/macDesktop";
import {
  macDesktopAppInitials,
  macDesktopClaimDisabled,
  macDesktopClaimFlatRows,
  macDesktopClaimGroups,
  macDesktopClaimLocation,
  macDesktopClaimNextIndex,
  macDesktopHasLease,
} from "./macDesktopClaimPicker.logic";

const LANE = "lane-a";
const DISPLAY = 31;

function makeWindow(overrides: Partial<MacDesktopWindow> = {}): MacDesktopWindow {
  return {
    id: 1,
    pid: 100,
    appName: "Safari",
    bundleId: "com.apple.Safari",
    title: "ADE",
    frame: { x: 0, y: 0, width: 800, height: 600 },
    laneId: null,
    origin: "claimed",
    onDisplayId: null,
    minimized: false,
    singleInstance: false,
    ...overrides,
  };
}

describe("macDesktopClaimLocation", () => {
  it("names the user's own desk", () => {
    expect(macDesktopClaimLocation(makeWindow(), { laneId: LANE, displayId: DISPLAY }))
      .toEqual({ kind: "main", label: "Main display" });
  });

  it("names this lane's screen by the display, not the lane id", () => {
    const released = makeWindow({ laneId: null, onDisplayId: DISPLAY });
    expect(macDesktopClaimLocation(released, { laneId: LANE, displayId: DISPLAY }).kind)
      .toBe("this-lane");
  });

  it("names the other lane, preferring its human name", () => {
    const window = makeWindow({ laneId: "lane-b", onDisplayId: 44 });
    expect(macDesktopClaimLocation(window, {
      laneId: LANE,
      displayId: DISPLAY,
      laneNames: { "lane-b": "docs-fix" },
    })).toEqual({ kind: "other-lane", label: "ADE · docs-fix" });
  });

  it("calls an unheld window on a real monitor the main display, not another lane", () => {
    // The driver answers with the CoreGraphics id of whichever display holds
    // the window, so the user's own monitor arrives as a number. Reading that
    // as ADE ownership labelled every ordinary window "ADE · another lane".
    const onTheUsersSecondMonitor = makeWindow({ laneId: null, onDisplayId: 77 });
    expect(macDesktopClaimLocation(onTheUsersSecondMonitor, { laneId: LANE, displayId: DISPLAY }))
      .toEqual({ kind: "main", label: "Main display" });
  });

  it("calls a window this lane released onto the desk the main display", () => {
    const released = makeWindow({ laneId: LANE, onDisplayId: 77 });
    expect(macDesktopClaimLocation(released, { laneId: LANE, displayId: DISPLAY }).kind).toBe("main");
  });
});

describe("macDesktopHasLease", () => {
  it("is true for a window this lane launched or claimed", () => {
    expect(macDesktopHasLease(makeWindow({ laneId: LANE, origin: "ade_launched" }), LANE)).toBe(true);
    expect(macDesktopHasLease(makeWindow({ laneId: LANE, origin: "claimed" }), LANE)).toBe(true);
  });

  it("is false for an adopted window and for another lane's window", () => {
    expect(macDesktopHasLease(makeWindow({ laneId: LANE, origin: "adopted" }), LANE)).toBe(false);
    expect(macDesktopHasLease(makeWindow({ laneId: "lane-b", origin: "claimed" }), LANE)).toBe(false);
  });
});

describe("macDesktopClaimDisabled", () => {
  it("locks a single-instance window owned by another lane", () => {
    const window = makeWindow({ laneId: "lane-b", onDisplayId: 44, singleInstance: true });
    expect(macDesktopClaimDisabled(window, {
      laneId: LANE,
      displayId: DISPLAY,
      laneNames: { "lane-b": "docs-fix" },
    })).toEqual({ disabled: true, reason: "held by docs-fix" });
  });

  it("allows taking a multi-instance window parked on another lane", () => {
    const window = makeWindow({ laneId: "lane-b", onDisplayId: 44 });
    expect(macDesktopClaimDisabled(window, { laneId: LANE, displayId: DISPLAY }).disabled).toBe(false);
  });

  it("does not offer a window already on this screen", () => {
    const window = makeWindow({ laneId: LANE, onDisplayId: DISPLAY });
    expect(macDesktopClaimDisabled(window, { laneId: LANE, displayId: DISPLAY }))
      .toEqual({ disabled: true, reason: "already on this screen" });
  });
});

describe("macDesktopClaimGroups", () => {
  const windows = [
    makeWindow({ id: 2, appName: "Xcode", bundleId: "com.apple.dt.Xcode", title: "ADE.xcodeproj", singleInstance: true, laneId: "lane-b", onDisplayId: 44 }),
    makeWindow({ id: 3, appName: "Safari", title: "Release notes" }),
    makeWindow({ id: 1, appName: "Safari", title: "ADE" }),
    makeWindow({ id: 9, appName: "Finder", bundleId: null, title: null, laneId: LANE, onDisplayId: DISPLAY }),
  ];

  it("groups by app, sorts groups and rows, and drops what is already here", () => {
    const groups = macDesktopClaimGroups(windows, { laneId: LANE, displayId: DISPLAY });
    expect(groups.map((group) => group.appName)).toEqual(["Safari", "Xcode"]);
    expect(groups[0]!.rows.map((row) => row.title)).toEqual(["ADE", "Release notes"]);
    expect(groups[1]!.rows[0]!.disabled).toBe(true);
  });

  it("filters on app name, window title and bundle id", () => {
    const byTitle = macDesktopClaimGroups(windows, { laneId: LANE, displayId: DISPLAY, query: "release" });
    expect(macDesktopClaimFlatRows(byTitle).map((row) => row.window.id)).toEqual([3]);
    const byBundle = macDesktopClaimGroups(windows, { laneId: LANE, displayId: DISPLAY, query: "dt.xcode" });
    expect(macDesktopClaimFlatRows(byBundle).map((row) => row.window.id)).toEqual([2]);
    expect(macDesktopClaimGroups(windows, { laneId: LANE, displayId: DISPLAY, query: "nothing" })).toEqual([]);
  });

  it("falls back to the app name when a window has no title", () => {
    const groups = macDesktopClaimGroups([makeWindow({ appName: "Finder", title: null })], {
      laneId: LANE,
      displayId: DISPLAY,
    });
    expect(groups[0]!.rows[0]!.title).toBe("Finder");
  });
});

describe("macDesktopClaimNextIndex", () => {
  const rows = macDesktopClaimFlatRows(macDesktopClaimGroups([
    makeWindow({ id: 1, appName: "Safari", title: "One" }),
    makeWindow({ id: 2, appName: "Xcode", bundleId: "x", title: "Locked", singleInstance: true, laneId: "lane-b", onDisplayId: 44 }),
    makeWindow({ id: 3, appName: "Zed", bundleId: "z", title: "Three" }),
  ], { laneId: LANE, displayId: DISPLAY }));

  it("walks past locked rows and wraps", () => {
    expect(macDesktopClaimNextIndex(rows, -1, 1)).toBe(0);
    expect(macDesktopClaimNextIndex(rows, 0, 1)).toBe(2);
    expect(macDesktopClaimNextIndex(rows, 2, 1)).toBe(0);
    expect(macDesktopClaimNextIndex(rows, 0, -1)).toBe(2);
  });

  it("gives up rather than looping when every row is locked", () => {
    const locked = macDesktopClaimFlatRows(macDesktopClaimGroups([
      makeWindow({ id: 2, singleInstance: true, laneId: "lane-b", onDisplayId: 44 }),
    ], { laneId: LANE, displayId: DISPLAY }));
    expect(macDesktopClaimNextIndex(locked, -1, 1)).toBe(-1);
    expect(macDesktopClaimNextIndex([], -1, 1)).toBe(-1);
  });
});

describe("macDesktopAppInitials", () => {
  it("takes one letter per word, two from a single word", () => {
    expect(macDesktopAppInitials("Visual Studio Code")).toBe("VS");
    expect(macDesktopAppInitials("Safari")).toBe("SA");
    expect(macDesktopAppInitials("")).toBe("?");
  });
});
