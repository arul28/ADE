import { describe, expect, it } from "vitest";
import type { AppleInstalledSimulator } from "../../../shared/types/iosSimulator";
import {
  APPLE_DEVICE_ORIENTATION_CYCLE,
  appleInputAllowed,
  appleRailVisible,
  appleSimulatorDescription,
  appleToolCardSubtitle,
  isAppleSimulatorBooted,
  nextAppleDeviceOrientation,
  resolveAppleDeviceState,
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

  it("treats a quiet stream on a booted device as live", () => {
    expect(state({ streamState: "idle" })).toBe("live");
    expect(state({ streamState: "starting" })).toBe("live");
    expect(state({ streamState: "paused" })).toBe("live");
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
      .toBe("iPhone 17 Pro · Off");
  });

  it("falls back to a name rather than rendering an empty half", () => {
    expect(appleToolCardSubtitle({ name: "  ", state: "off" })).toBe("Simulator · Off");
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
