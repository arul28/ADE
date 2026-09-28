import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bareSimulatorPowerOff, createSimulatorPower } from "./simulatorPower";
import {
  appleLaneDeviceName,
  createLaneDeviceRegistry,
  type LaneDeviceRegistry,
} from "./laneDeviceRegistry";
import {
  appleDeviceDataRoot,
  appleDeviceFamily,
  appleRuntimeScore,
  parseAppleDeviceDiskUsage,
  pickAppleDeviceSpec,
} from "./appleSimulatorCatalog";
import { endLaneDeviceRow, releaseLaneAppleDevice } from "./laneDeviceRelease";
import { AppleDeviceAttachedNotDeletableError } from "./appleDeviceErrors";
import type { LaneDeviceStore } from "./laneDeviceRows";
import {
  APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE,
  APPLE_DEVICE_EXISTS_CODE,
  APPLE_DEVICE_NOT_LANE_OWNED_CODE,
  APPLE_DEVICE_OWNED_BY_LANE_CODE,
  APPLE_NO_INSTALLED_SIMULATORS_CODE,
  type AppleInstalledSimulator,
  type AppleInstalledRuntime,
} from "../../../shared/types/iosSimulator";
import { type AppleLaneDevice } from "../../../shared/types";
import { createLaneDeviceLifecycle, type LifecycleLaneRuntime } from "./laneDeviceLifecycle";

const noopLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
};

function simulator(overrides: Partial<AppleInstalledSimulator> & { udid: string; name: string }): AppleInstalledSimulator {
  return {
    runtime: "iOS 26.3",
    state: "Shutdown",
    isAvailable: true,
    family: "iphone",
    deviceTypeIdentifier: null,
    ...overrides,
  };
}

const RUNTIMES: AppleInstalledRuntime[] = [{
  identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
  name: "iOS 26.3",
  version: "26.3",
  platform: "iOS",
  deviceTypes: [
    { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", name: "iPhone 17 Pro", family: "iphone" },
    { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11", name: "iPad Pro", family: "ipad" },
  ],
}];

/** An in-memory stand-in for the lanes DB, narrowed to what the registry uses. */
function memoryStore(rows: Record<string, Record<string, unknown>> = {}): LaneDeviceStore & { rows: typeof rows } {
  const kv = new Map<string, unknown>();
  return {
    rows,
    run: (sql, params = []) => {
      if (/^delete from lane_apple_devices/i.test(sql.trim())) {
        delete rows[String(params[0])];
        return;
      }
      if (/^insert into lane_apple_devices/i.test(sql.trim())) {
        const [lane_id, udid, name, origin, family, runtime, created_at, template_udid] = params;
        rows[String(lane_id)] = { lane_id, udid, name, origin, family, runtime, created_at, template_udid };
        return;
      }
      if (/^update lane_apple_devices set ade_installed_bundle_ids/i.test(sql.trim())) {
        const [bundleIds, laneId, udid] = params;
        const current = rows[String(laneId)];
        if (current?.udid === udid) current.ade_installed_bundle_ids = bundleIds;
        return;
      }
      // The takeover's one-statement move. `lane_id` is the table's primary
      // key, so re-keying the row is the move — modelled here by deleting the
      // old key and writing the new one in the same call, which is what SQLite
      // does under the hood.
      if (/^update lane_apple_devices/i.test(sql.trim())) {
        const [lane_id, name, family, runtime, created_at, where_lane_id, where_udid] = params;
        const current = rows[String(where_lane_id)];
        if (!current || current.udid !== where_udid) return;
        delete rows[String(where_lane_id)];
        rows[String(lane_id)] = { ...current, lane_id, name, family, runtime, created_at };
        return;
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    get: (sql, params = []) => {
      if (/select 1 as one from lane_apple_devices/i.test(sql)) {
        return Object.values(rows).some((row) => row.udid === params[0] && row.lane_id !== params[1])
          ? { one: 1 } as never
          : null;
      }
      if (/from lanes/i.test(sql)) return { name: `Lane ${String(params[0])}`, status: "active" } as never;
      return (rows[String(params[0])] ?? null) as never;
    },
    all: () => Object.values(rows) as never,
    getJson: (key) => (kv.get(key) ?? null) as never,
    setJson: (key, value) => { kv.set(key, value); },
  };
}

describe("laneDeviceRegistry pure helpers", () => {
  it("reads the family off the device type before the name", () => {
    // A user can rename a simulator to anything, so "iPad" in a custom name is
    // not evidence; the device-type identifier is.
    expect(appleDeviceFamily({ deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11", name: "Phone rig" })).toBe("ipad");
    expect(appleDeviceFamily({ deviceTypeIdentifier: null, name: "Apple Watch Series 10" })).toBe("watch");
    expect(appleDeviceFamily({ deviceTypeIdentifier: null, name: "iPhone 17 Pro" })).toBe("iphone");
    expect(appleDeviceFamily({ deviceTypeIdentifier: null, name: "" })).toBe("iphone");
  });

  it("orders runtimes numerically, not lexically", () => {
    expect(appleRuntimeScore("iOS 26.3")).toBeGreaterThan(appleRuntimeScore("iOS 9.0"));
    expect(appleRuntimeScore("iOS 18.4")).toBeGreaterThan(appleRuntimeScore("iOS 18.1"));
  });

  it("uses an installed runtime and remembers the last model when it is supported", () => {
    const selected = pickAppleDeviceSpec({ runtimes: RUNTIMES, lastDeviceType: RUNTIMES[0]!.deviceTypes[1]!.identifier });
    expect(selected.runtime.identifier).toBe(RUNTIMES[0]!.identifier);
    expect(selected.deviceType.identifier).toBe(RUNTIMES[0]!.deviceTypes[1]!.identifier);
    expect(pickAppleDeviceSpec({ runtimes: RUNTIMES }).deviceType.family).toBe("iphone");
  });

  it("defaults only to an installed iOS runtime", () => {
    const watchRuntime: AppleInstalledRuntime = {
      ...RUNTIMES[0]!,
      identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-3",
      name: "watchOS 26.3",
      platform: "watchOS",
    };

    expect(pickAppleDeviceSpec({ runtimes: [watchRuntime, ...RUNTIMES] }).runtime.platform).toBe("iOS");
    expect(() => pickAppleDeviceSpec({ runtimes: [watchRuntime] })).toThrowError(
      expect.objectContaining({ code: APPLE_NO_INSTALLED_SIMULATORS_CODE }),
    );
  });

  it("names a lane device and suffixes a collision", () => {
    expect(appleLaneDeviceName({ laneId: "abc12345def", laneName: "Apple env" })).toBe("ADE · Apple env");
    expect(appleLaneDeviceName({ laneId: "abc12345def" })).toBe("ADE · abc12345");
    expect(appleLaneDeviceName({ laneId: "x", laneName: "A", taken: ["ADE · A"] })).toBe("ADE · A (2)");
    expect(appleLaneDeviceName({ laneId: "x", laneName: "A", requested: "Mine" })).toBe("Mine");
  });
});

describe("laneDeviceRegistry device lifecycle", () => {
  const installed = [simulator({ udid: "template-1", name: "iPhone 17 Pro" })];

  function registryWith(run: ReturnType<typeof vi.fn>, store = memoryStore()) {
    return {
      store,
      registry: createLaneDeviceRegistry({
        run: run as never,
        powerOffDevice: bareSimulatorPowerOff(run as never),
        listInstalledSimulators: async () => installed,
        listInstalledRuntimes: async () => RUNTIMES,
        store,
        logger: noopLogger,
      }),
    };
  }

  it("creates an empty device from an installed runtime and remembers its model", async () => {
    const run = vi.fn(async () => ({ stdout: "created-udid\n", stderr: "" }));
    const { registry, store } = registryWith(run);

    const device = await registry.deviceCreate({ laneId: "lane-1" });

    expect(run).toHaveBeenCalledWith("xcrun", ["simctl", "create", "ADE · Lane lane-1", RUNTIMES[0]!.deviceTypes[0]!.identifier, RUNTIMES[0]!.identifier], expect.anything());
    expect(device).toMatchObject({ udid: "created-udid", origin: "created", family: "iphone", runtime: "iOS 26.3" });
    expect(store.rows["lane-1"]).toMatchObject({ udid: "created-udid" });
    expect(store.getJson("apple:last-device-type")).toBe(RUNTIMES[0]!.deviceTypes[0]!.identifier);

    await expect(registry.deviceCreate({ laneId: "lane-1" })).rejects.toMatchObject({
      code: APPLE_DEVICE_EXISTS_CODE,
    });
  });

  it("refuses rather than downloading a runtime when none is installed", async () => {
    // `simctl` will happily fetch several gigabytes for a runtime it merely
    // knows about. A lane asking for a device must never start that.
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const registry = createLaneDeviceRegistry({
      run: run as never,
      powerOffDevice: bareSimulatorPowerOff(run as never),
      listInstalledSimulators: async () => [],
      listInstalledRuntimes: async () => [],
      store: memoryStore(),
      logger: noopLogger,
    });

    await expect(registry.deviceCreate({ laneId: "lane-1" })).rejects.toMatchObject({
      code: APPLE_NO_INSTALLED_SIMULATORS_CODE,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps existing bindings when simctl cannot provide a device list", async () => {
    const run = vi.fn(async () => { throw new Error("CoreSimulator unavailable"); });
    const store = memoryStore({
      "lane-1": {
        lane_id: "lane-1",
        udid: "owned-device",
        name: "ADE · Lane 1",
        origin: "created",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: new Date().toISOString(),
      },
    });
    const { registry } = registryWith(run, store);

    const result = await registry.reconcile();

    expect(result.errors).toHaveLength(1);
    expect(result.deleted).toEqual([]);
    expect(registry.get("lane-1")?.udid).toBe("owned-device");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps another project's held device, refuses attach, and removes a device whose project is gone", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-apple-markers-"));
    const dataRoot = path.join(root, "devices");
    const currentProject = path.join(root, "current");
    const foreignProject = path.join(root, "foreign");
    const marker = (projectRoot: string, laneId: string) => ({
      version: 1,
      projectRoot,
      laneId,
      name: `ADE · ${laneId}`,
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const placeMarker = (udid: string, value: object) => {
      const directory = path.join(dataRoot, udid);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "ade-lane-device.json"), JSON.stringify(value));
    };
    fs.mkdirSync(path.join(foreignProject, ".ade"), { recursive: true });
    fs.writeFileSync(path.join(foreignProject, ".ade", "ade.db"), "");
    const heldUdid = "00000000-0000-4000-8000-000000000001";
    const goneUdid = "00000000-0000-4000-8000-000000000002";
    placeMarker(heldUdid, marker(foreignProject, "foreign-lane"));
    placeMarker(goneUdid, marker(path.join(root, "gone"), "old-lane"));
    const devices = [heldUdid, goneUdid].map((udid) =>
      simulator({ udid, name: `ADE · ${udid}` }),
    );
    const listJson = JSON.stringify({
      devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-3": devices },
    });
    const run = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args.join(" ") === "simctl list devices --json" ? listJson : "",
      stderr: "",
    }));
    const ownedRegistry = createLaneDeviceRegistry({
      run: run as never,
      powerOffDevice: bareSimulatorPowerOff(run as never),
      listInstalledSimulators: async () => devices,
      projectRoot: currentProject,
      deviceDataRoot: dataRoot,
      openProjectDatabase: () => ({ prepare: () => ({ get: () => ({ one: 1 }) }), close: () => {} }),
      store: memoryStore(),
      now: () => new Date(),
      logger: noopLogger,
    });

    try {
      const result = await ownedRegistry.reconcile();
      await expect(ownedRegistry.deviceAttach({ laneId: "lane-current", simulator: heldUdid }))
        .rejects.toMatchObject({ code: APPLE_DEVICE_NOT_LANE_OWNED_CODE });
      expect(result.deleted.map((entry) => entry.udid)).toEqual([goneUdid]);
      expect(run.mock.calls.some((call) => call[1].join(" ").includes(`delete ${heldUdid}`))).toBe(false);
      expect(run.mock.calls.some((call) => call[1].join(" ").includes(`delete ${goneUdid}`))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes over a free marked device from another project as an ADE-owned lane device", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-apple-takeover-"));
    const dataRoot = path.join(root, "devices");
    const currentProject = path.join(root, "current");
    const foreignProject = path.join(root, "foreign");
    const udid = "free-foreign-device";
    const deviceDir = path.join(dataRoot, udid);
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.mkdirSync(path.join(foreignProject, ".ade"), { recursive: true });
    fs.writeFileSync(path.join(foreignProject, ".ade", "ade.db"), "");
    fs.writeFileSync(path.join(deviceDir, "ade-lane-device.json"), JSON.stringify({
      version: 1,
      projectRoot: foreignProject,
      laneId: "old-lane",
      name: "ADE · Old lane",
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }));
    const installed = [simulator({ udid, name: "ADE · Old lane" })];
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const registry = createLaneDeviceRegistry({
      run: run as never,
      powerOffDevice: bareSimulatorPowerOff(run as never),
      listInstalledSimulators: async () => installed,
      projectRoot: currentProject,
      deviceDataRoot: dataRoot,
      openProjectDatabase: () => ({ prepare: () => ({ get: () => null }), close: () => {} }),
      store: memoryStore(),
      logger: noopLogger,
    });

    try {
      const device = await registry.deviceAttach({ laneId: "lane-current", simulator: udid });
      const transferredMarker = JSON.parse(fs.readFileSync(path.join(deviceDir, "ade-lane-device.json"), "utf8")) as { projectRoot: string; laneId: string };
      expect(device).toMatchObject({ laneId: "lane-current", udid, origin: "created" });
      expect(transferredMarker).toMatchObject({ projectRoot: currentProject, laneId: "lane-current" });
      expect(registry.get("lane-current")?.origin).toBe("created");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("attaches without cloning and never deletes what it attached", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const { registry, store } = registryWith(run);

    const device = await registry.deviceAttach({ laneId: "lane-1", simulator: "iPhone 17 Pro" });
    expect(device).toMatchObject({ udid: "template-1", origin: "attached" });
    expect(run).not.toHaveBeenCalled();

    await expect(registry.deviceDelete({ laneId: "lane-1" })).rejects.toMatchObject({
      code: APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE,
    });
    // Detaching is `deviceDetach`. Nothing here runs `simctl delete` on a
    // device ADE did not create.
    expect(store.rows["lane-1"]).toBeDefined();
    await registry.deviceDetach({ laneId: "lane-1" });
    expect(store.rows["lane-1"]).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("detaches a created device without deleting it or touching its power", async () => {
    const run = vi.fn(async (..._call: unknown[]) => ({ stdout: "clone-udid\n", stderr: "" }));
    const { registry, store } = registryWith(run);
    await registry.deviceCreate({ laneId: "lane-1" });
    run.mockClear();

    const detached = await registry.deviceDetach({ laneId: "lane-1" });

    expect(detached).toMatchObject({ udid: "clone-udid", origin: "created", laneId: "lane-1" });
    expect(store.rows["lane-1"]).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    await expect(registry.deviceDetach({ laneId: "lane-1" })).resolves.toBeNull();
  });

  it("shuts a clone down before deleting it", async () => {
    // `simctl delete` on a booted device leaves CoreSimulator holding the data
    // directory and reports success having removed nothing.
    const run = vi.fn(async (..._call: unknown[]) => ({ stdout: "clone-udid\n", stderr: "" }));
    const { registry } = registryWith(run);
    await registry.deviceCreate({ laneId: "lane-1" });
    run.mockClear();

    await registry.deviceDelete({ laneId: "lane-1" });

    expect(run.mock.calls.map((call) => (call[1] as string[]).slice(0, 2))).toEqual([
      ["simctl", "shutdown"],
      ["simctl", "delete"],
    ]);
  });

  type Registry = ReturnType<typeof registryWith>["registry"];
  it.each([
    ["cloned", (registry: Registry) => registry.deviceCreate({ laneId: "lane-1" })],
    ["attached", (registry: Registry) => registry.deviceAttach({ laneId: "lane-1", simulator: "iPhone 17 Pro" })],
  ] as const)(
    "ignores a stale device ID when deleting a lane's %s device",
    async (_label, giveLaneADevice) => {
      const run = vi.fn(async (..._call: unknown[]) => ({ stdout: "clone-udid\n", stderr: "" }));
      const { registry, store } = registryWith(run);
      await giveLaneADevice(registry);
      const before = store.rows["lane-1"] ? { ...store.rows["lane-1"] } : undefined;
      run.mockClear();

      await registry.deviceDelete({ laneId: "lane-1", udid: "some-older-clone" });

      expect(run).not.toHaveBeenCalled();
      expect(store.rows["lane-1"]).toEqual(before);
      expect(before).toBeTruthy();
    },
  );

  it("refuses a requested runtime that is not installed", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const { registry } = registryWith(run);
    await expect(registry.deviceCreate({ laneId: "lane-1", runtime: "iOS 19" })).rejects.toThrow(/not installed/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("a takeover ends EVERY stale binding, not just the first", async () => {
    // On the owner's machine ADE Repro was bound to two lanes at once — a
    // state this file is supposed to make impossible, from before the move was
    // atomic. `rebind` moves one row, so a takeover moved one and left the
    // other, and the duplicate survived the operation meant to end it.
    const run = vi.fn(async (..._call: unknown[]) => ({ stdout: "", stderr: "" }));
    const { registry, store } = registryWith(run);
    store.rows["lane-a"] = {
      lane_id: "lane-a",
      udid: "template-1",
      name: "Shared",
      origin: "attached",
      family: "iphone",
      runtime: "iOS 26.3",
      created_at: "2026-09-20T00:00:00.000Z",
      template_udid: null,
    };
    store.rows["lane-b"] = { ...store.rows["lane-a"], lane_id: "lane-b" };

    await registry.deviceAttach({ laneId: "lane-c", simulator: "template-1" });

    expect(registry.list().filter((device) => device.udid === "template-1").map((d) => d.laneId))
      .toEqual(["lane-c"]);
    expect(store.rows["lane-a"]).toBeUndefined();
    expect(store.rows["lane-b"]).toBeUndefined();
  });

  it("deletes an installed simulator no lane holds, shutting it down first", async () => {
    const run = vi.fn(async (..._call: unknown[]) => ({ stdout: "", stderr: "" }));
    const { registry } = registryWith(run);

    await registry.deviceDeleteInstalled({ udid: "template-1" });

    expect(run.mock.calls.map((call) => (call[1] as string[]).slice(0, 3))).toEqual([
      ["simctl", "shutdown", "template-1"],
      ["simctl", "delete", "template-1"],
    ]);
  });

  it("refuses to delete a simulator a lane holds, and runs no simctl at all", async () => {
    // The picker renders these as TAKEN with no menu, but the guard belongs
    // here: a CLI caller and a stale renderer reach the same method, and the
    // cost of getting it wrong is another lane's live view vanishing.
    const run = vi.fn(async () => ({ stdout: "clone-udid\n", stderr: "" }));
    const { registry } = registryWith(run);
    const device = await registry.deviceCreate({ laneId: "lane-1" });
    run.mockClear();

    await expect(registry.deviceDeleteInstalled({ udid: device.udid })).rejects.toMatchObject({
      code: APPLE_DEVICE_OWNED_BY_LANE_CODE,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("creates on first ask and returns the same device after", async () => {
    const run = vi.fn(async () => ({ stdout: "clone-udid\n", stderr: "" }));
    const { registry } = registryWith(run);

    const first = await registry.ensure({ laneId: "lane-1" });
    const second = await registry.ensure({ laneId: "lane-1" });

    expect(second).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("releaseLaneAppleDevice", () => {
  it("does not delete an ADE device if another lane binds it during power-off", async () => {
    const store = memoryStore({
      "lane-1": {
        lane_id: "lane-1",
        udid: "ade-device",
        name: "ADE · Lane 1",
        origin: "created",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: new Date().toISOString(),
      },
    });
    const run = vi.fn(async (_command: string, _args: string[]) => ({ stdout: "", stderr: "" }));
    const powerOff = vi.fn(async () => {
      store.rows["lane-2"] = {
        lane_id: "lane-2",
        udid: "ade-device",
        name: "ADE · Lane 1",
        origin: "created",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: new Date().toISOString(),
      };
      return true;
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    try {
      const ended = await endLaneDeviceRow({ store, laneId: "lane-1", run: run as never, powerOff, logger: noopLogger });

      expect(ended).toMatchObject({ deleted: false, complete: true });
      expect(run.mock.calls.some((call) => call[1][1] === "delete")).toBe(false);
      expect(store.rows["lane-1"]).toBeUndefined();
      expect(store.rows["lane-2"]?.udid).toBe("ade-device");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("stops an ended lane's app cleanup when another lane attaches the same device", async () => {
    const store = memoryStore({
      "lane-1": {
        lane_id: "lane-1",
        udid: "users-own",
        name: "iPhone 17 Pro",
        origin: "attached",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: new Date().toISOString(),
        ade_installed_bundle_ids: JSON.stringify(["com.example.app"]),
      },
    });
    const run = vi.fn(async (_command: string, commandArgs: string[]) => {
      if (commandArgs[0] === "simctl" && commandArgs[1] === "list") {
        store.rows["lane-2"] = {
          lane_id: "lane-2",
          udid: "users-own",
          name: "iPhone 17 Pro",
          origin: "attached",
          family: "iphone",
          runtime: "iOS 26.3",
          created_at: new Date().toISOString(),
        };
        return {
          stdout: JSON.stringify({
            devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [{ udid: "users-own", name: "iPhone 17 Pro", state: "Booted" }] },
          }),
          stderr: "",
        };
      }
      return { stdout: "/sim/app", stderr: "" };
    });
    const powerOff = vi.fn(async () => true);
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    try {
      const ended = await endLaneDeviceRow({ store, laneId: "lane-1", run: run as never, powerOff, logger: noopLogger });

      expect(ended).toMatchObject({ complete: false, device: { udid: "users-own" } });
      expect(run.mock.calls.some((call) => call[1][1] === "uninstall")).toBe(false);
      expect(powerOff).not.toHaveBeenCalled();
      expect(store.rows["lane-1"]?.ade_installed_bundle_ids).toBe(JSON.stringify(["com.example.app"]));
      expect(store.rows["lane-2"]?.udid).toBe("users-own");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("retries an attached-device app uninstall once, then drops the ended lane row without changing power", async () => {
    const store = memoryStore({
      "lane-1": {
        lane_id: "lane-1",
        udid: "users-own",
        name: "iPhone 17 Pro",
        origin: "attached",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: new Date().toISOString(),
        ade_installed_bundle_ids: JSON.stringify(["com.example.app"]),
      },
    });
    const run = vi.fn(async (_command: string, commandArgs: string[]) => {
      if (commandArgs[0] === "simctl" && commandArgs[1] === "list") {
        return {
          stdout: JSON.stringify({
            devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [{ udid: "users-own", name: "iPhone 17 Pro", state: "Booted" }] },
          }),
          stderr: "",
        };
      }
      if (commandArgs[0] === "simctl" && commandArgs[1] === "uninstall") throw new Error("uninstall did not finish");
      if (commandArgs[0] === "simctl" && commandArgs[1] === "get_app_container") return { stdout: "/sim/app", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    try {
      const first = await endLaneDeviceRow({
        store,
        laneId: "lane-1",
        run: run as never,
        powerOff: async () => true,
        logger: noopLogger,
      });
      expect(first).toMatchObject({ complete: false, device: { udid: "users-own" } });
      expect(store.rows["lane-1"]?.ade_installed_bundle_ids).toBe(JSON.stringify(["com.example.app"]));

      const retry = await endLaneDeviceRow({
        store,
        laneId: "lane-1",
        run: run as never,
        powerOff: async () => true,
        retry: true,
        logger: noopLogger,
      });

      expect(retry).toMatchObject({ complete: true, device: { udid: "users-own" } });
      expect(store.rows["lane-1"]).toBeUndefined();
      expect(run.mock.calls.filter((call) => call[1][1] === "uninstall")).toHaveLength(2);
      expect(run.mock.calls.filter((call) => call[1][1] === "shutdown")).toHaveLength(0);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("deletes a clone, removes the recordings, and never throws", async () => {
    const store = memoryStore({
      "lane-1": {
        lane_id: "lane-1",
        udid: "clone-udid",
        name: "ADE · A",
        origin: "created",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: new Date().toISOString(),
        template_udid: "template-1",
      },
    });
    const removed: string[] = [];
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));

    try {
      const result = await releaseLaneAppleDevice({
        laneId: "lane-1",
        projectRoot: "/repo",
        store,
        run: run as never,
        removeDirectory: async (directory) => { removed.push(directory); },
        logger: noopLogger,
      });

      expect(result.deletedUdid).toBe("clone-udid");
      expect(removed).toEqual([path.join("/repo", ".ade", "artifacts", "apple-recordings", "lane-1")]);
      expect(store.rows["lane-1"]).toBeUndefined();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("only detaches an attached device, and survives a simctl failure", async () => {
    const store = memoryStore({
      "lane-1": {
        lane_id: "lane-1",
        udid: "users-own",
        name: "iPhone 17 Pro",
        origin: "attached",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: new Date().toISOString(),
        template_udid: null,
      },
    });
    const run = vi.fn(async (_command: string, _args: string[]) => { throw new Error("simctl exploded"); });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    try {
      const result = await releaseLaneAppleDevice({
        laneId: "lane-1",
        projectRoot: "/repo",
        store,
        run: run as never,
        // A lane delete that has already removed the worktree must not abort
        // because cleanup failed.
        removeDirectory: async () => { throw new Error("EACCES"); },
        logger: noopLogger,
      });

      expect(result).toEqual({ deletedUdid: null, detachedUdid: "users-own", removedRecordings: false, removedDerivedData: 0 });
      expect(run.mock.calls.map((call) => call[1].slice(0, 2))).toEqual([["simctl", "shutdown"]]);
      expect(store.rows["lane-1"]).toBeUndefined();
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe("laneDeviceRegistry deviceList ownership and disk", () => {
  const installed = [
    simulator({ udid: "free-1", name: "iPhone 17 Pro" }),
    simulator({ udid: "mine-1", name: "ADE · Mine" }),
    simulator({ udid: "theirs-1", name: "ADE Repro" }),
  ];

  function listRegistry(run: ReturnType<typeof vi.fn> = vi.fn(async () => ({ stdout: "", stderr: "" }))) {
    const store = memoryStore({
      "lane-mine": {
        lane_id: "lane-mine",
        udid: "mine-1",
        name: "ADE · Mine",
        origin: "created",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: "2026-09-21T00:00:00.000Z",
        template_udid: "free-1",
      },
      "lane-theirs": {
        lane_id: "lane-theirs",
        udid: "theirs-1",
        name: "ADE Repro",
        origin: "attached",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: "2026-09-21T00:00:00.000Z",
        template_udid: null,
      },
    });
    return {
      run,
      store,
      registry: createLaneDeviceRegistry({
        run: run as never,
        powerOffDevice: bareSimulatorPowerOff(run as never),
        listInstalledSimulators: async () => installed,
        store,
        deviceDataRoot: "/devices",
        logger: noopLogger,
      }),
    };
  }

  it("reports every lane's binding with the owning lane's NAME, mine flagged", async () => {
    const { registry } = listRegistry();

    const listed = await registry.deviceList({ laneId: "lane-mine", installed: true });

    expect(listed.laneId).toBe("lane-mine");
    expect(listed.lane?.udid).toBe("mine-1");
    // The renderer partitions on this: a payload that carried only the caller's
    // lane is how the picker offered Open on another lane's device.
    expect(listed.owners).toEqual([
      {
        udid: "mine-1",
        laneId: "lane-mine",
        laneName: "Lane lane-mine",
        origin: "created",
        mine: true,
      },
      {
        udid: "theirs-1",
        laneId: "lane-theirs",
        laneName: "Lane lane-theirs",
        origin: "attached",
        mine: false,
      },
    ]);
  });

  it("flags nothing as mine for an un-laned caller, and still names the owners", async () => {
    const { registry } = listRegistry();

    const listed = await registry.deviceList({ installed: true });

    expect(listed.laneId).toBeNull();
    expect(listed.lane).toBeNull();
    expect(listed.owners.every((owner) => owner.mine === false)).toBe(true);
    expect(listed.owners.map((owner) => owner.udid)).toEqual(["mine-1", "theirs-1"]);
  });

  it("measures disk only when asked, in one depth-1 pass, and caches it", async () => {
    const run = vi.fn(async () => ({
      stdout: [
        "3145728\t/devices/8A3E9C11-0F42-4E77-9B21-6D5C1A8F0E33",
        "1048576\t/devices/1B2C3D4E-5F60-7182-93A4-B5C6D7E8F901",
        "8\t/devices/.DS_Store",
        "5242880\t/devices",
      ].join("\n"),
      stderr: "",
    }));
    const { registry } = listRegistry(run);

    const cheap = await registry.deviceList({ laneId: "lane-mine", installed: true });
    expect(cheap.disk ?? null).toBeNull();
    expect(run).not.toHaveBeenCalled();

    const measured = await registry.deviceList({ laneId: "lane-mine", installed: false, disk: true });
    expect(run).toHaveBeenCalledWith("du", ["-d", "1", "-k", "/devices"], expect.anything());
    expect(measured.disk?.root).toBe("/devices");
    expect(measured.disk?.totalBytes).toBe(5_242_880 * 1024);
    expect(measured.disk?.devices).toEqual([
      { udid: "8A3E9C11-0F42-4E77-9B21-6D5C1A8F0E33", bytes: 3_145_728 * 1024 },
      { udid: "1B2C3D4E-5F60-7182-93A4-B5C6D7E8F901", bytes: 1_048_576 * 1024 },
    ]);

    // A second ask inside the cache window must not walk the filesystem again:
    // the pane re-lists on every device event.
    await registry.deviceList({ laneId: "lane-mine", disk: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("answers an unknown number rather than failing the list when du cannot run", async () => {
    const run = vi.fn(async () => { throw new Error("du: permission denied"); });
    const { registry } = listRegistry(run);

    const listed = await registry.deviceList({ laneId: "lane-mine", installed: true, disk: true });

    expect(listed.disk).toBeNull();
    expect(listed.installed).toHaveLength(3);
  });
});

describe("apple device disk parsing", () => {
  it("names CoreSimulator's device store under the home directory", () => {
    expect(appleDeviceDataRoot("/Users/x")).toBe("/Users/x/Library/Developer/CoreSimulator/Devices");
  });

  it("splits du's depth-1 output into per-device rows and the store's total", () => {
    const parsed = parseAppleDeviceDiskUsage({
      root: "/devices/",
      stdout: [
        "2048\t/devices/8A3E9C11-0F42-4E77-9B21-6D5C1A8F0E33",
        "1024\t/devices/1B2C3D4E-5F60-7182-93A4-B5C6D7E8F901/data",
        "16\t/devices/.DS_Store",
        "4096\t/devices",
        "nonsense",
      ].join("\n"),
    });

    // Only udid-shaped direct children become rows; the nested `data` path is
    // not a device and `.DS_Store` is disk with no device to attribute it to.
    expect(parsed.devices).toEqual([{ udid: "8A3E9C11-0F42-4E77-9B21-6D5C1A8F0E33", bytes: 2048 * 1024 }]);
    expect(parsed.totalBytes).toBe(4096 * 1024);
  });

  it("falls back to the sum of the children when du never prints the root", () => {
    const parsed = parseAppleDeviceDiskUsage({
      root: "/devices",
      stdout: [
        "100\t/devices/8A3E9C11-0F42-4E77-9B21-6D5C1A8F0E33",
        "200\t/devices/1B2C3D4E-5F60-7182-93A4-B5C6D7E8F901",
      ].join("\n"),
    });

    expect(parsed.totalBytes).toBe(300 * 1024);
    expect(parsed.devices).toHaveLength(2);
  });
});

describe("laneDeviceRegistry takeover: one lane owns a device at a time", () => {
  const installed = [
    simulator({ udid: "repro", name: "ADE Repro" }),
    simulator({ udid: "free", name: "iPhone Air" }),
    // Booted by someone else, e.g. an `xcodebuild test` run; no lane holds it.
    simulator({ udid: "busy", name: "iPhone 17 Pro", state: "Booted" }),
  ];

  function takeoverRegistry(overrides: Partial<{ releaseLaneDevice: (device: unknown) => void }> = {}) {
    const store = memoryStore({
      "lane-a": {
        lane_id: "lane-a",
        udid: "repro",
        name: "ADE Repro",
    // Legacy rows keep their origin while ownership moves.
        origin: "clone",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: "2026-09-01T00:00:00.000Z",
        template_udid: null,
      },
    });
    const released: unknown[] = [];
    const registry = createLaneDeviceRegistry({
      run: (async () => ({ stdout: "", stderr: "" })) as never,
      powerOffDevice: async () => true,
      listInstalledSimulators: async () => installed,
      store,
      logger: noopLogger,
      releaseLaneDevice: (device) => {
        // Captured DURING the release, so the assertion below proves the old
        // lane still owned the row when its stream was told to stop.
        released.push({ device, ownerAtRelease: store.rows["lane-a"]?.lane_id ?? null });
        overrides.releaseLaneDevice?.(device);
      },
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    return { registry, store, released };
  }

  it("MOVES the binding: the old lane loses it, the new lane gains it, no row left behind", async () => {
    const { registry, store } = takeoverRegistry();

    const device = await registry.deviceAttach({ laneId: "lane-b", simulator: "repro" });

    expect(device.laneId).toBe("lane-b");
    expect(registry.get("lane-b")?.udid).toBe("repro");
    // The defect this test exists for: before the move, lane-a kept its row
    // and two lanes each believed they owned one simulator — either could
    // power it off or delete it under the other.
    expect(registry.get("lane-a")).toBeNull();
    expect(Object.keys(store.rows)).toEqual(["lane-b"]);
    expect(registry.list().map((entry) => entry.laneId)).toEqual(["lane-b"]);
    expect(registry.list()).toHaveLength(1);
  });

  it("carries the device's provenance and re-dates the binding", async () => {
    const { registry } = takeoverRegistry();

    const device = await registry.deviceAttach({ laneId: "lane-b", simulator: "ADE Repro" });

    expect(device.origin).toBe("clone");
    // `createdAt` dates the BINDING, which is new.
    expect(device.createdAt).toBe("2026-09-22T12:00:00.000Z");
  });

  it("releases the losing lane before the row moves", async () => {
    const { registry, released } = takeoverRegistry();

    await registry.deviceAttach({ laneId: "lane-b", simulator: "repro" });

    expect(released).toEqual([
      {
        device: expect.objectContaining({ laneId: "lane-a", udid: "repro" }),
        ownerAtRelease: "lane-a",
      },
    ]);
  });

  it("moves the binding even when the release fails", async () => {
    const { registry, store } = takeoverRegistry({
      releaseLaneDevice: () => { throw new Error("stream will not stop"); },
    });

    const device = await registry.deviceAttach({ laneId: "lane-b", simulator: "repro" });

    expect(device.laneId).toBe("lane-b");
    expect(Object.keys(store.rows)).toEqual(["lane-b"]);
  });

  it("answers an attach of the device this lane already holds, and moves nothing", async () => {
    const { registry, released } = takeoverRegistry();

    for (const wanted of ["repro", "ADE Repro", "ade repro"]) {
      const device = await registry.deviceAttach({ laneId: "lane-a", simulator: wanted });
      expect(device).toMatchObject({ laneId: "lane-a", udid: "repro", createdAt: "2026-09-01T00:00:00.000Z" });
    }
    expect(released).toEqual([]);
  });

  it("still refuses a SECOND device for a lane that already has one", async () => {
    const { registry, store } = takeoverRegistry();

    await expect(registry.deviceAttach({ laneId: "lane-a", simulator: "free" })).rejects.toMatchObject({
      code: APPLE_DEVICE_EXISTS_CODE,
    });
    expect(store.rows["lane-a"]).toMatchObject({ udid: "repro" });
  });

  it("is a plain attach when no lane owns the device", async () => {
    const { registry, store, released } = takeoverRegistry();

    const device = await registry.deviceAttach({ laneId: "lane-b", simulator: "free" });

    expect(device).toMatchObject({ laneId: "lane-b", udid: "free", origin: "attached" });
    expect(released).toEqual([]);
    expect(Object.keys(store.rows).sort()).toEqual(["lane-a", "lane-b"]);
  });

  it.each([
    ["another lane's device", "repro", /ADE Repro \(repro\) belongs to lane Lane lane-a\./],
  ])("refuses an agent attach of %s, and binds and releases nothing", async (_label, wanted, message) => {
    const { registry, store, released } = takeoverRegistry();

    const refusal = registry.deviceAttach({ laneId: "lane-b", simulator: wanted, agentCaller: true });

    await expect(refusal).rejects.toMatchObject({ code: APPLE_DEVICE_NOT_LANE_OWNED_CODE });
    await expect(refusal).rejects.toThrow(message);
    await expect(refusal).rejects.toThrow(/ade apple device-create/);
    expect(Object.keys(store.rows)).toEqual(["lane-a"]);
    expect(store.rows["lane-a"]).toMatchObject({ udid: "repro" });
    expect(released).toEqual([]);
  });

  it.each([["busy", "Booted"], ["free", "Shutdown"]] as const)(
    "lets an agent attach a named simulator no lane holds, including %s",
    async (udid, _state) => {
      const { registry, store } = takeoverRegistry();
      const device = await registry.deviceAttach({ laneId: "lane-b", simulator: udid, agentCaller: true });
      expect(device).toMatchObject({ laneId: "lane-b", udid, origin: "attached" });
      expect(store.rows["lane-b"]).toMatchObject({ udid });
      expect(registry.list().filter((row) => row.udid === udid)).toHaveLength(1);
    },
  );

  it("lets an agent attach the device its lane already holds", async () => {
    const { registry } = takeoverRegistry();

    const device = await registry.deviceAttach({ laneId: "lane-a", simulator: "repro", agentCaller: true });

    expect(device).toMatchObject({ laneId: "lane-a", udid: "repro" });
  });

  it("moves the binding in hosts with no database, too", async () => {
    const released: string[] = [];
    const registry = createLaneDeviceRegistry({
      run: (async () => ({ stdout: "", stderr: "" })) as never,
      powerOffDevice: async () => true,
      listInstalledSimulators: async () => installed,
      logger: noopLogger,
      releaseLaneDevice: (device) => { released.push(device.laneId); },
    });

    await registry.deviceAttach({ laneId: "lane-a", simulator: "repro" });
    await registry.deviceAttach({ laneId: "lane-b", simulator: "repro" });

    expect(registry.get("lane-a")).toBeNull();
    expect(registry.get("lane-b")?.udid).toBe("repro");
    expect(registry.list()).toHaveLength(1);
    expect(released).toEqual(["lane-a"]);
  });
});

describe("simulator power", () => {
  /** Every step in the order it ran, as one readable line each. */
  function harness(options: { bootError?: string; shutdownError?: string } = {}) {
    const steps: string[] = [];
    const power = createSimulatorPower({
      run: async (file, args) => {
        steps.push(`${file} ${args.join(" ")}`);
        if (args[1] === "boot" && options.bootError) throw new Error(options.bootError);
        if (args[1] === "shutdown" && options.shutdownError) throw new Error(options.shutdownError);
        return { stdout: "", stderr: "" };
      },
      waitForBootStatus: async (device) => {
        steps.push(`bootstatus ${device.udid}`);
      },
      invalidateDeviceList: () => {
        steps.push("invalidate");
      },
      resetHelperDevice: async (udid, reason) => {
        steps.push(`reset ${udid} ${reason}`);
      },
      stopDeviceRecording: async (udid, reason) => {
        steps.push(`stop-recording ${udid} ${reason}`);
      },
    });
    return { power, steps };
  }

  const device = { udid: "D1", name: "iPhone 17", state: "Shutdown" };

  describe("simulatorPower", () => {
    it("boots, waits for bootstatus, then drops the device list and the helper session", async () => {
      const { power, steps } = harness();

      await expect(power.bootDevice(device)).resolves.toBe(true);

      expect(steps).toEqual(["xcrun simctl boot D1", "bootstatus D1", "invalidate", "reset D1 boot"]);
    });

    it("only waits for a device that is already booted, and keeps its helper session", async () => {
      const { power, steps } = harness();

      await expect(power.bootDevice({ ...device, state: "Booted" })).resolves.toBe(false);

      expect(steps).toEqual(["bootstatus D1"]);
    });

    it("treats simctl's already-booted refusal as a device someone else booted", async () => {
      const { power, steps } = harness({ bootError: "Unable to boot device in current state: Booted" });

      await expect(power.bootDevice(device)).resolves.toBe(false);

      expect(steps).toEqual(["xcrun simctl boot D1", "bootstatus D1"]);
    });

    it("stops the recording and resets the helper before it powers off, then drops the device list", async () => {
      const { power, steps } = harness();

      await expect(power.powerOffDevice("D1", "hub-power")).resolves.toBe(true);

      expect(steps).toEqual([
        "stop-recording D1 device-off",
        "reset D1 hub-power",
        "xcrun simctl shutdown D1",
        "invalidate",
      ]);
    });

    it("answers false for a device that is already off, and throws any other failure", async () => {
      const off = harness({ shutdownError: "Unable to shutdown device in current state: Shutdown" });
      await expect(off.power.powerOffDevice("D1", "power-off")).resolves.toBe(false);

      const broken = harness({ shutdownError: "CoreSimulator is not responding" });
      await expect(broken.power.powerOffDevice("D1", "power-off")).rejects.toThrow(/not responding/);
      // The cached list is dropped either way.
      expect(broken.steps.at(-1)).toBe("invalidate");
    });
  });
});

describe("lane device lifecycle", () => {
  const device: AppleLaneDevice = {
    laneId: "lane-b",
    udid: "device-clone",
    name: "ADE · lane-b",
    origin: "clone",
    family: "iphone",
    runtime: "iOS 26.3",
    createdAt: "2026-09-23T00:00:00.000Z",
  };

  function setup(initialOwner: string | null) {
    let owner = initialOwner;
    let bound: AppleLaneDevice | null = device;
    // The service's queue: one step at a time per lane.
    let queue: Promise<unknown> = Promise.resolve();
    const serializeDeviceLifecycle = <T>(_runtime: unknown, step: () => Promise<T>): Promise<T> => {
      const next = queue.then(step, step);
      queue = next.then(() => undefined, () => undefined);
      return next;
    };
    const runtime: LifecycleLaneRuntime = {
      key: "lane-b",
      laneId: "lane-b",
      streamStatus: { running: true, deviceUdid: device.udid },
      hub: null,
    };
    const laneDevices = {
      get: () => bound,
      list: () => (bound ? [bound] : []),
      deviceDetach: vi.fn(async () => {
        const detached = bound;
        bound = null;
        return detached;
      }),
      deviceDelete: vi.fn(async () => {}),
      deviceDeleteInstalled: vi.fn(async () => {}),
    } as unknown as LaneDeviceRegistry;
    const shutdown = vi.fn(async () => ({ released: true, previousSession: null }));
    const emit = vi.fn();
    const lifecycle = createLaneDeviceLifecycle({
      laneDevices,
      runtimeForLane: () => runtime,
      allRuntimes: () => [runtime],
      resolveRuntime: () => runtime,
      requireLaneScope: () => runtime,
      serializeDeviceLifecycle,
      assertDarwin: () => {},
      // The service's rule, as `shutdown` applies it.
      assertSessionOwner: (_runtime, caller) => {
        if (owner && owner !== (caller.chatSessionId ?? null) && !caller.force && !caller.ignoreOwnership) {
          throw new Error("IOS_SIMULATOR_OWNED_BY_OTHER_SESSION: owned by another chat");
        }
      },
      shutdown,
      stopRuntimeStream: vi.fn(async () => {}),
      stopDeviceRecording: vi.fn(async () => {}),
      invalidateStatus: vi.fn(),
      invalidateDeviceList: vi.fn(),
      emit,
      logger: { info: vi.fn(), debug: vi.fn() },
    });
    return {
      lifecycle,
      laneDevices,
      shutdown,
      emit,
      serializeDeviceLifecycle,
      bound: () => bound,
      setBound: (next: AppleLaneDevice | null) => { bound = next; },
      setOwner: (next: string | null) => { owner = next; },
    };
  }

  describe("laneDeviceLifecycle", () => {
    it("deviceDetach refuses a device another chat is driving, as deviceStop does", async () => {
      const { lifecycle, laneDevices, shutdown, bound } = setup("chat-owner");

      await expect(lifecycle.deviceDetach({ laneId: "lane-b", chatSessionId: "chat-other" }))
        .rejects.toThrow(/IOS_SIMULATOR_OWNED_BY_OTHER_SESSION/);
      // Refused before anything changed.
      expect(laneDevices.deviceDetach).not.toHaveBeenCalled();
      expect(shutdown).not.toHaveBeenCalled();
      expect(bound()).toBe(device);

      await expect(lifecycle.deviceDetach({ laneId: "lane-b", chatSessionId: "chat-owner" }))
        .resolves.toMatchObject({ udid: "device-clone" });
    });

    it("detaches for the pane that ignores ownership, and releases the lane's hold", async () => {
      const { lifecycle, shutdown, emit } = setup("chat-owner");
      await expect(lifecycle.deviceDetach({ laneId: "lane-b", ignoreOwnership: true }))
        .resolves.toMatchObject({ udid: "device-clone" });
      expect(shutdown).toHaveBeenCalledWith({ laneId: "lane-b", ignoreOwnership: true });
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "apple.device.state", phase: "released" }));
    });

    it("a forced delete of an attached device detaches it and deletes nothing", async () => {
      const { lifecycle, laneDevices } = setup("chat-owner");
      const attached = { ...device, origin: "attached" as const };
      (laneDevices as unknown as { get: () => AppleLaneDevice }).get = () => attached;
      (laneDevices.deviceDetach as ReturnType<typeof vi.fn>).mockResolvedValueOnce(attached);

      await lifecycle.deviceDelete({ laneId: "lane-b", chatSessionId: "chat-owner", force: true });

      expect(laneDevices.deviceDetach).toHaveBeenCalledWith({ laneId: "lane-b" });
      expect(laneDevices.deviceDelete).not.toHaveBeenCalled();
    });

    it("a forced deviceDelete from another chat cannot detach or delete the owner's device", async () => {
      const attachedCase = setup("chat-a");
      const attached = { ...device, origin: "attached" as const };
      (attachedCase.laneDevices as unknown as { get: () => AppleLaneDevice }).get = () => attached;

      await expect(attachedCase.lifecycle.deviceDelete({ laneId: "lane-b", chatSessionId: "chat-b", force: true }))
        .rejects.toThrow(/IOS_SIMULATOR_OWNED_BY_OTHER_SESSION/);
      expect(attachedCase.laneDevices.deviceDetach).not.toHaveBeenCalled();
      expect(attachedCase.shutdown).not.toHaveBeenCalled();

      const cloneCase = setup("chat-a");
      await expect(cloneCase.lifecycle.deviceDelete({ laneId: "lane-b", chatSessionId: "chat-b", force: true }))
        .rejects.toThrow(/IOS_SIMULATOR_OWNED_BY_OTHER_SESSION/);
      expect(cloneCase.laneDevices.deviceDelete).not.toHaveBeenCalled();
      expect(cloneCase.shutdown).not.toHaveBeenCalled();
      expect(cloneCase.bound()).toBe(device);

      // The Work pane deletes for whoever is running.
      await cloneCase.lifecycle.deviceDelete({ laneId: "lane-b", ignoreOwnership: true });
      expect(cloneCase.laneDevices.deviceDelete).toHaveBeenCalledWith({ laneId: "lane-b", udid: "device-clone" });
    });

    it("a delete queued behind another chat's start is refused once that chat claims the session", async () => {
      const { lifecycle, laneDevices, shutdown, serializeDeviceLifecycle, setOwner, bound } = setup(null);
      let claimed = () => {};
      const claim = new Promise<void>((resolve) => { claimed = resolve; });
      // Chat A's start, in flight: it claims the session when it finishes.
      const start = serializeDeviceLifecycle(null, async () => {
        await claim;
        setOwner("chat-a");
      });

      // No owner yet, so the up-front check passes and the delete waits its turn.
      const deleted = lifecycle.deviceDelete({ laneId: "lane-b", chatSessionId: "chat-b" });
      claimed();
      await start;

      await expect(deleted).rejects.toThrow(/IOS_SIMULATOR_OWNED_BY_OTHER_SESSION/);
      expect(shutdown).not.toHaveBeenCalled();
      expect(laneDevices.deviceDelete).not.toHaveBeenCalled();
      expect(bound()).toBe(device);
    });

    it("an unforced delete of an attached device is refused before the stream stops", async () => {
      const { lifecycle, laneDevices, shutdown, setBound } = setup("chat-owner");
      const attached = { ...device, origin: "attached" as const };
      setBound(attached);

      await expect(lifecycle.deviceDelete({ laneId: "lane-b", chatSessionId: "chat-owner" }))
        .rejects.toBeInstanceOf(AppleDeviceAttachedNotDeletableError);
      expect(shutdown).not.toHaveBeenCalled();
      expect(laneDevices.deviceDetach).not.toHaveBeenCalled();
      expect(laneDevices.deviceDelete).not.toHaveBeenCalled();
    });

    it("a delete reads the lane's device once, in the queue, after a start in flight has changed it", async () => {
      const attached = { ...device, origin: "attached" as const };

      // Forced: the device the start left behind is attached, so it is detached, not deleted.
      const forced = setup(null);
      forced.setBound(null);
      const forcedStart = forced.serializeDeviceLifecycle(null, async () => { forced.setBound(attached); });
      await forced.lifecycle.deviceDelete({ laneId: "lane-b", force: true });
      await forcedStart;
      expect(forced.laneDevices.deviceDetach).toHaveBeenCalledWith({ laneId: "lane-b" });
      expect(forced.laneDevices.deviceDelete).not.toHaveBeenCalled();

      // Unforced: refused, and the stream the start opened keeps running.
      const unforced = setup(null);
      unforced.setBound(null);
      const unforcedStart = unforced.serializeDeviceLifecycle(null, async () => { unforced.setBound(attached); });
      await expect(unforced.lifecycle.deviceDelete({ laneId: "lane-b" }))
        .rejects.toBeInstanceOf(AppleDeviceAttachedNotDeletableError);
      await unforcedStart;
      expect(unforced.shutdown).not.toHaveBeenCalled();
      expect(unforced.laneDevices.deviceDetach).not.toHaveBeenCalled();
      expect(unforced.laneDevices.deviceDelete).not.toHaveBeenCalled();
    });

    it("a delete on a lane with no device does nothing: no shutdown, no registry call", async () => {
      const { lifecycle, laneDevices, shutdown, emit, setBound } = setup(null);
      setBound(null);
      await lifecycle.deviceDelete({ laneId: "lane-b", force: true });
      expect(shutdown).not.toHaveBeenCalled();
      expect(laneDevices.deviceDetach).not.toHaveBeenCalled();
      expect(laneDevices.deviceDelete).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it("deletes a clone: the stream stops first, then the registry deletes and the lane hears released", async () => {
      const { lifecycle, laneDevices, shutdown, emit } = setup(null);
      await lifecycle.deviceDelete({ laneId: "lane-b" });
      expect(shutdown).toHaveBeenCalledWith(expect.objectContaining({ laneId: "lane-b", ignoreOwnership: true }));
      expect(laneDevices.deviceDelete).toHaveBeenCalledWith({ laneId: "lane-b", udid: "device-clone" });
      expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
        (laneDevices.deviceDelete as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
      );
      expect(emit).toHaveBeenCalledWith({ type: "apple.device.state", laneId: "lane-b", udid: "device-clone", phase: "released" });
    });
  });
});
