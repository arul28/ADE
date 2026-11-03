/**
 * TEMPORARY dev harness (delete before the PR): the brain hand-off.
 *
 *   npx -y tsx apps/desktop/scripts/android-dev/service-handoff-smoke.ts
 *
 * 1. A child process (the "old brain") builds the service in hand-off mode,
 *    creates and boots lane "smoke"'s AVD, starts a stream, disposes, exits.
 * 2. The parent (the "new brain") builds a service on the same data folder
 *    and lane store, checks it re-adopts the running emulator, streams and
 *    taps, and disposes (hand-off again).
 * 3. The lane is marked archived (as if archived while no brain ran); a third
 *    service's start-up reconcile must stop the emulator and delete the AVD.
 *
 * Safety: acts only on the AVD it creates. Never touches emulator-5554 or a
 * `versic_*` AVD; never `adb kill-server`. Refuses to boot under 4000 MB free.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import type { AndroidLaneDevice } from "../../src/shared/types/androidEmulator";
import { createAndroidEmulatorService } from "../../src/main/services/android/androidEmulatorService";
import type { AndroidLaneDeviceRepo } from "../../src/main/services/android/androidLaneRelease";
import { readAndroidDiscoveryFiles } from "../../src/main/services/android/androidEmulatorProcess";
import { androidAvdHome } from "../../src/main/services/android/androidSdk";
import { createVideoRecordSplitter } from "../../src/main/services/media/videoRecords";

const LANE = "smoke";
const t0 = Date.now();
const role = process.argv.includes("--phase") ? "old-brain" : "new-brain";
const log = (event: string, data: unknown = {}) =>
  console.log(`[${role} ${((Date.now() - t0) / 1000).toFixed(1)}s] ${event} ${JSON.stringify(data)}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const JAR = path.resolve("apps/desktop/resources/android/scrcpy-server");
const logger = {
  debug: () => undefined,
  info: (event: string, meta?: Record<string, unknown>) => log(`log.${event}`, meta),
  warn: (event: string, meta?: Record<string, unknown>) => log(`warn.${event}`, meta),
  error: (event: string, meta?: Record<string, unknown>) => log(`error.${event}`, meta),
};

type RepoFile = { rows: Record<string, AndroidLaneDevice>; lanes: Record<string, "active" | "archived" | "missing"> };

/** A lane store in a JSON file, read on every call, so two processes share it. */
function fileRepo(file: string): AndroidLaneDeviceRepo & { setLane: (laneId: string, state: "active" | "archived") => void } {
  const read = (): RepoFile => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as RepoFile;
    } catch {
      return { rows: {}, lanes: { [LANE]: "active" } };
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
    laneState: (laneId) => read().lanes[laneId] ?? "missing",
    setLane: (laneId, state) => {
      const data = read();
      data.lanes[laneId] = state;
      write(data);
    },
  };
}

function freeMb(): number {
  if (process.platform !== "win32") return Math.round(os.freemem() / 1024 / 1024);
  const text = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Counter '\\Memory\\Available MBytes').CounterSamples[0].CookedValue"], { encoding: "utf8" });
  return Math.round(Number(text.trim()));
}

function readRecords(url: string, ms: number): Promise<{ status: number | null; accessUnits: number; keyframes: number }> {
  return new Promise((resolve) => {
    const splitter = createVideoRecordSplitter();
    const stats = { status: null as number | null, accessUnits: 0, keyframes: 0 };
    const request = http.get(url, (response) => {
      stats.status = response.statusCode ?? null;
      response.on("data", (chunk: Buffer) => {
        for (const record of splitter.push(chunk)) {
          if (record.type === 1) continue;
          stats.accessUnits += 1;
          if ((record.flags & 1) !== 0) stats.keyframes += 1;
        }
      });
    });
    request.on("error", (error) => log("reader.error", { error: error.message }));
    setTimeout(() => {
      request.destroy();
      resolve(stats);
    }, ms);
  });
}

const running = (avdName: string | null) =>
  readAndroidDiscoveryFiles().filter((emulator) => avdName && emulator.avdName.toLowerCase() === avdName.toLowerCase());

/** The old brain: boot, stream, hand off, exit. */
async function oldBrain(work: string) {
  const repo = fileRepo(path.join(work, "lanes.json"));
  const service = createAndroidEmulatorService({ laneDevices: repo, dataDir: work, serverJarPath: JAR, handOffOnDispose: true, logger });
  const started = Date.now();
  const status = await service.createDevice({ laneId: LANE, profileId: "medium_phone" });
  log("booted", { state: status.state, serial: status.avd?.running?.serial, pid: status.avd?.running?.pid, ms: Date.now() - started });
  const stream = await service.startStream({ laneId: LANE });
  log("stream", { running: stream.running, width: stream.transport?.width, height: stream.transport?.height });
  await service.dispose();
  log("disposed (hand-off)", { stillRunning: running(status.device?.avdName ?? null).map((emulator) => emulator.serial) });
}

async function newBrain() {
  const mb = freeMb();
  log("memory.available_mb", mb);
  if (mb < 4000) throw new Error(`Only ${mb} MB free; not booting.`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-handoff-smoke-"));
  const repo = fileRepo(path.join(work, "lanes.json"));
  log("running.before", readAndroidDiscoveryFiles().map((emulator) => ({ serial: emulator.serial, avd: emulator.avdName, pid: emulator.pid })));

  // 1. The old brain, in its own process, which exits.
  const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, "--phase", "boot", work], { stdio: "inherit", timeout: 300_000 });
  log("old brain exited", { status: child.status, signal: child.signal, error: child.error?.message ?? null });
  const avdName = repo.get(LANE)?.avdName ?? null;
  log("after exit", { avdName, running: running(avdName).map((emulator) => ({ serial: emulator.serial, pid: emulator.pid })) });

  try {
    // 2. Re-adopt.
    const adopter = createAndroidEmulatorService({ laneDevices: repo, dataDir: work, serverJarPath: JAR, handOffOnDispose: true, logger });
    const seen = await adopter.getStatus({ laneId: LANE });
    log("readopt.getStatus", { state: seen.lane?.state, serial: seen.lane?.avd?.running?.serial, startedByAde: seen.lane?.avd?.running?.startedByAde });
    const stream = await adopter.startStream({ laneId: LANE });
    const records = await readRecords(stream.transport!.url, 2_500);
    log("readopt.stream", records);
    await adopter.tap({ laneId: LANE, x: 540, y: 1200 });
    const shot = await adopter.screenshot({ laneId: LANE });
    log("readopt.screenshot", { w: shot.width, h: shot.height });
    await adopter.dispose();
    log("readopt.disposed (hand-off)", { stillRunning: running(avdName).map((emulator) => emulator.serial) });

    // 3. The lane was archived while no brain ran: reconcile stops and releases.
    repo.setLane(LANE, "archived");
    const reconcileAt = Date.now();
    const reconciler = createAndroidEmulatorService({ laneDevices: repo, dataDir: work, serverJarPath: JAR, handOffOnDispose: true, logger });
    const avdHome = androidAvdHome();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (running(avdName).length === 0 && !repo.get(LANE) && !fs.existsSync(path.join(avdHome, `${avdName}.ini`))) break;
      await sleep(500);
    }
    log("reconcile", {
      ms: Date.now() - reconcileAt,
      running: running(avdName).length,
      row: repo.get(LANE),
      avdLeft: avdName ? fs.existsSync(path.join(avdHome, `${avdName}.ini`)) : null,
    });
    await reconciler.dispose();
  } finally {
    // Clean up whatever a failure left, with a service that stops on dispose.
    repo.setLane(LANE, "active");
    if (repo.get(LANE)) {
      const cleaner = createAndroidEmulatorService({ laneDevices: repo, dataDir: work, serverJarPath: JAR, logger });
      await cleaner.releaseDevice({ laneId: LANE }).then(
        (result) => log("cleanup.release", result),
        (error) => log("cleanup.release_failed", (error as Error).message),
      );
      await cleaner.dispose();
    }
    log("running.after", readAndroidDiscoveryFiles().map((emulator) => ({ serial: emulator.serial, avd: emulator.avdName, pid: emulator.pid })));
    if (avdName && fs.existsSync(path.join(androidAvdHome(), `${avdName}.ini`))) log("LEFTOVER_AVD", avdName);
  }
}

const phase = process.argv.indexOf("--phase");
(phase >= 0 ? oldBrain(process.argv[phase + 2]!) : newBrain()).then(
  () => process.exit(0),
  (error) => {
    log("FAILED", { error: (error as Error).stack ?? String(error) });
    process.exit(1);
  },
);
