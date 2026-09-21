import { describe, it, expect, vi } from "vitest";
import {
  appleDeviceFamily,
  appleLaneDeviceName,
  appleRuntimeScore,
  createLaneDeviceRegistry,
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
