import { describe, expect, it } from "vitest";

import type { MacDesktopWindow } from "../../../shared/types/macDesktop";
import {
  macDesktopClaimDisabled,
  macDesktopClaimAppIcons,
  macDesktopClaimIsUntitled,
  macDesktopClaimLocation,
  macDesktopClaimNextIndex,
  macDesktopClaimRow,
  macDesktopClaimRows,
  macDesktopClaimVisibleWindows,
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
    })).toEqual({ kind: "other-lane", label: "Lane: docs-fix" });
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
    })).toEqual({ disabled: true, reason: "Held by docs-fix" });
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

describe("macDesktopClaimRows", () => {
  const windows = [
    makeWindow({ id: 2, appName: "Xcode", bundleId: "com.apple.dt.Xcode", title: "ADE.xcodeproj", singleInstance: true, laneId: "lane-b", onDisplayId: 44 }),
    makeWindow({ id: 3, appName: "Safari", title: "Release notes" }),
    makeWindow({ id: 1, appName: "Safari", title: "ADE" }),
    makeWindow({ id: 9, appName: "Finder", bundleId: null, title: null, laneId: LANE, onDisplayId: DISPLAY }),
  ];

  it("is one flat table body sorted by app then title, minus what is already here", () => {
    const rows = macDesktopClaimRows(windows, { laneId: LANE, displayId: DISPLAY });
    expect(rows.map((row) => [row.appName, row.title]))
      .toEqual([["Safari", "ADE"], ["Safari", "Release notes"], ["Xcode", "ADE.xcodeproj"]]);
    expect(rows[2]!.disabled).toBe(true);
  });

  it("filters on app name, window title and bundle id", () => {
    const byTitle = macDesktopClaimRows(windows, { laneId: LANE, displayId: DISPLAY, query: "release" });
    expect(byTitle.map((row) => row.window.id)).toEqual([3]);
    const byBundle = macDesktopClaimRows(windows, { laneId: LANE, displayId: DISPLAY, query: "dt.xcode" });
    expect(byBundle.map((row) => row.window.id)).toEqual([2]);
    expect(macDesktopClaimRows(windows, { laneId: LANE, displayId: DISPLAY, query: "nothing" })).toEqual([]);
  });

  it("falls back to the app name when a window has no title", () => {
    const rows = macDesktopClaimRows([makeWindow({ appName: "Finder", title: null })], {
      laneId: LANE,
      displayId: DISPLAY,
    });
    expect(rows[0]!.title).toBe("Finder");
  });

  it("joins the app icon onto every row of that app, not only the one that carried it", () => {
    // The driver sends one PNG per bundle id per reply; without the join the
    // second Safari window would draw a hole where its icon goes.
    const rows = macDesktopClaimRows([
      makeWindow({ id: 1, appName: "Safari", title: "ADE", iconPng: "AAAA" }),
      makeWindow({ id: 3, appName: "Safari", title: "Release notes" }),
      makeWindow({ id: 4, appName: "Zed", bundleId: "dev.zed.Zed", title: "lane" }),
    ], { laneId: LANE, displayId: DISPLAY });
    expect(rows.map((row) => row.iconPng)).toEqual(["AAAA", "AAAA", null]);
  });
});

describe("macDesktopClaimAppIcons", () => {
  it("keys by bundle id, falls back to the app name, and ignores blanks", () => {
    expect(macDesktopClaimAppIcons([
      makeWindow({ id: 1, iconPng: "PNG1" }),
      makeWindow({ id: 2, iconPng: "   " }),
      makeWindow({ id: 3, appName: "Finder", bundleId: null, iconPng: "PNG2" }),
      makeWindow({ id: 4, appName: "Finder", bundleId: null, iconPng: "LATER" }),
    ])).toEqual({ "com.apple.Safari": "PNG1", Finder: "PNG2" });
  });
});

describe("macDesktopClaimNextIndex", () => {
  const rows = macDesktopClaimRows([
    makeWindow({ id: 1, appName: "Safari", title: "One" }),
    makeWindow({ id: 2, appName: "Xcode", bundleId: "x", title: "Locked", singleInstance: true, laneId: "lane-b", onDisplayId: 44 }),
    makeWindow({ id: 3, appName: "Zed", bundleId: "z", title: "Three" }),
  ], { laneId: LANE, displayId: DISPLAY });

  it("walks past locked rows and wraps", () => {
    expect(macDesktopClaimNextIndex(rows, -1, 1)).toBe(0);
    expect(macDesktopClaimNextIndex(rows, 0, 1)).toBe(2);
    expect(macDesktopClaimNextIndex(rows, 2, 1)).toBe(0);
    expect(macDesktopClaimNextIndex(rows, 0, -1)).toBe(2);
  });

  it("gives up rather than looping when every row is locked", () => {
    const locked = macDesktopClaimRows([
      makeWindow({ id: 2, singleInstance: true, laneId: "lane-b", onDisplayId: 44 }),
    ], { laneId: LANE, displayId: DISPLAY });
    expect(macDesktopClaimNextIndex(locked, -1, 1)).toBe(-1);
    expect(macDesktopClaimNextIndex([], -1, 1)).toBe(-1);
  });
});

describe("macDesktopClaimVisibleWindows", () => {
  it("hides ADE's own windows, dev build and shipped build alike", () => {
    const shipped = makeWindow({ id: 10, appName: "ADE", bundleId: "com.ade.desktop", title: "Work" });
    const dev = makeWindow({ id: 11, appName: "Electron", bundleId: "com.github.Electron", title: "Work" });
    const unbranded = makeWindow({ id: 12, appName: "Electron", bundleId: null, title: null });
    const other = makeWindow({ id: 13 });
    expect(macDesktopClaimVisibleWindows([shipped, dev, unbranded, other]).map((w) => w.id))
      .toEqual([13]);
  });

  it("drops an app's untitled windows when that app also has a titled one", () => {
    // One TextEdit document showed as nine "TextEdit · minimized" rows: its own
    // hidden service windows, each untitled.
    const document = makeWindow({ id: 1, appName: "TextEdit", bundleId: "com.apple.TextEdit", title: "Notes.txt" });
    const services = [2, 3, 4].map((id) => makeWindow({
      id,
      appName: "TextEdit",
      bundleId: "com.apple.TextEdit",
      title: null,
      frame: { x: id, y: 0, width: 10, height: 10 },
    }));
    expect(macDesktopClaimVisibleWindows([document, ...services]).map((w) => w.id)).toEqual([1]);
  });

  it("keeps a window titled after its app — it is a window, not a scratch surface", () => {
    // The rule that drops an app's extra rows asks whether the window server
    // NAMED the entry, not whether the name is interesting. Reading a window
    // called "Activity Monitor" as untitled made its app look like it had no
    // titled window at all, so its nameless menu-bar strips were kept too and
    // the picker listed Activity Monitor, Music and Grok Bot twice each —
    // once as the real window, once as "Untitled window · minimized".
    const titled = makeWindow({ id: 1, appName: "TextEdit", bundleId: "com.apple.TextEdit", title: "Notes.txt" });
    const selfNamed = makeWindow({ id: 2, appName: "TextEdit", bundleId: "com.apple.TextEdit", title: "TextEdit" });
    const strip = makeWindow({
      id: 3,
      appName: "TextEdit",
      bundleId: "com.apple.TextEdit",
      title: null,
      minimized: true,
      frame: { x: 0, y: 0, width: 5120, height: 30 },
    });
    expect(macDesktopClaimVisibleWindows([titled, selfNamed, strip]).map((w) => w.id)).toEqual([1, 2]);
  });

  it("still calls a self-named window untitled", () => {
    // The flag survives the table rewrite even though the Window cell now
    // prints the name: a caller may still want to know the window named
    // itself after its app.
    const selfNamed = makeWindow({ id: 2, appName: "TextEdit", bundleId: "com.apple.TextEdit", title: "TextEdit" });
    expect(macDesktopClaimIsUntitled(selfNamed)).toBe(true);
  });

  it("keeps the untitled rows of an app that has no titled window at all", () => {
    const only = makeWindow({ id: 5, appName: "Preview", bundleId: "com.apple.Preview", title: null });
    expect(macDesktopClaimVisibleWindows([only]).map((w) => w.id)).toEqual([5]);
  });

  it("collapses rows that share a pid, a title and a frame", () => {
    const one = makeWindow({ id: 1, pid: 900, title: "Notes.txt", appName: "TextEdit" });
    const twin = makeWindow({ id: 2, pid: 900, title: "Notes.txt", appName: "TextEdit" });
    const elsewhere = makeWindow({
      id: 3,
      pid: 900,
      title: "Notes.txt",
      appName: "TextEdit",
      frame: { x: 40, y: 0, width: 800, height: 600 },
    });
    expect(macDesktopClaimVisibleWindows([one, twin, elsewhere]).map((w) => w.id)).toEqual([1, 3]);
  });

  it("is applied by macDesktopClaimRows", () => {
    const ade = makeWindow({ id: 10, appName: "ADE", bundleId: "com.ade.desktop", title: "Work" });
    const rows = macDesktopClaimRows([ade, makeWindow({ id: 13 })], { laneId: LANE, displayId: DISPLAY });
    expect(rows.map((row) => row.appName)).toEqual(["Safari"]);
  });
});

describe("macDesktopClaimRow untitled", () => {
  it("marks a window named after its app so the row does not repeat the name", () => {
    const row = macDesktopClaimRow(
      makeWindow({ appName: "TextEdit", bundleId: "com.apple.TextEdit", title: "TextEdit" }),
      { laneId: LANE, displayId: DISPLAY },
    );
    expect(row.untitled).toBe(true);
    expect(macDesktopClaimRow(makeWindow({ title: "Notes.txt" }), { laneId: LANE, displayId: DISPLAY }).untitled)
      .toBe(false);
  });
});
