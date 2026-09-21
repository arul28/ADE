import { describe, expect, it } from "vitest";
import {
  appleCommandForElement,
  appleHeaderChips,
  appleInputAllowed,
  nextAppleDeviceOrientation,
  resolveAppleDeviceState,
  type ResolveAppleDeviceStateInput,
} from "./appleDeviceState";
import type { IosScreenElement } from "../../../shared/types/iosSimulator";

function stateInput(overrides: Partial<ResolveAppleDeviceStateInput> = {}): ResolveAppleDeviceStateInput {
  return {
    supported: true,
    hasLaneDevice: true,
    poweredOff: false,
    creating: false,
    booting: false,
    building: false,
    ownedByOtherChat: false,
    hasAppSession: false,
    streamState: "live",
    failed: false,
    ...overrides,
  };
}

function element(overrides: Partial<IosScreenElement> = {}): IosScreenElement {
  return {
    id: "el-1",
    source: "accessibility",
    layer: "app",
    label: "Sign in",
    value: null,
    role: "button",
    elementType: null,
    identifier: "signInButton",
    frame: { x: 0, y: 0, width: 10, height: 10 },
    pixelFrame: { x: 0, y: 0, width: 30, height: 30 },
    componentId: null,
    sourceFile: null,
    sourceLine: null,
    metadata: {},
    ...overrides,
  };
}

describe("resolveAppleDeviceState", () => {
  it("names a non-Mac runtime an error rather than a missing device", () => {
    // The fix here is the ordering: a Windows lane has no device AND no Mac,
    // and "No device yet / Create a device" on it offers an action that cannot
    // work.
    expect(resolveAppleDeviceState(stateInput({ supported: false, hasLaneDevice: false }))).toBe("error");
  });

  it("reports no-device before any stream verdict", () => {
    expect(resolveAppleDeviceState(stateInput({
      hasLaneDevice: false,
      streamState: "stalled",
    }))).toBe("no-device");
  });

  it("puts creating and booting ahead of everything", () => {
    expect(resolveAppleDeviceState(stateInput({ creating: true, hasLaneDevice: false }))).toBe("creating");
    expect(resolveAppleDeviceState(stateInput({ booting: true, poweredOff: true }))).toBe("booting");
  });

  it("reports powered-off before ownership or stream state", () => {
    expect(resolveAppleDeviceState(stateInput({
      poweredOff: true,
      ownedByOtherChat: true,
      streamState: "error",
    }))).toBe("powered-off");
  });

  it("puts ownership ahead of the stream, because a watcher must be told first", () => {
    expect(resolveAppleDeviceState(stateInput({
      ownedByOtherChat: true,
      streamState: "stalled",
      building: true,
    }))).toBe("watching");
  });

  it("keeps building visible while the stream is live underneath", () => {
    expect(resolveAppleDeviceState(stateInput({ building: true, hasAppSession: true }))).toBe("building");
  });

  it("turns a stalled or errored stream into stalled", () => {
    expect(resolveAppleDeviceState(stateInput({ streamState: "stalled" }))).toBe("stalled");
    expect(resolveAppleDeviceState(stateInput({ streamState: "error" }))).toBe("stalled");
  });

  it("separates a booted device with an app from one without", () => {
    expect(resolveAppleDeviceState(stateInput({ hasAppSession: true }))).toBe("app-running");
    expect(resolveAppleDeviceState(stateInput({ hasAppSession: false }))).toBe("ready-no-app");
  });

  it("treats a failed launch step as the error state", () => {
    expect(resolveAppleDeviceState(stateInput({ failed: true }))).toBe("error");
  });
});

describe("appleHeaderChips", () => {
  const live = { label: "Live", detail: "Encoded on this Mac.", tone: "active" as const };

  it("shows no chip at all with no device", () => {
    expect(appleHeaderChips("no-device", live)).toEqual([]);
    expect(appleHeaderChips("powered-off", live)).toEqual([]);
  });

  it("names the transient states", () => {
    expect(appleHeaderChips("creating", null)[0]?.label).toBe("Creating");
    expect(appleHeaderChips("booting", null)[0]?.label).toBe("Booting");
  });

  it("shows Live AND Building during a build", () => {
    expect(appleHeaderChips("building", live).map((chip) => chip.label)).toEqual(["Live", "Building"]);
  });

  it("carries the stream chip through the steady states", () => {
    expect(appleHeaderChips("app-running", live)).toEqual([live]);
    expect(appleHeaderChips("watching", live)).toEqual([live]);
  });

  it("overrides the stream chip when the column itself is stalled or failed", () => {
    expect(appleHeaderChips("stalled", live)[0]?.label).toBe("Stalled");
    expect(appleHeaderChips("error", live)[0]?.label).toBe("Error");
  });
});

describe("appleInputAllowed", () => {
  it("refuses input in every state that is not a driveable device", () => {
    expect(appleInputAllowed("app-running")).toBe(true);
    expect(appleInputAllowed("ready-no-app")).toBe(true);
    expect(appleInputAllowed("building")).toBe(true);
    for (const state of ["watching", "stalled", "no-device", "powered-off", "error", "creating", "booting"] as const) {
      expect(appleInputAllowed(state)).toBe(false);
    }
  });
});

describe("nextAppleDeviceOrientation", () => {
  it("cycles portrait → landscape-left → upside-down → landscape-right", () => {
    expect(nextAppleDeviceOrientation("portrait")).toBe("landscape-left");
    expect(nextAppleDeviceOrientation("landscape-left")).toBe("portrait-upside-down");
    expect(nextAppleDeviceOrientation("portrait-upside-down")).toBe("landscape-right");
    expect(nextAppleDeviceOrientation("landscape-right")).toBe("portrait");
  });
});

describe("appleCommandForElement", () => {
  it("prefers the service's own ref, which is hashed", () => {
    // `commandFor` builds `--identifier signInButton`, which is right for a
    // human reading the panel and wrong for a paste: `--ref` resolves against
    // `id:<shortHash>`, so a raw identifier matches nothing.
    const command = appleCommandForElement(element({ metadata: { ref: "id:9f3c1a2b" } }));
    expect(command).toBe("ade --socket apple tap-element --ref id:9f3c1a2b");
  });

  it("falls back to the identifier query when the snapshot carries no ref", () => {
    expect(appleCommandForElement(element())).toBe(
      "ade --socket apple tap-element --identifier signInButton",
    );
  });

  it("quotes a ref that needs it", () => {
    expect(appleCommandForElement(element({ metadata: { ref: "label:a b" } })))
      .toBe("ade --socket apple tap-element --ref 'label:a b'");
  });

  it("ignores a non-string or blank ref", () => {
    expect(appleCommandForElement(element({ metadata: { ref: "   " } })))
      .toBe("ade --socket apple tap-element --identifier signInButton");
    expect(appleCommandForElement(element({ metadata: { ref: 7 } })))
      .toBe("ade --socket apple tap-element --identifier signInButton");
  });
});
