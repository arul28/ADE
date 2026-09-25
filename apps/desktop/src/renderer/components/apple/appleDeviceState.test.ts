/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import type { AppleInstalledSimulator, IosScreenElement } from "../../../shared/types/iosSimulator";
import {
  APPLE_DEFAULT_VIEW_MODE,
  APPLE_DEVICE_ORIENTATION_CYCLE,
  appleElementContextItem,
  appleEventAddresses,
  appleInputAllowed,
  appleLaneDeviceBooted,
  appleStatusSaysBooted,
  applePowerFromPhase,
  laneDeviceBooted,
  appleRailVisible,
  appleSimulatorDescription,
  appleToolCardSubtitle,
  isAppleSimulatorBooted,
  nextAppleDeviceOrientation,
  readAppleViewMode,
  resolveAppleDeviceState,
  writeAppleViewMode,
  sortAppleSimulators,
  type ResolveAppleDeviceStateInput,
} from "./appleDeviceState";

const LIVE: ResolveAppleDeviceStateInput = {
  supported: true,
  helperAvailable: true,
  hasDevice: true,
  booted: true,
  starting: false,
  previewing: false,
  streamReady: true,
  streamState: "live",
};

const state = (overrides: Partial<ResolveAppleDeviceStateInput> = {}) =>
  resolveAppleDeviceState({ ...LIVE, ...overrides });

describe("resolveAppleDeviceState", () => {
  it("answers the host's question before the device's", () => {
    // A Linux runtime is not a device problem with a device fix, so nothing
    // below it — not even a lane that owns a device — can change the answer.
    expect(state({ supported: false })).toBe("unsupported");
    expect(state({ supported: false, hasDevice: false, streamState: "error" }))
      .toBe("unsupported");
    expect(state({ helperAvailable: false })).toBe("helper-missing");
  });

  it("lets a rendered preview take the viewport from a live stream", () => {
    expect(state({ previewing: true })).toBe("preview");
    // But never from a host that could not show a device at all.
    expect(state({ previewing: true, supported: false })).toBe("unsupported");
  });

  it("shows the loading card for an in-flight start, device or not", () => {
    expect(state({ starting: true, hasDevice: false })).toBe("starting");
    expect(state({ starting: true, booted: false })).toBe("starting");
  });

  it("shows the picker only when the lane owns nothing", () => {
    expect(state({ hasDevice: false })).toBe("no-device");
  });

  it("never reports a stream problem for a lane with no live device", () => {
    // The round-1 bug, verbatim: "No frames", with a Reconnect button, on a
    // lane that owned no simulator at all.
    expect(state({ hasDevice: false, streamState: "error" })).toBe("no-device");
    expect(state({ booted: false, streamState: "stalled" })).toBe("stopped");
  });

  it("separates a dead stream from a dead device", () => {
    expect(state({ streamState: "stalled" })).toBe("video-lost");
    expect(state({ streamState: "error" })).toBe("video-lost");
    expect(state({ booted: false })).toBe("stopped");
    expect(state()).toBe("live");
  });

  it("never calls a device live before there is anything to read", () => {
    // Round 3, A1. `live` used to mean "booted and not stalled", so a pane
    // whose stream had not connected painted an empty black stage that took
    // input — the user's "input does nothing", with the pane's own "Input
    // disconnected, reconnecting…" pill showing in a state it called live.
    expect(state({ streamReady: false, streamState: "idle" })).toBe("starting");
    expect(state({ streamReady: false, streamState: "starting" })).toBe("starting");
    expect(state({ streamReady: false, streamState: "paused" })).toBe("starting");

    // Connected is live even before the first frame: the stage is the decoder,
    // so a state that waits for frames to mount it never gets any. A stream
    // that draws nothing is demoted by the first-frame watchdog instead.
    expect(state({ streamReady: true, streamState: "starting" })).toBe("live");
    expect(state({ streamReady: true, streamState: "stalled" })).toBe("video-lost");
  });
});

describe("appleInputAllowed / appleRailVisible", () => {
  it("only sends input at a real picture", () => {
    expect(appleInputAllowed("live")).toBe(true);
    for (const value of ["video-lost", "stopped", "no-device", "starting", "preview"] as const) {
      expect(appleInputAllowed(value)).toBe(false);
    }
  });

  it("keeps the rail over a dimmed last frame, and nowhere else", () => {
    expect(appleRailVisible("live")).toBe(true);
    expect(appleRailVisible("video-lost")).toBe(true);
    expect(appleRailVisible("stopped")).toBe(false);
    expect(appleRailVisible("no-device")).toBe(false);
  });
});

function simulator(overrides: Partial<AppleInstalledSimulator>): AppleInstalledSimulator {
  return {
    udid: "udid",
    name: "iPhone 17 Pro",
    runtime: "iOS 26.2",
    state: "Shutdown",
    isAvailable: true,
    family: "iphone",
    deviceTypeIdentifier: null,
    ...overrides,
  };
}

describe("picker ordering and copy", () => {
  it("puts booted devices first, then sorts alphabetically", () => {
    const rows = sortAppleSimulators([
      simulator({ udid: "c", name: "iPhone Air" }),
      simulator({ udid: "a", name: "ADE Unit C" }),
      simulator({ udid: "b", name: "iPhone 17 Pro Max", state: "Booted" }),
    ]);
    expect(rows.map((row) => row.udid)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the list it was given", () => {
    const input = [simulator({ udid: "z", name: "Z" }), simulator({ udid: "a", name: "A" })];
    sortAppleSimulators(input);
    expect(input.map((row) => row.udid)).toEqual(["z", "a"]);
  });

  it("describes a row as runtime then power", () => {
    expect(appleSimulatorDescription(simulator({ state: "Booted" }))).toBe("iOS 26.2 · Running");
    expect(appleSimulatorDescription(simulator({}))).toBe("iOS 26.2 · Stopped");
    expect(isAppleSimulatorBooted({ state: "Booting" })).toBe(false);
  });
});

describe("appleToolCardSubtitle", () => {
  it("is §9's four lines, and never the word Simulator over a real name", () => {
    expect(appleToolCardSubtitle(null)).toBe("No device");
    expect(appleToolCardSubtitle({ name: "iPhone 17 Pro", state: "starting" }))
      .toBe("iPhone 17 Pro · Starting");
    expect(appleToolCardSubtitle({ name: "iPhone 17 Pro", state: "running" }))
      .toBe("iPhone 17 Pro · Running");
    expect(appleToolCardSubtitle({ name: "iPhone 17 Pro", state: "off" }))
      .toBe("iPhone 17 Pro · Shut down");
  });

  it("falls back to a name rather than rendering an empty half", () => {
    expect(appleToolCardSubtitle({ name: "  ", state: "off" })).toBe("Simulator · Shut down");
    expect(appleToolCardSubtitle({ name: null, state: "running" })).toBe("Simulator · Running");
  });
});

describe("nextAppleDeviceOrientation", () => {
  it("steps 90° per click and wraps", () => {
    expect(nextAppleDeviceOrientation("portrait")).toBe("landscape-left");
    expect(nextAppleDeviceOrientation("landscape-left")).toBe("portrait-upside-down");
    expect(nextAppleDeviceOrientation("portrait-upside-down")).toBe("landscape-right");
    expect(nextAppleDeviceOrientation("landscape-right")).toBe("portrait");
    expect(APPLE_DEVICE_ORIENTATION_CYCLE).toHaveLength(4);
  });
});


/* ── Round 4 §A2: the remembered view ─────────────────────────────────────── */

describe("the view mode preference", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to 3D, per round 4's first owner decision", () => {
    expect(APPLE_DEFAULT_VIEW_MODE).toBe("3d");
    expect(readAppleViewMode("/repo")).toBe("3d");
    expect(readAppleViewMode(null)).toBe("3d");
  });

  it("remembers the choice per project", () => {
    writeAppleViewMode("/repo", "flat");
    expect(readAppleViewMode("/repo")).toBe("flat");
    // Another project is untouched, and keeps the default.
    expect(readAppleViewMode("/other")).toBe("3d");
    writeAppleViewMode("/repo", "3d");
    expect(readAppleViewMode("/repo")).toBe("3d");
  });

  it("treats a projectless pane as one more project, not as no memory", () => {
    writeAppleViewMode(null, "flat");
    expect(readAppleViewMode(null)).toBe("flat");
    expect(readAppleViewMode("  ")).toBe("flat");
  });

  it("survives junk in storage rather than throwing at the pane", () => {
    window.localStorage.setItem("ade.apple.viewMode.v1", "{not json");
    expect(readAppleViewMode("/repo")).toBe("3d");
    window.localStorage.setItem("ade.apple.viewMode.v1", JSON.stringify({ "/repo": "hologram" }));
    expect(readAppleViewMode("/repo")).toBe("3d");
  });
});

/* ── Round 4 §A4: the inspect card's chip ─────────────────────────────────── */

describe("appleElementContextItem", () => {
  const element: IosScreenElement = {
    id: "sign-in",
    source: "accessibility",
    layer: "accessibility",
    label: "Sign in",
    value: null,
    role: "button",
    elementType: null,
    identifier: "signInButton",
    frame: { x: 100, y: 400, width: 120, height: 44 },
    pixelFrame: { x: 300, y: 1_200, width: 360, height: 132 },
    componentId: null,
    sourceFile: null,
    sourceLine: null,
    metadata: {},
  };

  it("is the composer packet the shared insertion path speaks", () => {
    const item = appleElementContextItem(element, new Date(0));
    expect(item).toEqual({
      kind: "ios_element",
      id: "sign-in",
      // No SwiftUI match: the id is still something the agent can look up.
      componentId: "sign-in",
      sourceFile: null,
      sourceLine: null,
      frame: { x: 100, y: 400, width: 120, height: 44 },
      metadata: {},
      accessibilityIdentifier: "signInButton",
      selectedAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("prefers the inspector's accessibility identifier over the raw one", () => {
    const item = appleElementContextItem({
      ...element,
      metadata: { accessibilityIdentifier: "SignInButton.primary" },
    });
    expect(item.accessibilityIdentifier).toBe("SignInButton.primary");
  });
});

describe("power and event helpers", () => {
  it("reads power from a device-state phase", () => {
    expect(applePowerFromPhase("booted")).toBe("on");
    expect(applePowerFromPhase("streaming")).toBe("on");
    expect(applePowerFromPhase("stopped")).toBe("off");
    expect(applePowerFromPhase("starting")).toBeNull();
  });

  it("reads the lane's own device out of one list", () => {
    const lane = { udid: "A" } as never;
    expect(laneDeviceBooted({ lane, installed: [{ udid: "A", state: "Booted" }] as never })).toBe(true);
    expect(laneDeviceBooted({ lane, installed: [{ udid: "B", state: "Booted" }] as never })).toBe(false);
    expect(laneDeviceBooted({ lane: null, installed: [] })).toBe(false);
    expect(laneDeviceBooted(null)).toBe(false);
  });

  it("trusts simctl over an open session, and an off answer over both", () => {
    const session = { statusSaysBooted: false, sessionUdid: "A" };
    expect(appleLaneDeviceBooted({ deviceUdid: "A", offUdid: null, installedForLane: null, ...session })).toBe(true);
    expect(appleLaneDeviceBooted({ deviceUdid: "A", offUdid: null, installedForLane: { state: "Shutdown" }, ...session })).toBe(false);
    expect(appleLaneDeviceBooted({ deviceUdid: "A", offUdid: "A", installedForLane: { state: "Booted" }, ...session })).toBe(false);
    expect(appleLaneDeviceBooted({ deviceUdid: null, offUdid: null, installedForLane: null, ...session })).toBe(false);
    // A status read of Booted beats a stale Shutdown in the list.
    expect(appleLaneDeviceBooted({
      deviceUdid: "A", offUdid: null, installedForLane: { state: "Shutdown" }, statusSaysBooted: true, sessionUdid: null,
    })).toBe(true);
  });

  it("reads Booted from the status only for the device asked about", () => {
    const status = { activeDevice: { udid: "A", state: "Booted" } } as never;
    expect(appleStatusSaysBooted(status, "A")).toBe(true);
    expect(appleStatusSaysBooted(status, "B")).toBe(false);
    expect(appleStatusSaysBooted(status, null)).toBe(false);
    expect(appleStatusSaysBooted({ activeDevice: { udid: "A", state: "Shutdown" } } as never, "A")).toBe(false);
    expect(appleStatusSaysBooted(null, "A")).toBe(false);
  });

  it("scopes simulator events to one chat on one lane", () => {
    const surface = { chatSessionId: "chat-1", laneId: "lane-1", acceptUnscoped: false };
    expect(appleEventAddresses({ chatSessionId: "chat-1" }, surface)).toBe(true);
    expect(appleEventAddresses({ chatSessionId: "chat-2" }, surface)).toBe(false);
    expect(appleEventAddresses({ chatSessionId: "chat-1", laneId: "lane-2" }, surface)).toBe(false);
    expect(appleEventAddresses({ laneId: "lane-1" }, surface)).toBe(true);
    expect(appleEventAddresses({ laneId: "lane-1" }, { ...surface, laneId: null })).toBe(false);
    expect(appleEventAddresses({}, surface)).toBe(false);
    expect(appleEventAddresses({ laneId: " " }, { ...surface, acceptUnscoped: true })).toBe(true);
  });
});
