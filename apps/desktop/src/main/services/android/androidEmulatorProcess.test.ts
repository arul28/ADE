import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdeStartedEmulators, androidDiscoveryDirs, readAndroidDiscoveryFiles } from "./androidEmulatorProcess";
import { AndroidEmulatorOwnersStore, type AndroidEmulatorOwnerRecord } from "./androidEmulatorOwners";
import { createAndroidEmulatorLifecycle } from "./androidEmulatorSweep";

// ADE's console ports are the emulator's defaults, so a user's own emulator can
// come up on the very AVD name and port an old ADE start used. Claiming it
// would let ADE stop the user's emulator with a lane, or delete its AVD.

/** A pid that existed and is gone: a child that already exited. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (!pid) throw new Error("setup: no pid for the exited child");
  return pid;
}

const LIVE = process.pid;
const AVD = "ade_lane_pixel";
const PORT = 5554;

describe("AdeStartedEmulators", () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-started-"));
    statePath = path.join(dir, "started-emulators.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readFile = () => JSON.parse(fs.readFileSync(statePath, "utf8")) as Array<{ pid: number | null }>;

  it.each([
    ["its qemu pid", () => ({ launcherPid: deadPid(), pid: LIVE, startedAt: undefined }), LIVE, true],
    ["its launcher pid (Windows: qemu runs under emulator.exe)", () => ({ launcherPid: LIVE, pid: 4_000_001, startedAt: undefined }), LIVE, true],
    ["a booting start whose launcher still runs", () => ({ launcherPid: LIVE, pid: null, startedAt: undefined }), 4_000_002, true],
    ["a pid-less start whose launcher is gone", () => ({ launcherPid: deadPid(), pid: null, startedAt: undefined }), 4_000_003, false],
    ["a pid-less start older than any boot (launcher pid reused after a reboot)", () => ({
      launcherPid: LIVE,
      pid: null,
      startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    }), 4_000_004, false],
    ["a start pinned to another qemu", () => ({ launcherPid: deadPid(), pid: LIVE, startedAt: undefined }), 4_000_005, false],
  ])("decides ownership by %s", (_label, makeRecord, runningPid, owned) => {
    const record = makeRecord();
    new AdeStartedEmulators(statePath).record({ avdName: AVD, consolePort: PORT, ...record });

    // A fresh reader, as a brain after a restart would be.
    const started = new AdeStartedEmulators(statePath);
    expect(started.owns({ avdName: AVD, consolePort: PORT, pid: runningPid })).toBe(owned);
    // The same AVD on another port is never the same start.
    expect(started.owns({ avdName: AVD, consolePort: PORT + 2, pid: runningPid })).toBe(false);
    // A dead start is dropped, so it can never claim a later emulator.
    expect(readFile()).toHaveLength(owned || record.pid !== null ? 1 : 0);
  });

  it("pins a mid-boot start to the first emulator it claims, so a later one on that port stays the user's", () => {
    new AdeStartedEmulators(statePath).record({ avdName: AVD, consolePort: PORT, launcherPid: LIVE, pid: null });

    const adopting = new AdeStartedEmulators(statePath);
    expect(adopting.owns({ avdName: AVD, consolePort: PORT, pid: 4_100_001 })).toBe(true);
    expect(readFile()[0]?.pid).toBe(4_100_001);

    // ADE's emulator exited and the user started their own on the same port.
    const later = new AdeStartedEmulators(statePath);
    expect(later.owns({ avdName: AVD, consolePort: PORT, pid: 4_100_002 })).toBe(false);
    expect(later.owns({ avdName: AVD, consolePort: PORT, pid: 4_100_001 })).toBe(true);
  });
});

describe("Linux emulator discovery", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-discovery-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Emulator 37 writes its discovery file to XDG_RUNTIME_DIR in a login
  // session, and to the Android user home in a service (an Agent37 VM brain).
  // A file ADE does not read makes a booted lane emulator read as off.
  it.each([
    ["a login session", (root: string) => path.join(root, "xdg"), (root: string) => ({ XDG_RUNTIME_DIR: path.join(root, "xdg") })],
    ["a service with no XDG_RUNTIME_DIR", (root: string) => path.join(root, "user", ".android"), (root: string) => ({ ANDROID_USER_HOME: path.join(root, "user", ".android") })],
  ])("finds an emulator started from %s", (_label, base, env) => {
    const running = path.join(base(home), "avd", "running");
    fs.mkdirSync(running, { recursive: true });
    fs.writeFileSync(path.join(running, `pid_${LIVE}.ini`), "port.serial=5560\nport.adb=5561\navd.id=ade_lane_pixel\n");

    // The real /tmp/android-<user> folder is read too; match only this file.
    const found = readAndroidDiscoveryFiles(androidDiscoveryDirs("linux", env(home), home))
      .filter((emulator) => emulator.pid === LIVE);

    expect(found).toHaveLength(1);
    expect(found[0]?.avdName).toBe(AVD);
    expect(found[0]?.serial).toBe("emulator-5560");
    expect(found[0]?.pid).toBe(LIVE);
  });
});

// The sweep every brain runs over the machine's owner file. It may stop only
// what ADE started and nobody will use again; a wrong stop kills the user's
// emulator or an agent's mid-test device, a missed one is how five emulators
// froze a Mac on 2026-11-06.
describe("the emulator sweep", () => {
  let root: string;
  let discovery: string;
  let store: AndroidEmulatorOwnersStore;
  const nowMs = Date.parse("2026-11-06T12:00:00.000Z");
  const minutesAgo = (minutes: number) => new Date(nowMs - minutes * 60_000).toISOString();
  /** ADE's emulator runs as this process (alive), the user's as the vitest parent (alive too). */
  const OTHER_LIVE = process.ppid;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-sweep-"));
    discovery = path.join(root, "running");
    fs.mkdirSync(discovery, { recursive: true });
    store = new AndroidEmulatorOwnersStore(path.join(root, "emulator-owners.json"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const discoveryFile = (pid: number, avdName: string, port: number) =>
    fs.writeFileSync(path.join(discovery, `pid_${pid}.ini`), `port.serial=${port}\nport.adb=${port + 1}\navd.id=${avdName}\n`);

  const record = (change: Partial<AndroidEmulatorOwnerRecord> & { ownerPid?: number; ownerHome?: string; ownerAdoptable?: boolean }): AndroidEmulatorOwnerRecord => ({
    avdName: AVD,
    consolePort: PORT,
    pid: LIVE,
    pidStartedAtMs: null,
    launcherPid: LIVE,
    adbPath: null,
    laneId: "lane-1",
    projectRoot: "/projects/app",
    chatSessionId: null,
    machineId: null,
    guestRamMb: 2_048,
    costMb: 5_632,
    startedAt: minutesAgo(60),
    lastUsedAt: minutesAgo(5),
    pinned: false,
    ownerGoneAt: null,
    stopping: null,
    ...change,
    owner: {
      brainPid: change.ownerPid ?? LIVE,
      brainStartedAtMs: null,
      adeHome: change.ownerHome ?? path.join(root, "home-self"),
      adoptable: change.ownerAdoptable ?? false,
    },
  });

  it.each<[string, Parameters<typeof record>[0], { busy?: boolean; selfAdoptable?: boolean }, { stopped: string | null; after: Partial<AndroidEmulatorOwnerRecord> | null }]>([
    ["stops this brain's emulator nobody used for 21 minutes", { lastUsedAt: minutesAgo(21) }, {}, { stopped: "idle", after: null }],
    ["keeps one used 5 minutes ago", {}, {}, { stopped: null, after: { lastUsedAt: minutesAgo(5) } }],
    ["keeps an idle one the person pinned", { lastUsedAt: minutesAgo(90), pinned: true }, {}, { stopped: null, after: { pinned: true } }],
    ["keeps an idle one its service is using (a stream, a lease), and moves its clock", { lastUsedAt: minutesAgo(90) }, { busy: true }, {
      stopped: null,
      after: { lastUsedAt: new Date(nowMs).toISOString() },
    }],
    ["marks an emulator whose brain is gone, and waits", { ownerPid: deadPid() }, {}, { stopped: null, after: { ownerGoneAt: new Date(nowMs).toISOString() } }],
    ["stops it once a throwaway home's grace has run out", { ownerPid: deadPid(), ownerGoneAt: minutesAgo(3) }, {}, { stopped: "owner_gone", after: null }],
    ["gives the installed app's home a longer grace", { ownerPid: deadPid(), ownerAdoptable: true, ownerHome: "/elsewhere/.ade", ownerGoneAt: minutesAgo(3) }, {}, {
      stopped: null,
      after: { ownerGoneAt: minutesAgo(3) },
    }],
    ["keeps a pinned emulator whose installed-home brain is gone, past any grace, for its adopter", {
      ownerPid: deadPid(),
      ownerAdoptable: true,
      ownerHome: "/elsewhere/.ade",
      ownerGoneAt: minutesAgo(60),
      pinned: true,
    }, {}, { stopped: null, after: { pinned: true, ownerGoneAt: minutesAgo(60) } }],
    ["adopts one a brain on its own adopting home left (a restart)", { ownerPid: deadPid(), ownerAdoptable: true, lastUsedAt: minutesAgo(2) }, { selfAdoptable: true }, {
      stopped: null,
      after: { ownerGoneAt: null },
    }],
    ["leaves another live brain's idle emulator to that brain, even one an earlier sweep thought gone", {
      ownerPid: OTHER_LIVE,
      lastUsedAt: minutesAgo(90),
      ownerGoneAt: minutesAgo(30),
    }, {}, { stopped: null, after: { lastUsedAt: minutesAgo(90), ownerGoneAt: null } }],
    ["drops a record whose port now runs a different emulator, and stops nothing", { pid: 4_200_001, lastUsedAt: minutesAgo(90) }, {}, { stopped: null, after: null }],
  ])("%s", async (_label, change, options, expected) => {
    const self = { brainPid: LIVE, brainStartedAtMs: null, adeHome: path.join(root, "home-self"), adoptable: options.selfAdoptable === true };
    discoveryFile(LIVE, AVD, PORT);
    // The user's own emulator, started outside ADE: it has no record.
    discoveryFile(OTHER_LIVE, "Pixel_8_API_35", PORT + 2);
    store.update((data) => {
      data.emulators.push(record(change));
    });
    const stops: Array<{ avdName: string; pid: number }> = [];
    const info: Array<[string, Record<string, unknown> | undefined]> = [];
    const lifecycle = createAndroidEmulatorLifecycle({
      store,
      self,
      discoveryDirs: [discovery],
      idleMs: 20 * 60_000,
      now: () => nowMs,
      readStartTimes: async () => new Map(),
      logger: { info: (event: string, data?: Record<string, unknown>) => info.push([event, data]), warn: () => {}, debug: () => {}, error: () => {} } as never,
      stopEmulator: async (_record, emulator) => {
        stops.push({ avdName: emulator.avdName, pid: emulator.pid });
      },
    });
    const leave = options.busy
      // A service that no longer holds the emulator: a stop asked of it would fall through to the sweep's own.
      ? lifecycle.register({ projectRoot: "/projects/app", isBusy: () => true, stopIdle: async () => "not_found" })
      : () => {};
    try {
      const report = await lifecycle.sweep();
      // The user's emulator is listed, and never stopped.
      expect(report.foreign.map((entry) => entry.avdName)).toContain("Pixel_8_API_35");
      expect(stops.map((stop) => stop.avdName)).not.toContain("Pixel_8_API_35");
      expect(stops).toEqual(expected.stopped ? [{ avdName: AVD, pid: LIVE }] : []);
      if (expected.stopped) {
        expect(info.find(([event]) => event === "android.emulator_stopped")?.[1]?.reason).toBe(expected.stopped);
      }
      const after = store.read().emulators[0] ?? null;
      if (expected.after === null) expect(after).toBeNull();
      else expect(after).toMatchObject(expected.after);
      if (options.selfAdoptable && after) expect(after.owner.brainPid).toBe(LIVE);
    } finally {
      leave();
    }
  });

  const sweepWith = (extra: Partial<Parameters<typeof createAndroidEmulatorLifecycle>[0]>) => {
    const stops: Array<{ avdName: string; pid: number }> = [];
    const lifecycle = createAndroidEmulatorLifecycle({
      store,
      self: { brainPid: LIVE, brainStartedAtMs: null, adeHome: path.join(root, "home-self"), adoptable: false },
      discoveryDirs: [discovery],
      idleMs: 20 * 60_000,
      now: () => nowMs,
      readStartTimes: async () => new Map(),
      stopEmulator: async (_record, emulator) => {
        stops.push({ avdName: emulator.avdName, pid: emulator.pid });
      },
      ...extra,
    });
    return { lifecycle, stops };
  };

  // The person pins the emulator after the sweep read the file and before
  // the stop is taken: the stop reads the record again and leaves it.
  it("never stops an emulator pinned after the sweep looked", async () => {
    discoveryFile(LIVE, AVD, PORT);
    store.update((data) => {
      data.emulators.push(record({ lastUsedAt: minutesAgo(90) }));
    });
    const { lifecycle, stops } = sweepWith({});
    const leave = lifecycle.register({
      projectRoot: "/projects/app",
      isBusy: () => false,
      stopIdle: async () => {
        lifecycle.setPinned(AVD, true);
        return "not_found";
      },
    });
    try {
      await lifecycle.sweep();
      expect(stops).toEqual([]);
      expect(store.read().emulators[0]).toMatchObject({ pinned: true, stopping: null });
    } finally {
      leave();
    }
  });

  // Windows has no start times, and a crashed emulator's discovery file stays
  // behind: once Windows hands its pid to another program, only the image
  // name tells them apart. A kill there takes another program's process tree.
  it.each<[string, string, Array<{ avdName: string; pid: number }>]>([
    ["never stops a pid Windows handed to another program", "chrome.exe", []],
    ["stops the emulator while its pid is still qemu", "qemu-system-x86_64.exe", [{ avdName: AVD, pid: LIVE }]],
  ])("on Windows, %s", async (_label, image, expected) => {
    discoveryFile(LIVE, AVD, PORT);
    store.update((data) => {
      data.emulators.push(record({ lastUsedAt: minutesAgo(90) }));
    });
    const { lifecycle, stops } = sweepWith({ platform: "win32", readProcessImages: async () => new Map([[LIVE, image]]) });
    await lifecycle.sweep();
    expect(stops).toEqual(expected);
    if (expected.length === 0) expect(store.read().emulators).toEqual([]);
  });
});
