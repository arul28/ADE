/**
 * TEMPORARY dev harness (delete before the PR): runs `androidEmulatorService`
 * end to end with an in-memory lane store (no sqlite, no Electron).
 *
 *   npx -y tsx apps/desktop/scripts/android-dev/service-smoke.ts
 *
 * getStatus → listDevices → createDevice(lane "smoke", medium_phone, start) →
 * startStream (reads records from the URL) → tap / sendKey(home) /
 * screenshot → stop-during-start check → stop → releaseDevice → dispose.
 *
 * Safety: acts only on the AVD it creates for lane "smoke". Never touches
 * emulator-5554 or any `versic_*` AVD; never `adb kill-server`. Refuses to
 * boot under 4000 MB free.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { AndroidLaneDevice, AndroidEmulatorEvent } from "../../src/shared/types/androidEmulator";
import { createAndroidEmulatorService } from "../../src/main/services/android/androidEmulatorService";
import type { AndroidLaneDeviceRepo } from "../../src/main/services/android/androidLaneRelease";
import { readAndroidDiscoveryFiles, isProcessAlive } from "../../src/main/services/android/androidEmulatorProcess";
import { createVideoRecordSplitter } from "../../src/main/services/media/videoRecords";

const LANE = "smoke";
const t0 = Date.now();
const log = (event: string, data: unknown = {}) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${event} ${JSON.stringify(data)}`);
const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const start = Date.now();
  try {
    const value = await fn();
    timings[label] = Date.now() - start;
    return value;
  } catch (error) {
    timings[label] = Date.now() - start;
    throw error;
  }
};
const timings: Record<string, number> = {};

function memoryRepo(): AndroidLaneDeviceRepo {
  const rows = new Map<string, AndroidLaneDevice>();
  return {
    get: (laneId) => rows.get(laneId) ?? null,
    set: (device) => void rows.set(device.laneId, { ...device }),
    forget: (laneId, avdName) => {
      if (rows.get(laneId)?.avdName === avdName) rows.delete(laneId);
    },
    holder: (avdName, exceptLaneId = null) => {
      for (const row of rows.values()) {
        if (row.laneId !== exceptLaneId && row.avdName.toLowerCase() === avdName.toLowerCase()) return row.laneId;
      }
      return null;
    },
  };
}

function freeMb(): number {
  if (process.platform !== "win32") return Math.round(os.freemem() / 1024 / 1024);
  const text = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Counter '\\Memory\\Available MBytes').CounterSamples[0].CookedValue"], { encoding: "utf8" });
  return Math.round(Number(text.trim()));
}

/** Reads the stream URL for `ms` and counts records. */
function readRecords(url: string, ms: number): Promise<{ status: number | null; configs: unknown[]; accessUnits: number; keyframes: number; bytes: number }> {
  return new Promise((resolve) => {
    const splitter = createVideoRecordSplitter();
    const stats = { status: null as number | null, configs: [] as unknown[], accessUnits: 0, keyframes: 0, bytes: 0 };
    const request = http.get(url, (response) => {
      stats.status = response.statusCode ?? null;
      response.on("data", (chunk: Buffer) => {
        stats.bytes += chunk.byteLength;
        for (const record of splitter.push(chunk)) {
          if (record.type === 1) stats.configs.push(JSON.parse(record.payload.toString("utf8")));
          else {
            stats.accessUnits += 1;
            if ((record.flags & 1) !== 0) stats.keyframes += 1;
          }
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

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-service-smoke-"));
  const repo = memoryRepo();
  const events: AndroidEmulatorEvent[] = [];
  const service = createAndroidEmulatorService({
    laneDevices: repo,
    dataDir: work,
    serverJarPath: path.resolve("apps/desktop/resources/android/scrcpy-server"),
    logger: {
      debug: () => undefined,
      info: (event, meta) => log(`log.${event}`, meta),
      warn: (event, meta) => log(`warn.${event}`, meta),
      error: (event, meta) => log(`error.${event}`, meta),
    },
    onEvent: (event) => {
      events.push(event);
      log("event", event);
    },
  });
  const before = readAndroidDiscoveryFiles().map((emulator) => ({ serial: emulator.serial, avd: emulator.avdName, pid: emulator.pid }));
  log("running.before", before);
  let createdAvd: string | null = null;
  try {
    const status = await timed("getStatus.cold", () => service.getStatus({ laneId: LANE }));
    log("getStatus", { platformSupported: status.platformSupported, found: status.sdk.found, accel: status.sdk.acceleration, lane: status.lane });
    await timed("getStatus.warm", () => service.getStatus({ laneId: LANE }));
    const inventory = await timed("listDevices", () => service.listDevices());
    log("listDevices", {
      avds: inventory.avds.map((avd) => ({ name: avd.name, running: avd.running?.serial ?? null, booted: avd.running?.booted ?? null, held: avd.heldByLaneId, ade: avd.adeCreated })),
      profiles: inventory.profiles.length,
      hasMediumPhone: inventory.profiles.some((profile) => profile.id === "medium_phone"),
      images: inventory.images.map((image) => image.packageId),
    });

    // Refusals that need no boot.
    await service.start({ laneId: LANE }).then(
      () => log("refusal.start_without_device", "UNEXPECTED: resolved"),
      (error) => log("refusal.start_without_device", (error as Error).message),
    );
    await service.attachDevice({ laneId: "smoke-other", avdName: "definitely_not_an_avd", start: false }).then(
      () => log("refusal.attach_missing", "UNEXPECTED"),
      (error) => log("refusal.attach_missing", (error as Error).message),
    );

    const mb = freeMb();
    log("memory.available_mb", mb);
    if (mb < 4000) throw new Error(`Only ${mb} MB free; not booting.`);

    // Stop during start: create without boot, start, stop after 3 s.
    const made = await timed("createDevice.noStart", () => service.createDevice({ laneId: LANE, profileId: "medium_phone", start: false }));
    createdAvd = made.device?.avdName ?? null;
    log("createDevice.noStart", { state: made.state, device: made.device, avdPath: made.avd?.path });
    await service.createDevice({ laneId: LANE, profileId: "medium_phone", start: false }).then(
      () => log("refusal.second_create", "UNEXPECTED"),
      (error) => log("refusal.second_create", (error as Error).message),
    );
    await service.attachDevice({ laneId: "smoke-other", avdName: createdAvd!, start: false }).then(
      () => log("refusal.held_by_other", "UNEXPECTED"),
      (error) => log("refusal.held_by_other", (error as Error).message),
    );
    const startAt = Date.now();
    const starting = service.start({ laneId: LANE });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const stopped = await timed("stop.duringStart", () => service.stop({ laneId: LANE }));
    const startResult = await starting.then(() => "UNEXPECTED: resolved", (error) => (error as Error).message);
    log("stopDuringStart", { startResult, startSettledAfterMs: Date.now() - startAt, state: stopped.state, running: readAndroidDiscoveryFiles().filter((e) => e.avdName === createdAvd).length });

    // The real boot.
    const booted = await timed("start.boot", () => service.start({ laneId: LANE }));
    log("start", { state: booted.state, running: booted.avd?.running });
    if (booted.state !== "booted") throw new Error(`state ${booted.state}`);
    await timed("start.again(no-op)", () => service.start({ laneId: LANE }));

    // Input with no viewer goes through adb.
    await timed("tap.adb", () => service.tap({ laneId: LANE, x: 540, y: 1200 }));
    await timed("sendKey.home.adb", () => service.sendKey({ laneId: LANE, key: "home" }));

    const stream = await timed("startStream", () => service.startStream({ laneId: LANE }));
    log("startStream", { running: stream.running, codec: stream.transport?.codec, width: stream.transport?.width, height: stream.transport?.height, url: stream.transport?.url.replace(/token=[0-9a-f]+/u, "token=…") });
    const redacted = await service.getStreamStatus({ laneId: LANE });
    log("getStreamStatus.redacted", { running: redacted.running, transportIsNull: redacted.transport === null, fps: redacted.fps });
    const reading = readRecords(stream.transport!.url, 4_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await timed("swipe.scrcpy", () => service.swipe({ laneId: LANE, fromX: 540, fromY: 1800, toX: 540, toY: 600, durationMs: 300 }));
    await timed("tap.scrcpy", () => service.tap({ laneId: LANE, x: 540, y: 1200 }));
    await timed("sendKey.home.scrcpy", () => service.sendKey({ laneId: LANE, key: "home" }));
    const records = await reading;
    log("stream.records", records);

    const shot = await timed("screenshot", () => service.screenshot({ laneId: LANE }));
    log("screenshot", shot);
    const shotOut = await timed("screenshot.outPath", () => service.screenshot({ laneId: LANE, outPath: path.join(work, "explicit.png") }));
    log("screenshot.outPath", { path: shotOut.path, w: shotOut.width, h: shotOut.height });

    const off = await timed("stop", () => service.stop({ laneId: LANE }));
    log("stop", { state: off.state });
    const streamAfterStop = await service.getStreamStatus({ laneId: LANE });
    log("stream.afterStop", { running: streamAfterStop.running });

    const released = await timed("releaseDevice", () => service.releaseDevice({ laneId: LANE }));
    log("releaseDevice", released);
    if (released.deletedAvd) createdAvd = null;
    const lane = await service.getStatus({ laneId: LANE });
    log("lane.afterRelease", lane.lane);
  } finally {
    if (repo.get(LANE)) {
      await service.releaseDevice({ laneId: LANE }).then(
        (result) => {
          log("cleanup.release", result);
          if (result.deletedAvd) createdAvd = null;
        },
        (error) => log("cleanup.release_failed", (error as Error).message),
      );
    }
    await timed("dispose", () => service.dispose());
    const after = readAndroidDiscoveryFiles().map((emulator) => ({ serial: emulator.serial, avd: emulator.avdName, pid: emulator.pid, alive: isProcessAlive(emulator.pid) }));
    log("running.after", after);
    if (createdAvd) log("LEFTOVER_AVD", createdAvd);
    log("timings", timings);
    log("events.count", events.length);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    log("FAILED", { error: (error as Error).stack ?? String(error) });
    process.exit(1);
  },
);
