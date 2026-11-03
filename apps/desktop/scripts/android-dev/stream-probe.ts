/**
 * TEMPORARY dev harness (delete before the PR): boots a read-only emulator and
 * compares scrcpy encoder settings (swipe fps, idle fps, bytes/s) and the
 * keyframe a reader that joins mid-stream receives.
 *
 *   npx -y tsx apps/desktop/scripts/android-dev/stream-probe.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { runAdb, runAdbText } from "../../src/main/services/android/adb";
import { diagnostics, sendTouch, startStream, stopAllStreams, stopStream } from "../../src/main/services/android/androidStream";
import { SCRCPY_DEVICE_JAR_PATH, SCRCPY_SERVER_VERSION } from "../../src/main/services/android/scrcpyServer";
import { createVideoRecordSplitter } from "../../src/main/services/media/videoRecords";

const AVD = process.env.ADE_STREAM_AVD ?? "vphone3";
const SDK = process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
const EXE = process.platform === "win32" ? ".exe" : "";
const ADB = path.join(SDK, "platform-tools", `adb${EXE}`);
const EMULATOR = path.join(SDK, "emulator", `emulator${EXE}`);
const JAR = path.resolve("apps/desktop/resources/android/scrcpy-server");

const t0 = Date.now();
const log = (event: string, data: unknown = {}) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${event} ${JSON.stringify(data)}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, stepMs = 250): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return Date.now() - start;
    await sleep(stepMs);
  }
  return null;
}

function reader(url: string) {
  const splitter = createVideoRecordSplitter();
  const stats = { openedAt: Date.now(), types: [] as string[], keyframesAt: [] as number[], aus: 0 };
  const request = http.get(url, (response) => {
    response.on("data", (chunk: Buffer) => {
      for (const record of splitter.push(chunk)) {
        const key = (record.flags & 1) !== 0;
        if (stats.types.length < 8) stats.types.push(record.type === 1 ? "C" : key ? "K" : "d");
        if (record.type === 2) {
          stats.aus += 1;
          if (key) stats.keyframesAt.push(Date.now() - stats.openedAt);
        }
      }
    });
  });
  request.on("error", () => {});
  return { stats, close: () => request.destroy() };
}

async function swipe(serial: string, w: number, h: number, upward: boolean): Promise<void> {
  const [y1, y2] = upward ? [h * 0.75, h * 0.3] : [h * 0.3, h * 0.75];
  await sendTouch(serial, { action: "down", x: w / 2, y: y1, pointerId: 0 });
  for (let i = 1; i <= 15; i += 1) {
    await sleep(16);
    await sendTouch(serial, { action: "move", x: w / 2, y: y1 + ((y2 - y1) * i) / 15, pointerId: 0 });
  }
  await sendTouch(serial, { action: "up", x: w / 2, y: y2, pointerId: 0 });
}

async function sample(serial: string, ms: number, during?: () => Promise<void>) {
  const fps: number[] = [];
  const bps: number[] = [];
  let running = true;
  const sampler = (async () => {
    while (running) {
      await sleep(500);
      const m = diagnostics(serial)?.metrics;
      if (m) {
        fps.push(m.fps);
        bps.push(m.bytesPerSecond);
      }
    }
  })();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (during) await during();
    else await sleep(100);
  }
  running = false;
  await sampler;
  const steady = (values: number[]) => values.slice(2);
  const avg = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
  return { fpsAvg: avg(steady(fps)), fpsMax: Math.max(...fps), kbpsAvg: avg(steady(bps).map((v) => (v * 8) / 1000)), fps };
}

async function main(): Promise<void> {
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  log("memory", { freeMb });
  if (freeMb < 4_000) return log("abort.low_memory");
  const devicesBefore = await runAdbText(ADB, ["devices"]);
  let port = 0;
  for (const candidate of [5610, 5612, 5614, 5616]) {
    if (devicesBefore.includes(`emulator-${candidate}`)) continue;
    if ((await portFree(candidate)) && (await portFree(candidate + 1)) && (await portFree(candidate + 3000))) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error("no free port");
  const serial = `emulator-${port}`;
  const emulator: ChildProcess = spawn(EMULATOR, ["-avd", AVD, "-read-only", "-no-snapshot", "-no-window", "-no-audio", "-no-boot-anim", "-gpu", "auto", "-port", String(port), "-grpc", String(port + 3000)], { stdio: "ignore", windowsHide: true });
  let exited = false;
  emulator.once("exit", () => {
    exited = true;
  });
  try {
    const booted = await waitFor(async () => (await runAdbText(ADB, ["shell", "getprop", "sys.boot_completed"], { serial, allowFailure: true, timeoutMs: 5_000 }).catch(() => "")) === "1", 180_000, 1_000);
    if (booted === null) throw new Error("boot timeout");
    log("booted", { serial });
    await sleep(4_000);
    await runAdb(ADB, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], { serial, allowFailure: true });

    const info = await runAdbText(ADB, ["shell", "nproc; getprop ro.product.model; getprop ro.build.version.release; getprop ro.kernel.qemu.gles; getprop ro.hardware.egl; cat /proc/meminfo | head -2"], { serial });
    log("device", { info: info.split(/\r?\n/) });
    await runAdb(ADB, ["push", JAR, SCRCPY_DEVICE_JAR_PATH], { serial });
    const encoders = await runAdbText(ADB, ["shell", `CLASSPATH=${SCRCPY_DEVICE_JAR_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_SERVER_VERSION} list_encoders=true cleanup=false log_level=info`], { serial, allowFailure: true, timeoutMs: 20_000 });
    log("encoders", { lines: encoders.split(/\r?\n/).filter((line) => /--video-codec|encoder/i.test(line)) });

    const configs: Array<{ name: string; maxSize: number; codecOptions?: string | null; bitRate?: number; videoEncoder?: string }> = [
      { name: "1600", maxSize: 1600, codecOptions: null },
      { name: "1600+prio", maxSize: 1600, codecOptions: "priority=0,latency=1" },
      { name: "1280+prio", maxSize: 1280, codecOptions: "priority=0,latency=1" },
      { name: "full+prio", maxSize: 0, codecOptions: "priority=0,latency=1" },
      { name: "1600+prio 4M", maxSize: 1600, codecOptions: "priority=0,latency=1", bitRate: 4_000_000 },
      { name: "1024+prio", maxSize: 1024, codecOptions: "priority=0,latency=1" },
    ];
    const results: Record<string, unknown> = {};
    for (const config of configs) {
      await runAdb(ADB, ["shell", "am", "start", "-n", "com.android.settings/.Settings"], { serial, allowFailure: true });
      await sleep(1_200);
      let transport;
      try {
        const at = Date.now();
        transport = await startStream({ adbPath: ADB, serial, serverJarPath: JAR, maxSize: config.maxSize, codecOptions: config.codecOptions, bitRate: config.bitRate, videoEncoder: config.videoEncoder });
        const startMs = Date.now() - at;
        const a = reader(transport.url);
        await sleep(1_000);
        const d = diagnostics(serial)!;
        let up = true;
        const swipe5 = await sample(serial, 5_000, async () => {
          await swipe(serial, d.displaySize?.width ?? 1080, d.displaySize?.height ?? 2400, up);
          up = !up;
        });
        const idle = await sample(serial, 3_000);
        // A reader joins after deltas: when does it get a keyframe it can use?
        const tail = sample(serial, 2_000, async () => {
          await swipe(serial, d.displaySize?.width ?? 1080, d.displaySize?.height ?? 2400, up);
          up = !up;
        });
        await sleep(700);
        const before = diagnostics(serial)!;
        const b = reader(transport.url);
        await tail;
        await sleep(2_500);
        const after = diagnostics(serial)!;
        results[config.name] = {
          video: `${transport.width}x${transport.height}`,
          codec: transport.codec,
          startMs,
          timings: d.timings,
          firstKeyframeMs: d.metrics?.firstKeyframeAtMs && d.metrics.startedAtMs ? d.metrics.firstKeyframeAtMs - d.metrics.startedAtMs : null,
          swipe: swipe5,
          idle,
          join: {
            readerBFirst: b.stats.types,
            readerBKeyframesAtMs: b.stats.keyframesAt,
            readerAKeyframesSinceJoinMs: a.stats.keyframesAt.filter((x) => x + a.stats.openedAt >= b.stats.openedAt).map((x) => x + a.stats.openedAt - b.stats.openedAt),
            keyframeRequests: after.metrics!.totals.keyframeRequests - before.metrics!.totals.keyframeRequests,
            configPackets: after.configPackets - before.configPackets,
            keyframesTotal: after.metrics!.totals.keyframes,
          },
          serverLog: after.serverLog.slice(-6),
        };
        log("config", { name: config.name, ...(results[config.name] as Record<string, unknown>) });
        a.close();
        b.close();
      } catch (error) {
        results[config.name] = { error: error instanceof Error ? error.message : String(error), serverLog: (error as { serverLog?: string[] }).serverLog };
        log("config.error", { name: config.name, ...(results[config.name] as Record<string, unknown>) });
      }
      await stopStream(serial);
    }
    console.log("RESULTS " + JSON.stringify(results));
  } finally {
    await stopAllStreams().catch(() => undefined);
    log("forwards.left", { left: (await runAdbText(ADB, ["forward", "--list"]).catch(() => "")).split(/\r?\n/).filter((l) => l.includes(serial)) });
    await runAdb(ADB, ["emu", "kill"], { serial, allowFailure: true, timeoutMs: 15_000 }).catch(() => undefined);
    if ((await waitFor(async () => exited, 30_000, 500)) === null) emulator.kill();
    log("emulator.exited", { exited });
    log("adb.devices.after", { devices: await runAdbText(ADB, ["devices"]).catch(() => "") });
  }
}

main().then(() => process.exit(0), (error) => {
  console.error("FAILED", error instanceof Error ? error.stack : error);
  process.exit(1);
});
