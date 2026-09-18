import { describe, expect, it } from "vitest";

import type { MacDesktopWindow } from "../../../shared/types/macDesktop";
import {
  macDesktopAppGlyph,
  macDesktopFullscreenPicture,
  macDesktopIsWidePane,
  macDesktopParkedWindows,
  macDesktopPresentAction,
  macDesktopRelativeTime,
  macDesktopStatusPill,
  macDesktopStatusSegments,
  macDesktopStripControls,
  macDesktopStripName,
  macDesktopWindowRowText,
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

describe("macDesktopStatusSegments", () => {
  const agentLease = {
    laneId: "lane",
    holder: "agent" as const,
    holderId: "chat",
    holderLabel: null,
    grantedAt: "2026-09-17T00:00:00Z",
    expiresAt: "2026-09-17T00:01:00Z",
  };

  it("keeps the status word when takeover adds the control segment", () => {
    // The regression: the takeover banner's width collapsed the status chip to
    // a sliver that read as a bare separator, and "Live · Idle" disappeared.
    const idle = macDesktopStatusSegments(
      macDesktopStatusPill({ live: "playing", lease: agentLease, iHaveControl: false }),
    );
    expect(idle).toEqual({ status: "Live", separator: "·", detail: "Agent driving" });

    const takeover = macDesktopStatusSegments(
      macDesktopStatusPill({
        live: "playing",
        lease: { ...agentLease, holder: "user", holderId: "me", holderLabel: "You" },
        iHaveControl: true,
      }),
    );
    expect(takeover.status).toBe("Live");
    expect(takeover.detail).toBe("You are driving");
  });

  it("draws the separator only with the detail it introduces", () => {
    expect(macDesktopStatusSegments({ label: "Live", detail: "", tone: "live" }))
      .toEqual({ status: "Live", separator: null, detail: null });
    expect(macDesktopStatusSegments({ label: "Reconnecting", detail: "Idle", tone: "error" }))
      .toEqual({ status: "Reconnecting", separator: "·", detail: "Idle" });
  });
});

describe("macDesktopStripName", () => {
  it("leads with the display's own Mission Control name", () => {
    expect(macDesktopStripName({ displayName: "ADE · docs-fix", laneName: "docs-fix" }))
      .toBe("ADE · docs-fix");
  });

  it("falls back to the lane name while the display has not answered", () => {
    expect(macDesktopStripName({ displayName: "  ", laneName: "docs-fix" })).toBe("ADE · docs-fix");
    expect(macDesktopStripName({ displayName: null, laneName: "docs-fix" })).toBe("ADE · docs-fix");
  });

  it("draws nothing rather than a generic name when neither is known", () => {
    expect(macDesktopStripName({ displayName: null, laneName: null })).toBeNull();
    expect(macDesktopStripName({ displayName: null, laneName: "   " })).toBeNull();
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

describe("macDesktopFullscreenPicture", () => {
  it("fits the display inside the overlay and keeps its ratio", () => {
    expect(macDesktopFullscreenPicture({ width: 1043, height: 628 }, { width: 1920, height: 1080 }))
      .toEqual({ width: 1043, height: 587 });
    expect(macDesktopFullscreenPicture({ width: 2000, height: 600 }, { width: 1920, height: 1080 }))
      .toEqual({ width: 1067, height: 600 });
  });

  it("takes the margin off both axes before fitting", () => {
    expect(macDesktopFullscreenPicture({ width: 1024, height: 800 }, { width: 100, height: 100 }, 12))
      .toEqual({ width: 776, height: 776 });
  });

  it("has no box at all when there is no room or no display", () => {
    expect(macDesktopFullscreenPicture({ width: 0, height: 600 }, { width: 16, height: 9 })).toBeNull();
    expect(macDesktopFullscreenPicture({ width: 20, height: 20 }, { width: 16, height: 9 }, 12)).toBeNull();
    expect(macDesktopFullscreenPicture({ width: 800, height: 600 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("macDesktopStripControls", () => {
  it("carries the same controls in full screen as in the pane", () => {
    const args = { hostIsLocal: true, ownedCount: 2, parkedCount: 2 };
    const pane = macDesktopStripControls({ ...args, expanded: false });
    const full = macDesktopStripControls({ ...args, expanded: true });
    for (const key of ["status", "windows", "record", "present", "takeover"] as const) {
      expect(full[key]).toBe(pane[key]);
    }
  });

  it("spells the exit out in full screen and keeps the pane's icon tooltip", () => {
    const args = { hostIsLocal: false, ownedCount: 0, parkedCount: 0 };
    expect(macDesktopStripControls({ ...args, expanded: true }).fullscreen)
      .toEqual({ label: "Exit full screen", labelled: true });
    expect(macDesktopStripControls({ ...args, expanded: false }).fullscreen)
      .toEqual({ label: "Full screen", labelled: false });
  });

  it("drops present exactly when the present action does", () => {
    expect(macDesktopStripControls({ expanded: true, hostIsLocal: false, ownedCount: 3, parkedCount: 1 }).present)
      .toBe(false);
    expect(macDesktopStripControls({ expanded: true, hostIsLocal: true, ownedCount: 0, parkedCount: 0 }).present)
      .toBe(false);
    expect(macDesktopStripControls({ expanded: true, hostIsLocal: true, ownedCount: 3, parkedCount: 1 }).present)
      .toBe(true);
  });
});

describe("macDesktopWindowRowText", () => {
  it("prints the window title with the app as a secondary column", () => {
    expect(macDesktopWindowRowText(makeWindow({ appName: "Xcode", title: "ADE.xcodeproj" })))
      .toEqual({ primary: "ADE.xcodeproj", secondary: "Xcode" });
  });

  it("never says the same name twice", () => {
    expect(macDesktopWindowRowText(makeWindow({ appName: "Grok Bot", title: "Grok Bot" })))
      .toEqual({ primary: "Grok Bot", secondary: null });
    expect(macDesktopWindowRowText(makeWindow({ appName: "Grok Bot", title: "   " })))
      .toEqual({ primary: "Grok Bot", secondary: null });
  });

  it("falls back to a named row when there is neither a title nor an app", () => {
    expect(macDesktopWindowRowText(makeWindow({ appName: "", title: "" })))
      .toEqual({ primary: "Untitled window", secondary: null });
  });
});
