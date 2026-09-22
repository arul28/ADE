import { describe, it, expect, vi } from "vitest";
import {
  appleDeviceDataRoot,
  appleDeviceFamily,
  appleLaneDeviceName,
  appleRuntimeScore,
  createLaneDeviceRegistry,
  parseAppleDeviceDiskUsage,
  pickAppleTemplate,
  releaseLaneAppleDevice,
  type LaneDeviceStore,
} from "./laneDeviceRegistry";
import {
  APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE,
  APPLE_DEVICE_EXISTS_CODE,
  APPLE_NO_INSTALLED_SIMULATORS_CODE,
  type AppleInstalledSimulator,
} from "../../../shared/types/iosSimulator";

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
      if (/from lanes/i.test(sql)) return { name: `Lane ${String(params[0])}` } as never;
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

  it("picks an explicit template, then the last used, then the newest iPhone", () => {
    const installed = [
      simulator({ udid: "pad", name: "iPad Pro", family: "ipad", runtime: "iOS 26.3" }),
      simulator({ udid: "old", name: "iPhone 15", runtime: "iOS 18.4" }),
      simulator({ udid: "new", name: "iPhone 17 Pro", runtime: "iOS 26.3" }),
    ];

    expect(pickAppleTemplate({ installed, from: "iPad Pro" })?.udid).toBe("pad");
    expect(pickAppleTemplate({ installed, from: "old" })?.udid).toBe("old");
    expect(pickAppleTemplate({ installed, lastUsedUdid: "old" })?.udid).toBe("old");
    // A last-used template that has since been deleted must not strand the
    // lane — it falls through to the default rather than failing.
    expect(pickAppleTemplate({ installed, lastUsedUdid: "gone" })?.udid).toBe("new");
    expect(pickAppleTemplate({ installed })?.udid).toBe("new");
    expect(pickAppleTemplate({ installed: [] })).toBeNull();
  });

  it("names a clone for its lane and suffixes a collision", () => {
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
        listInstalledSimulators: async () => installed,
        store,
        logger: noopLogger,
      }),
    };
  }

  it("clones the template, names it for the lane, and remembers the template", async () => {
    const run = vi.fn(async () => ({ stdout: "clone-udid\n", stderr: "" }));
    const { registry, store } = registryWith(run);

    const device = await registry.deviceCreate({ laneId: "lane-1" });

    expect(run).toHaveBeenCalledWith("xcrun", ["simctl", "clone", "template-1", "ADE · Lane lane-1"], expect.anything());
    expect(device).toMatchObject({ udid: "clone-udid", origin: "clone", family: "iphone", templateUdid: "template-1" });
    expect(store.rows["lane-1"]).toMatchObject({ udid: "clone-udid" });
    // Remembered so the next lane clones what this project actually uses.
    expect(store.getJson("apple:last-template-udid")).toBe("template-1");

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
      listInstalledSimulators: async () => [],
      store: memoryStore(),
      logger: noopLogger,
    });

    await expect(registry.deviceCreate({ laneId: "lane-1" })).rejects.toMatchObject({
      code: APPLE_NO_INSTALLED_SIMULATORS_CODE,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("attaches without cloning and never deletes what it attached", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const { registry, store } = registryWith(run);

    const device = await registry.deviceAttach({ laneId: "lane-1", simulator: "iPhone 17 Pro" });
    expect(device).toMatchObject({ udid: "template-1", origin: "attached", templateUdid: null });
    expect(run).not.toHaveBeenCalled();

    await expect(registry.deviceDelete({ laneId: "lane-1" })).rejects.toMatchObject({
      code: APPLE_DEVICE_ATTACHED_NOT_DELETABLE_CODE,
    });
    // force DETACHES. It never runs `simctl delete` on a device ADE did not
    // create — that is not a recoverable mistake.
    await registry.deviceDelete({ laneId: "lane-1", force: true });
    expect(store.rows["lane-1"]).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
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
  it("deletes a clone, removes the recordings, and never throws", async () => {
    const store = memoryStore({
      "lane-1": {
        lane_id: "lane-1",
        udid: "clone-udid",
        name: "ADE · A",
        origin: "clone",
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
      expect(removed).toEqual(["/repo/.ade/artifacts/apple-recordings/lane-1"]);
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
    const run = vi.fn(async () => { throw new Error("simctl exploded"); });

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

    expect(result).toEqual({ deletedUdid: null, detachedUdid: "users-own", removedRecordings: false });
    expect(run).not.toHaveBeenCalled();
    expect(store.rows["lane-1"]).toBeUndefined();
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
        origin: "clone",
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
        origin: "clone",
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
  ];

  function takeoverRegistry(overrides: Partial<{ releaseLaneDevice: (device: unknown) => void }> = {}) {
    const store = memoryStore({
      "lane-a": {
        lane_id: "lane-a",
        udid: "repro",
        name: "ADE Repro",
        // A clone ADE made: its provenance must survive the move, or the clone
        // leaks when the new owner's lane is archived.
        origin: "clone",
        family: "iphone",
        runtime: "iOS 26.3",
        created_at: "2026-09-01T00:00:00.000Z",
        template_udid: "free",
      },
    });
    const released: unknown[] = [];
    const registry = createLaneDeviceRegistry({
      run: (async () => ({ stdout: "", stderr: "" })) as never,
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

    // `origin`/`templateUdid` describe the SIMULATOR and travel with it.
    expect(device.origin).toBe("clone");
    expect(device.templateUdid).toBe("free");
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

    expect(device).toMatchObject({ laneId: "lane-b", udid: "free", origin: "attached", templateUdid: null });
    expect(released).toEqual([]);
    expect(Object.keys(store.rows).sort()).toEqual(["lane-a", "lane-b"]);
  });

  it("moves the binding in hosts with no database, too", async () => {
    const released: string[] = [];
    const registry = createLaneDeviceRegistry({
      run: (async () => ({ stdout: "", stderr: "" })) as never,
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
