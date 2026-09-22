import { describe, expect, it } from "vitest";
import type { AppleInstalledSimulator } from "../../../shared/types/iosSimulator";
import {
  APPLE_DEVICE_FAMILY_ORDER,
  appleDeviceFamilyFromIdentifier,
  appleDeviceFamilyLabel,
  appleDeviceIdentity,
  appleDeviceModelLabel,
  appleDeviceModelLine,
  groupAppleSimulatorsByFamily,
} from "./appleDeviceFamily";

const T = "com.apple.CoreSimulator.SimDeviceType.";

function sim(overrides: Partial<AppleInstalledSimulator>): AppleInstalledSimulator {
  return {
    udid: "udid",
    name: "iPhone 17 Pro",
    runtime: "iOS 26.2",
    state: "Shutdown",
    isAvailable: true,
    family: "iphone",
    deviceTypeIdentifier: `${T}iPhone-17-Pro`,
    ...overrides,
  };
}

describe("appleDeviceFamilyFromIdentifier", () => {
  it("reads every family Apple ships a simulator for", () => {
    expect(appleDeviceFamilyFromIdentifier(`${T}iPhone-17-Pro`)).toBe("iphone");
    expect(appleDeviceFamilyFromIdentifier(`${T}iPad-Pro-13-inch-M4-8GB`)).toBe("ipad");
    expect(appleDeviceFamilyFromIdentifier(`${T}Apple-Watch-Series-10-46mm`)).toBe("watch");
    expect(appleDeviceFamilyFromIdentifier(`${T}Apple-TV-4K-3rd-generation-1080p`)).toBe("tv");
    expect(appleDeviceFamilyFromIdentifier(`${T}Apple-Vision-Pro`)).toBe("vision");
  });

  it("matches a bare suffix, and nothing at all without one", () => {
    expect(appleDeviceFamilyFromIdentifier("iPad-mini-A17-Pro")).toBe("ipad");
    expect(appleDeviceFamilyFromIdentifier(null)).toBeNull();
    expect(appleDeviceFamilyFromIdentifier("")).toBeNull();
    expect(appleDeviceFamilyFromIdentifier("   ")).toBeNull();
    expect(appleDeviceFamilyFromIdentifier(`${T}iPod-touch--7th-generation-`)).toBeNull();
  });

  it("never reads the user's name: Vision and Watch both start with Apple", () => {
    expect(appleDeviceFamilyFromIdentifier(`${T}Apple-Vision-Pro`)).not.toBe("watch");
    expect(appleDeviceFamilyFromIdentifier(`${T}Apple-Watch-Ultra-2-49mm`)).not.toBe("tv");
  });
});

describe("appleDeviceModelLabel", () => {
  it("spells the model the way Apple writes it", () => {
    expect(appleDeviceModelLabel(`${T}iPhone-17-Pro`)).toBe("iPhone 17 Pro");
    expect(appleDeviceModelLabel(`${T}iPhone-17-Pro-Max`)).toBe("iPhone 17 Pro Max");
    expect(appleDeviceModelLabel(`${T}Apple-Watch-Series-10-46mm`)).toBe("Apple Watch Series 10 46mm");
    expect(appleDeviceModelLabel(`${T}Apple-Vision-Pro`)).toBe("Apple Vision Pro");
  });

  it("keeps Apple's hyphen in a screen size", () => {
    expect(appleDeviceModelLabel(`${T}iPad-Pro-13-inch-M4-8GB`)).toBe("iPad Pro 13-inch M4 8GB");
    expect(appleDeviceModelLabel(`${T}iPad-Pro-11-inch-M4-16GB`)).toBe("iPad Pro 11-inch M4 16GB");
  });

  it("reads Apple's empty segment as a parenthetical", () => {
    expect(appleDeviceModelLabel(`${T}iPod-touch--7th-generation-`)).toBe("iPod touch (7th generation)");
  });

  it("has nothing to say without an identifier", () => {
    expect(appleDeviceModelLabel(null)).toBeNull();
    expect(appleDeviceModelLabel(undefined)).toBeNull();
    expect(appleDeviceModelLabel("")).toBeNull();
  });
});

describe("appleDeviceIdentity", () => {
  it("marks a renamed simulator so the card can show the model", () => {
    const identity = appleDeviceIdentity(sim({ name: "ADE Repro" }));
    expect(identity).toEqual({ family: "iphone", model: "iPhone 17 Pro", renamed: true });
  });

  it("does not repeat a name that is already the model", () => {
    expect(appleDeviceIdentity(sim({ name: "iPhone 17 Pro" })).renamed).toBe(false);
    // Case is the user's business, not a different device.
    expect(appleDeviceIdentity(sim({ name: "iphone 17 pro" })).renamed).toBe(false);
  });

  it("falls back to the service's family when the identifier is missing", () => {
    expect(appleDeviceIdentity(sim({ deviceTypeIdentifier: null, family: "ipad" })).family).toBe("ipad");
    expect(appleDeviceIdentity(sim({ deviceTypeIdentifier: null, family: "watch" })).family).toBe("watch");
    expect(appleDeviceIdentity(sim({ deviceTypeIdentifier: null, family: "iphone" })).model).toBeNull();
  });

  it("puts an unrecognised identifier in Other rather than guessing iPhone", () => {
    expect(appleDeviceIdentity(sim({ deviceTypeIdentifier: `${T}iPod-touch--7th-generation-`, family: "iphone" })).family)
      .toBe("other");
  });
});

describe("appleDeviceModelLine", () => {
  it("is §B2's one-line form", () => {
    expect(appleDeviceModelLine(sim({ name: "ADE Repro" }))).toBe("ADE Repro · iPhone 17 Pro");
    expect(appleDeviceModelLine(sim({ name: "iPhone 17 Pro" }))).toBe("iPhone 17 Pro");
    expect(appleDeviceModelLine(sim({ name: "  ", deviceTypeIdentifier: null }))).toBe("Simulator");
  });
});

describe("groupAppleSimulatorsByFamily", () => {
  it("returns families in §B2's order, and only the ones that exist", () => {
    const groups = groupAppleSimulatorsByFamily([
      sim({ udid: "tv", deviceTypeIdentifier: `${T}Apple-TV-4K-3rd-generation-1080p` }),
      sim({ udid: "phone" }),
      sim({ udid: "vision", deviceTypeIdentifier: `${T}Apple-Vision-Pro` }),
      sim({ udid: "pad", deviceTypeIdentifier: `${T}iPad-Air-11-inch-M3` }),
    ]);
    expect(groups.map((group) => group.family)).toEqual(["iphone", "ipad", "tv", "vision"]);
    expect(groups.map((group) => group.label)).toEqual(["iPhone", "iPad", "Apple TV", "Apple Vision"]);
  });

  it("puts the booted device first inside its family", () => {
    const groups = groupAppleSimulatorsByFamily([
      sim({ udid: "b", name: "Zulu" }),
      sim({ udid: "a", name: "Alpha" }),
      sim({ udid: "boot", name: "Yankee", state: "Booted" }),
    ]);
    expect(groups[0]?.devices.map((device) => device.name)).toEqual(["Yankee", "Alpha", "Zulu"]);
  });

  it("labels every family in the order constant", () => {
    for (const family of APPLE_DEVICE_FAMILY_ORDER) {
      expect(appleDeviceFamilyLabel(family).length).toBeGreaterThan(0);
    }
    expect(appleDeviceFamilyLabel("other")).toBe("Other devices");
  });
});
