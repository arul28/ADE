import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdeStartedEmulators, androidDiscoveryDirs, readAndroidDiscoveryFiles } from "./androidEmulatorProcess";

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
