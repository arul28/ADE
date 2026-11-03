/**
 * TEMPORARY dev harness (delete before the PR): a chat's work copy as a lane.
 *
 *   npx -y tsx apps/desktop/scripts/android-dev/service-workcopy-smoke.ts
 *
 * Everything runs in a temp project with its own ANDROID_AVD_HOME, so the
 * service sees only the AVDs this harness makes (never the user's).
 *
 * 1. Copy A, nothing free: start makes an AVD for the copy and boots it; a
 *    screenshot path stays inside the copy; deleting the copy (the copy
 *    service's release) stops the emulator and deletes the AVD.
 * 2. A kept ADE AVD made for a real lane of this project is free: copy B's
 *    start borrows it (attached) and boots it; a hand-off dispose leaves it
 *    running; copy B is deleted while no service runs; the next service's
 *    start-up reconcile stops it and keeps the AVD.
 *
 * Safety: acts only on AVDs in its own AVD home. Never touches emulator-5554
 * or a `versic_*` AVD; never `adb kill-server`. Refuses to boot under 4000 MB.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { AndroidLaneDevice } from "../../src/shared/types/androidEmulator";
import { createAndroidEmulatorService } from "../../src/main/services/android/androidEmulatorService";
import type { AndroidLaneDeviceRepo } from "../../src/main/services/android/androidLaneRelease";
import { readAndroidDiscoveryFiles } from "../../src/main/services/android/androidEmulatorProcess";
import {
  createRemoteWorkCopyService,
  findRemoteWorkCopyForLane,
  REMOTE_WORK_LANE_PREFIX,
  remoteWorkLaneIdFor,
} from "../../src/main/services/remoteWork/remoteWorkCopyService";

const t0 = Date.now();
const log = (event: string, data: unknown = {}) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${event} ${JSON.stringify(data)}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const JAR = path.resolve("apps/desktop/resources/android/scrcpy-server");
const REAL_LANE = "lane-real";
const OWNER_A = "remote:smoke-device:chat-a";
const OWNER_B = "remote:smoke-device:chat-b";
const logger = {
  debug: () => undefined,
  info: (event: string, meta?: Record<string, unknown>) => log(`log.${event}`, meta),
  warn: (event: string, meta?: Record<string, unknown>) => log(`warn.${event}`, meta),
  error: (event: string, meta?: Record<string, unknown>) => log(`error.${event}`, meta),
};
const failures: string[] = [];
const check = (name: string, ok: boolean, data: unknown = {}) => {
  log(`${ok ? "PASS" : "FAIL"} ${name}`, data);
  if (!ok) failures.push(name);
};

type RepoFile = { rows: Record<string, AndroidLaneDevice> };

function fileRepo(file: string): AndroidLaneDeviceRepo {
  const read = (): RepoFile => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as RepoFile;
    } catch {
      return { rows: {} };
    }
  };
  const write = (data: RepoFile) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return {
    get: (laneId) => read().rows[laneId] ?? null,
    set: (device) => {
      const data = read();
      data.rows[device.laneId] = device;
      write(data);
    },
    forget: (laneId, avdName) => {
      const data = read();
      if (data.rows[laneId]?.avdName === avdName) delete data.rows[laneId];
      write(data);
    },
    holder: (avdName, exceptLaneId = null) =>
      Object.values(read().rows).find((row) => row.laneId !== exceptLaneId && row.avdName.toLowerCase() === avdName.toLowerCase())?.laneId ?? null,
    list: () => Object.values(read().rows),
    // Like the sql repo: only real lanes are in the lanes table.
    laneState: (laneId) => (laneId === REAL_LANE ? "active" : "missing"),
  };
}

function freeMb(): number {
  if (process.platform !== "win32") return Math.round(os.freemem() / 1024 / 1024);
  const text = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Counter '\\Memory\\Available MBytes').CounterSamples[0].CookedValue"], { encoding: "utf8" });
  return Math.round(Number(text.trim()));
}

const running = (avdName: string | null | undefined) =>
  readAndroidDiscoveryFiles().filter((emulator) => avdName && emulator.avdName.toLowerCase() === avdName.toLowerCase());

/** Lists a copy in the project's registry, as `prepare` would, with an empty folder. */
function addCopy(projectRoot: string, owner: string): string {
  const registryFile = path.join(projectRoot, ".ade", "remote-work", "copies.json");
  const copyPath = path.join(projectRoot, ".ade", "remote-work", remoteWorkLaneIdFor(owner).slice(REMOTE_WORK_LANE_PREFIX.length));
  fs.mkdirSync(copyPath, { recursive: true });
  let copies: unknown[] = [];
  try {
    copies = (JSON.parse(fs.readFileSync(registryFile, "utf8")) as { copies: unknown[] }).copies;
  } catch {
    // none yet
  }
  const at = new Date().toISOString();
  copies.push({ owner, path: copyPath, head: "0".repeat(40), branch: null, machineName: "smoke", syncedTree: null, createdAt: at, lastUsedAt: at });
  fs.writeFileSync(registryFile, JSON.stringify({ version: 1, copies }, null, 2));
  return copyPath;
}

async function waitFor(what: string, done: () => boolean, ms = 60_000): Promise<number> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(250);
  }
  return Date.now() - started;
}

async function main() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-workcopy-smoke-"));
  const avdHome = path.join(project, "avd-home");
  const adeHome = path.join(project, "ade-home");
  const dataDir = path.join(project, ".ade", "android");
  fs.mkdirSync(avdHome, { recursive: true });
  const env = { ...process.env, ANDROID_AVD_HOME: avdHome };
  const repo = fileRepo(path.join(project, "lanes.json"));
  const copies = createRemoteWorkCopyService({ projectRoot: project, adeHome, logger });
  const build = (handOffOnDispose: boolean) => createAndroidEmulatorService({
    laneDevices: repo,
    dataDir,
    serverJarPath: JAR,
    projectRoot: project,
    env,
    handOffOnDispose,
    logger,
  });
  const avdExists = (name: string | null | undefined) => Boolean(name) && fs.existsSync(path.join(avdHome, `${name}.ini`));
  const laneA = remoteWorkLaneIdFor(OWNER_A);
  const laneB = remoteWorkLaneIdFor(OWNER_B);
  log("setup", { project, laneA, laneB, before: readAndroidDiscoveryFiles().map((e) => ({ serial: e.serial, avd: e.avdName, pid: e.pid })) });

  try {
    // ---------- 1. Copy A: nothing free, so a new AVD ----------
    const copyA = addCopy(project, OWNER_A);
    check("copyA.found", findRemoteWorkCopyForLane(project, laneA)?.path === copyA);
    const service = build(false);
    const first = await service.getStatus({ laneId: laneA });
    check("1.getStatus creates nothing", first.lane?.state === "none" && repo.get(laneA) === null, { state: first.lane?.state });
    let mb = freeMb();
    log("memory.available_mb", mb);
    if (mb < 4000) throw new Error(`Only ${mb} MB free; not booting.`);
    let started = Date.now();
    const bootA = await service.start({ laneId: laneA });
    const rowA = repo.get(laneA);
    check("1.start made an AVD and booted it", bootA.state === "booted" && rowA?.origin === "created" && rowA.profileId === "medium_phone", {
      ms: Date.now() - started, state: bootA.state, avd: rowA?.avdName, origin: rowA?.origin, serial: bootA.avd?.running?.serial,
    });
    const shot = await service.screenshot({ laneId: laneA, outPath: path.join("shots", "a.png") });
    check("1.screenshot lands in the copy", shot.path === path.join(copyA, "shots", "a.png") && fs.existsSync(shot.path), { path: shot.path, w: shot.width, h: shot.height });
    const escaped = await service.screenshot({ laneId: laneA, outPath: path.join("..", "escape.png") }).then(() => "written", (error: Error) => error.message);
    check("1.screenshot outside the copy is refused", escaped.startsWith("ANDROID_PATH_OUTSIDE_LANE"), { escaped });
    const avdA = rowA?.avdName ?? null;
    started = Date.now();
    check("1.copy release", await copies.release(OWNER_A));
    const releasedMs = await waitFor("copy A's device release", () => repo.get(laneA) === null && running(avdA).length === 0 && !avdExists(avdA), 60_000)
      .catch((error: Error) => { log("wait", error.message); return -1; });
    check("1.copy delete stopped the emulator and deleted the made AVD", releasedMs >= 0, {
      ms: Date.now() - started, row: repo.get(laneA), running: running(avdA).length, avdLeft: avdExists(avdA),
    });
    const gone = await service.start({ laneId: laneA }).then(() => "started", (error: Error) => error.message);
    check("1.start on a gone copy is refused", gone.startsWith("ANDROID_NOT_RUNNING"), { gone });

    // ---------- 2. Copy B: a kept ADE AVD of this project is borrowed ----------
    await service.createDevice({ laneId: REAL_LANE, profileId: "medium_phone", start: false });
    const kept = repo.get(REAL_LANE)?.avdName ?? null;
    await service.releaseDevice({ laneId: REAL_LANE, deleteCreated: false });
    check("2.kept AVD for the real lane", avdExists(kept) && repo.get(REAL_LANE) === null, { kept });
    await service.dispose();

    addCopy(project, OWNER_B);
    const handOff = build(true);
    mb = freeMb();
    log("memory.available_mb", mb);
    if (mb < 4000) throw new Error(`Only ${mb} MB free; not booting.`);
    started = Date.now();
    const bootB = await handOff.start({ laneId: laneB });
    const rowB = repo.get(laneB);
    check("2.start borrowed the kept AVD (attached) and booted it", bootB.state === "booted" && rowB?.avdName === kept && rowB?.origin === "attached", {
      ms: Date.now() - started, state: bootB.state, avd: rowB?.avdName, origin: rowB?.origin, serial: bootB.avd?.running?.serial,
    });
    await handOff.dispose();
    check("2.hand-off left it running", running(kept).length === 1);
    check("2.copy release with no service", await copies.release(OWNER_B));
    started = Date.now();
    const reconciler = build(false);
    const reconcileMs = await waitFor("reconcile", () => repo.get(laneB) === null && running(kept).length === 0, 60_000)
      .catch((error: Error) => { log("wait", error.message); return -1; });
    check("2.reconcile stopped it and kept the AVD", reconcileMs >= 0 && avdExists(kept), {
      ms: Date.now() - started, row: repo.get(laneB), running: running(kept).length, avdLeft: avdExists(kept),
    });
    await reconciler.deleteDevice({ avdName: kept! }).then(
      () => log("cleanup.kept_deleted", { kept }),
      (error: Error) => log("cleanup.kept_delete_failed", error.message),
    );
    await reconciler.dispose();
  } finally {
    // Whatever a failure left: release rows, stop ADE's emulators, delete the AVD home.
    const cleaner = build(false);
    for (const device of repo.list?.() ?? []) {
      await cleaner.releaseDevice({ laneId: device.laneId }).then(
        (result) => log("cleanup.release", { laneId: device.laneId, ...result }),
        (error: Error) => log("cleanup.release_failed", { laneId: device.laneId, error: error.message }),
      );
    }
    await cleaner.dispose();
    const ours = readAndroidDiscoveryFiles().filter((emulator) => fs.readdirSync(avdHome).some((file) => file.toLowerCase() === `${emulator.avdName.toLowerCase()}.ini`));
    if (ours.length > 0) log("LEFTOVER_EMULATORS", ours.map((e) => ({ serial: e.serial, pid: e.pid, avd: e.avdName })));
    log("avd-home.after", fs.readdirSync(avdHome));
    log("running.after", readAndroidDiscoveryFiles().map((e) => ({ serial: e.serial, avd: e.avdName, pid: e.pid })));
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  log(failures.length === 0 ? "ALL PASS" : "FAILURES", failures);
  if (failures.length > 0) process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    log("FAILED", { error: (error as Error).stack ?? String(error) });
    process.exit(1);
  },
);
