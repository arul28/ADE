/**
 * TEMPORARY dev probe (delete before the PR): which rotation works headless.
 *
 *   npx -y tsx apps/desktop/scripts/android-dev/service-rotate-probe.ts
 *
 * Boots one AVD in a temp AVD home, starts the stream, and tries
 * `adb emu rotate`, the settings `user_rotation`, and `cmd window
 * user-rotation`, reading the display rotation, the screencap size, and when
 * the stream's config record shows the new size.
 *
 * Safety: acts only on its own AVD. Never touches emulator-5554 or a
 * `versic_*` AVD; never `adb kill-server`. Refuses to boot under 4000 MB.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { AndroidLaneDevice } from "../../src/shared/types/androidEmulator";
import { createAndroidEmulatorService } from "../../src/main/services/android/androidEmulatorService";
import type { AndroidLaneDeviceRepo } from "../../src/main/services/android/androidLaneRelease";
import { readAndroidDiscoveryFiles } from "../../src/main/services/android/androidEmulatorProcess";
import { runAdb } from "../../src/main/services/android/adb";
import { androidSdkPaths, locateAndroidSdk } from "../../src/main/services/android/androidSdk";
import { createVideoRecordSplitter } from "../../src/main/services/media/videoRecords";

const t0 = Date.now();
const log = (event: string, data: unknown = {}) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${event} ${JSON.stringify(data)}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const JAR = path.resolve("apps/desktop/resources/android/scrcpy-server");
const LANE = "rotate-probe";
const logger = {
  debug: () => undefined,
  info: (event: string, meta?: Record<string, unknown>) => log(`log.${event}`, meta),
  warn: (event: string, meta?: Record<string, unknown>) => log(`warn.${event}`, meta),
  error: (event: string, meta?: Record<string, unknown>) => log(`error.${event}`, meta),
};

function memoryRepo(): AndroidLaneDeviceRepo {
  const rows = new Map<string, AndroidLaneDevice>();
  return {
    get: (laneId) => rows.get(laneId) ?? null,
    set: (device) => void rows.set(device.laneId, device),
    forget: (laneId, avdName) => {
      if (rows.get(laneId)?.avdName === avdName) rows.delete(laneId);
    },
    holder: (avdName, exceptLaneId = null) =>
      [...rows.values()].find((row) => row.laneId !== exceptLaneId && row.avdName.toLowerCase() === avdName.toLowerCase())?.laneId ?? null,
    list: () => [...rows.values()],
    laneState: () => "active",
  };
}

function freeMb(): number {
  if (process.platform !== "win32") return Math.round(os.freemem() / 1024 / 1024);
  const text = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Counter '\\Memory\\Available MBytes').CounterSamples[0].CookedValue"], { encoding: "utf8" });
  return Math.round(Number(text.trim()));
}

async function main() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ade-android-rotate-probe-"));
  const avdHome = path.join(project, "avd-home");
  fs.mkdirSync(avdHome, { recursive: true });
  const env = { ...process.env, ANDROID_AVD_HOME: avdHome };
  const repo = memoryRepo();
  const service = createAndroidEmulatorService({ laneDevices: repo, dataDir: path.join(project, "data"), serverJarPath: JAR, env, logger });
  const located = locateAndroidSdk({ env });
  const adbPath = androidSdkPaths(located!.root, process.platform).adb;
  const configs: Array<{ at: number; width: number; height: number }> = [];
  let request: http.ClientRequest | null = null;
  try {
    const mb = freeMb();
    log("memory.available_mb", mb);
    if (mb < 4000) throw new Error(`Only ${mb} MB free; not booting.`);
    const booted = await service.createDevice({ laneId: LANE, profileId: "medium_phone" });
    const serial = booted.avd!.running!.serial;
    log("booted", { serial, avd: booted.device?.avdName });
    const shell = async (...args: string[]) =>
      (await runAdb(adbPath, ["shell", ...args], { serial, allowFailure: true, timeoutMs: 15_000 })).stdout.toString("utf8").trim();
    const emu = async (...args: string[]) => {
      const result = await runAdb(adbPath, ["emu", ...args], { serial, allowFailure: true, timeoutMs: 15_000 });
      return { code: result.exitCode, out: result.stdout.toString("utf8").trim(), err: result.stderr.trim() };
    };
    const read = async (label: string) => {
      const orientation = (await shell("dumpsys", "input")).split("\n").find((line) => /SurfaceOrientation/u.test(line))?.trim() ?? null;
      const shot = await service.screenshot({ laneId: LANE });
      log(`read.${label}`, {
        orientation,
        accel: await shell("settings", "get", "system", "accelerometer_rotation"),
        user: await shell("settings", "get", "system", "user_rotation"),
        screencap: `${shot.width}x${shot.height}`,
        wmSize: await shell("wm", "size"),
      });
    };

    const stream = await service.startStream({ laneId: LANE });
    log("stream", { width: stream.transport?.width, height: stream.transport?.height });
    request = http.get(stream.transport!.url, (response) => {
      const splitter = createVideoRecordSplitter();
      response.on("data", (chunk: Buffer) => {
        for (const record of splitter.push(chunk)) {
          if (record.type !== 1) continue;
          try {
            const config = JSON.parse(record.payload.toString("utf8")) as { width: number; height: number };
            configs.push({ at: Date.now(), width: config.width, height: config.height });
            log("stream.config", { width: config.width, height: config.height });
          } catch (error) {
            log("stream.config_unreadable", (error as Error).message);
          }
        }
      });
    });
    await sleep(2_000);
    await read("start");

    const timeTo = async (label: string, run: () => Promise<unknown>, wantLandscape: boolean) => {
      const before = configs.length;
      const at = Date.now();
      log(`try.${label}`, await run());
      for (let i = 0; i < 40; i += 1) {
        const fresh = configs.slice(before).find((config) => (config.width > config.height) === wantLandscape);
        if (fresh) {
          log(`stream.size_changed.${label}`, { ms: fresh.at - at, width: fresh.width, height: fresh.height });
          break;
        }
        await sleep(250);
      }
      if (!configs.slice(before).some((config) => (config.width > config.height) === wantLandscape)) log(`stream.no_change.${label}`);
      await read(label);
    };

    // A: the emulator console's rotate (sensor + display, 90° each call).
    await timeTo("emu_rotate", () => emu("rotate"), true);
    await timeTo("emu_rotate_back_1", () => emu("rotate"), false);
    await emu("rotate");
    await emu("rotate");
    await sleep(2_000);
    await read("after_emu_cycle");

    // B: settings (absolute, no sensor).
    await timeTo("settings_landscape", async () => {
      await shell("settings", "put", "system", "accelerometer_rotation", "0");
      return shell("settings", "put", "system", "user_rotation", "1");
    }, true);
    await timeTo("settings_portrait", () => shell("settings", "put", "system", "user_rotation", "0"), false);

    // C: cmd window user-rotation (Android 11+).
    await timeTo("cmd_lock_landscape", () => shell("cmd", "window", "user-rotation", "lock", "1"), true);
    await timeTo("cmd_lock_portrait", () => shell("cmd", "window", "user-rotation", "lock", "0"), false);
  } finally {
    request?.destroy();
    await service.releaseDevice({ laneId: LANE }).then(
      (result) => log("cleanup.release", result),
      (error: Error) => log("cleanup.release_failed", error.message),
    );
    await service.dispose();
    log("avd-home.after", fs.readdirSync(avdHome));
    log("running.after", readAndroidDiscoveryFiles().map((e) => ({ serial: e.serial, avd: e.avdName, pid: e.pid })));
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    log("FAILED", { error: (error as Error).stack ?? String(error) });
    process.exit(1);
  },
);
