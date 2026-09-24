import { describe, expect, it } from "vitest";
import type {
  AppleDeviceDiskUsage,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleSimulatorOwner,
} from "../../../shared/types/iosSimulator";
import {
  appleDefaultTemplateUdid,
  isAppleCloneSource,
  appleDeviceDiskLabel,
  appleLaneOwnedUdid,
  appleOwnerLaneLabel,
  partitionApplePickerDevices,
} from "./applePickerInventory";

function simulator(overrides: Partial<AppleInstalledSimulator> & { udid: string }): AppleInstalledSimulator {
  return {
    name: overrides.name ?? overrides.udid,
    runtime: "iOS 26.3",
    state: "Shutdown",
    isAvailable: true,
    family: "iphone",
    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    ...overrides,
  };
}

function owner(overrides: Partial<AppleSimulatorOwner> & { udid: string; laneId: string }): AppleSimulatorOwner {
  return {
    laneName: null,
    origin: "clone",
    mine: false,
    ...overrides,
  };
}

function laneDevice(udid: string): AppleLaneDevice {
  return {
    laneId: "lane-mine",
    udid,
    name: "ADE · Mine",
    origin: "clone",
    family: "iphone",
    runtime: "iOS 26.3",
    createdAt: "2026-09-21T00:00:00.000Z",
    templateUdid: null,
  };
}

describe("the picker's three groups", () => {
  const installed = [
    simulator({ udid: "free-1", name: "iPhone 17 Pro" }),
    simulator({ udid: "free-2", name: "iPhone Air" }),
    simulator({ udid: "mine-1", name: "ADE · Mine" }),
    simulator({ udid: "theirs-1", name: "ADE Repro" }),
  ];
  const owners = [
    owner({ udid: "mine-1", laneId: "lane-mine", laneName: "Apple env", mine: true }),
    owner({ udid: "theirs-1", laneId: "lane-theirs", laneName: "Repro fix", origin: "attached" }),
  ];

  it("partitions installed devices into mine, available and in-use-elsewhere", () => {
    const partition = partitionApplePickerDevices({
      installed,
      owners,
      laneDevice: laneDevice("mine-1"),
    });

    expect(partition.mine?.udid).toBe("mine-1");
    expect(partition.laneDeviceMissing).toBe(false);
    expect(partition.available.map((entry) => entry.udid)).toEqual(["free-1", "free-2"]);
    expect(partition.elsewhere.map((entry) => entry.simulator.udid)).toEqual(["theirs-1"]);
    expect(partition.elsewhere[0]?.owner.laneName).toBe("Repro fix");
  });

  it("gives a lane with no device an EMPTY mine slot — never a fallback", () => {
    const partition = partitionApplePickerDevices({
      installed,
      owners: [owners[1]!],
      laneDevice: null,
    });

    // The round-5 defect: with no lane device the picker heroed the newest
    // installed iPhone, which reads as "your device" and is not.
    expect(partition.mine).toBeNull();
    expect(partition.laneDeviceMissing).toBe(false);
    expect(partition.available.map((entry) => entry.udid)).toEqual(["free-1", "free-2", "mine-1"]);
  });

  it("says the lane's device is missing rather than that the lane has none", () => {
    const partition = partitionApplePickerDevices({
      installed,
      owners,
      laneDevice: laneDevice("deleted-in-xcode"),
    });

    expect(partition.mine).toBeNull();
    expect(partition.laneDeviceMissing).toBe(true);
    // The lane's own udid is not installed, so nothing is claimed for it.
    expect(partition.available.map((entry) => entry.udid)).toContain("mine-1");
  });

  it("treats everything as free when the host answered no ownership at all", () => {
    const partition = partitionApplePickerDevices({ installed });

    expect(partition.mine).toBeNull();
    expect(partition.elsewhere).toEqual([]);
    expect(partition.available).toHaveLength(4);
  });

  it("falls back to the owners' own mine flag for the lane's udid", () => {
    expect(appleLaneOwnedUdid({ installed, owners })).toBe("mine-1");
    expect(appleLaneOwnedUdid({ installed, owners, laneDevice: laneDevice("row-wins") })).toBe("row-wins");
    expect(appleLaneOwnedUdid({ installed, owners: [owners[1]!] })).toBeNull();
  });
});

describe("disk labels", () => {
  // One measured device of `bytes`, labelled through the public helper.
  const label = (bytes: number) => appleDeviceDiskLabel(
    { totalBytes: bytes, devices: [{ udid: "d", bytes }], root: "/devices", measuredAt: "2026-09-21T00:00:00.000Z" },
    "d",
  );

  it("reads gigabytes to one decimal and smaller units whole", () => {
    expect(label(18 * 1024 ** 3)).toBe("18.0 GB");
    expect(label(3.25 * 1024 ** 3)).toBe("3.3 GB");
    expect(label(612 * 1024 ** 2)).toBe("612 MB");
    expect(label(40 * 1024)).toBe("40 KB");
    expect(label(2 * 1024 ** 4)).toBe("2.0 TB");
    expect(label(12)).toBe("0 KB");
  });

  it("has no label for a number nobody measured", () => {
    expect(label(Number.NaN)).toBeNull();
    expect(label(-1)).toBeNull();
  });

  it("finds one device's row, and says nothing for a device with none", () => {
    const disk: AppleDeviceDiskUsage = {
      totalBytes: 20 * 1024 ** 3,
      devices: [{ udid: "mine-1", bytes: 5 * 1024 ** 3 }],
      root: "/devices",
      measuredAt: "2026-09-21T00:00:00.000Z",
    };
    expect(appleDeviceDiskLabel(disk, "mine-1")).toBe("5.0 GB");
    expect(appleDeviceDiskLabel(disk, "free-1")).toBeNull();
    expect(appleDeviceDiskLabel(null, "mine-1")).toBeNull();
  });
});

describe("naming the lane that holds a device", () => {
  it("uses the display name and never the raw id", () => {
    expect(appleOwnerLaneLabel({ laneName: "Repro fix" })).toBe("lane Repro fix");
    expect(appleOwnerLaneLabel({ laneName: "  " })).toBe("another lane");
    expect(appleOwnerLaneLabel({ laneName: null })).toBe("another lane");
  });
});

describe("the create control's default template", () => {
  it("prefers the project's last used template, then the newest iPhone", () => {
    const installed = [
      simulator({ udid: "pad", name: "iPad Pro", family: "ipad", runtime: "iPadOS 26.4" }),
      simulator({ udid: "old", name: "iPhone 15", runtime: "iOS 18.4" }),
      simulator({ udid: "new", name: "iPhone 17 Pro", runtime: "iOS 26.3" }),
    ];

    expect(appleDefaultTemplateUdid({ installed, lastUsedUdid: "old" })).toBe("old");
    expect(appleDefaultTemplateUdid({ installed, lastUsedUdid: "gone" })).toBe("new");
    expect(appleDefaultTemplateUdid({ installed })).toBe("new");
    expect(appleDefaultTemplateUdid({ installed: [installed[0]!] })).toBe("pad");
    expect(appleDefaultTemplateUdid({ installed: [] })).toBe("");
  });

  it("skips a booted device and another lane's device, which cannot be cloned", () => {
    const installed = [
      simulator({ udid: "booted", name: "iPhone 17 Pro", state: "Booted", runtime: "iOS 26.4" }),
      simulator({ udid: "theirs", name: "ADE Repro", runtime: "iOS 26.4" }),
      simulator({ udid: "free", name: "iPhone Air", runtime: "iOS 26.3" }),
    ];
    const owners = [owner({ udid: "theirs", laneId: "lane-theirs" })];

    expect(appleDefaultTemplateUdid({ installed, owners })).toBe("free");
    // With nothing cloneable left, a default the service can explain beats no
    // default at all.
    expect(appleDefaultTemplateUdid({ installed: [installed[0]!], owners })).toBe("booted");
  });
});

describe("isAppleCloneSource", () => {
  it("rules out a booted device and one another lane holds", () => {
    const held = new Set(["theirs"]);
    expect(isAppleCloneSource(simulator({ udid: "free" }), held)).toBe(true);
    expect(isAppleCloneSource(simulator({ udid: "booted", state: "Booted" }), held)).toBe(false);
    expect(isAppleCloneSource(simulator({ udid: "theirs" }), held)).toBe(false);
  });
});
