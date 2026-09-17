import { describe, expect, it } from "vitest";

import type { MacDesktopWindow } from "../../../shared/types/macDesktop";
import {
  macDesktopAppGlyph,
  macDesktopIsWidePane,
  macDesktopParkedWindows,
  macDesktopPresentAction,
  macDesktopRelativeTime,
  macDesktopStatusPill,
  macDesktopWindowLabel,
  macDesktopWindowTitle,
} from "./macDesktopStrip";

function makeWindow(overrides: Partial<MacDesktopWindow> = {}): MacDesktopWindow {
  return {
    id: 1,
    pid: 100,
    appName: "Xcode",
    bundleId: "com.apple.dt.Xcode",
    title: "ADE.xcodeproj",
    frame: { x: 0, y: 0, width: 800, height: 600 },
    laneId: null,
    origin: "claimed",
    onDisplayId: null,
    minimized: false,
    singleInstance: false,
    ...overrides,
  };
}

describe("macDesktopStatusPill", () => {
  it("is live and idle when the picture plays and nobody holds the lease", () => {
    expect(macDesktopStatusPill({ live: "playing", lease: null, iHaveControl: false }))
      .toEqual({ label: "Live", detail: "Idle", tone: "live" });
  });

  it("stays on Starting until a frame has actually been decoded", () => {
    for (const live of ["idle", "starting"] as const) {
      expect(macDesktopStatusPill({ live, lease: null, iHaveControl: false }).label).toBe("Starting");
    }
  });

  it("names the driver when somebody holds the lease", () => {
    expect(macDesktopStatusPill({
      live: "playing",
      lease: { laneId: "lane", holder: "agent", holderId: "chat", holderLabel: null, grantedAt: "2026-09-17T00:00:00Z", expiresAt: "2026-09-17T00:01:00Z" },
      iHaveControl: false,
    }).detail).toBe("Agent driving");
    expect(macDesktopStatusPill({
      live: "error",
      lease: { laneId: "lane", holder: "user", holderId: "me", holderLabel: "You", grantedAt: "2026-09-17T00:00:00Z", expiresAt: "2026-09-17T00:01:00Z" },
      iHaveControl: true,
    })).toEqual({ label: "Reconnecting", detail: "You are driving", tone: "error" });
  });
});

describe("macDesktopPresentAction", () => {
  it("offers nothing when the display is hosted on another machine", () => {
    expect(macDesktopPresentAction({ hostIsLocal: false, ownedCount: 2, parkedCount: 2 })).toBeNull();
  });

  it("offers nothing when the lane owns no windows", () => {
    expect(macDesktopPresentAction({ hostIsLocal: true, ownedCount: 0, parkedCount: 0 })).toBeNull();
  });

  it("brings parked windows to the user's own screen", () => {
    expect(macDesktopPresentAction({ hostIsLocal: true, ownedCount: 2, parkedCount: 2 }))
      .toEqual({ destination: "main", label: "Bring to my screen" });
  });

  it("sends presented windows back once none of them is on the lane's screen", () => {
    expect(macDesktopPresentAction({ hostIsLocal: true, ownedCount: 2, parkedCount: 0 }))
      .toEqual({ destination: "display", label: "Send back to the lane's screen" });
  });
});

describe("macDesktopParkedWindows", () => {
  it("counts only the windows sitting on this lane's display", () => {
    const parked = makeWindow({ id: 2, laneId: "lane", onDisplayId: 31 });
    const elsewhere = makeWindow({ id: 3, laneId: "lane", onDisplayId: 32 });
    expect(macDesktopParkedWindows([parked, elsewhere, makeWindow()], 31)).toEqual([parked]);
    expect(macDesktopParkedWindows([parked], null)).toEqual([]);
  });
});

describe("macDesktopWindowLabel", () => {
  it("joins the app and the window, and drops a missing title", () => {
    expect(macDesktopWindowLabel(makeWindow())).toBe("Xcode — ADE.xcodeproj");
    expect(macDesktopWindowLabel(makeWindow({ title: null }))).toBe("Xcode");
  });
});

describe("macDesktopIsWidePane", () => {
  it("stacks the tall tools column the pane normally is", () => {
    expect(macDesktopIsWidePane(360, 760)).toBe(false);
    expect(macDesktopIsWidePane(900, 700)).toBe(false);
  });

  it("goes side by side once the pane is appreciably wider than it is tall", () => {
    expect(macDesktopIsWidePane(1200, 600)).toBe(true);
  });

  it("refuses a pane too narrow to hold a rail beside the picture, however wide its ratio", () => {
    expect(macDesktopIsWidePane(400, 120)).toBe(false);
  });
});

describe("macDesktopAppGlyph", () => {
  it("initials a multi-word app and doubles up a single word", () => {
    expect(macDesktopAppGlyph("Visual Studio Code")).toBe("VS");
    expect(macDesktopAppGlyph("Xcode")).toBe("XC");
    expect(macDesktopAppGlyph("TextEdit")).toBe("TE");
  });

  it("never renders an empty glyph", () => {
    expect(macDesktopAppGlyph("")).toBe("?");
    expect(macDesktopAppGlyph(null)).toBe("?");
  });
});

describe("macDesktopWindowTitle", () => {
  it("names an untitled window rather than showing a blank row", () => {
    expect(macDesktopWindowTitle(makeWindow({ title: "   " }))).toBe("Untitled window");
    expect(macDesktopWindowTitle(makeWindow())).toBe("ADE.xcodeproj");
  });
});

describe("macDesktopRelativeTime", () => {
  it("is coarse and never negative", () => {
    const now = 1_000_000;
    expect(macDesktopRelativeTime(now, now)).toBe("just now");
    expect(macDesktopRelativeTime(now + 5_000, now)).toBe("just now");
    expect(macDesktopRelativeTime(now - 30_000, now)).toBe("30s ago");
    expect(macDesktopRelativeTime(now - 4 * 60_000, now)).toBe("4m ago");
    expect(macDesktopRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});
