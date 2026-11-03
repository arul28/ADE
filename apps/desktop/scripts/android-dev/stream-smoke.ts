/**
 * TEMPORARY dev harness (delete before the PR): boots a read-only emulator,
 * runs the scrcpy stream and input end to end, measures, and cleans up.
 *
 *   npx -y tsx apps/desktop/scripts/android-dev/stream-smoke.ts
 *
 * Safety: touches only the emulator it boots (its own serial), never
 * `adb kill-server`, never another AVD.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { runAdb, runAdbText } from "../../src/main/services/android/adb";
import {
  diagnostics,
  sendKey,
  sendText,
  sendTouch,
  startStream,
  stopAllStreams,
  stopStream,
} from "../../src/main/services/android/androidStream";
import { createVideoRecordSplitter } from "../../src/main/services/media/videoRecords";

const AVD = process.env.ADE_STREAM_AVD ?? "vphone3";
const SDK = process.env.ANDROID_HOME ?? path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
const EXE = process.platform === "win32" ? ".exe" : "";
const ADB = path.join(SDK, "platform-tools", `adb${EXE}`);
const EMULATOR = path.join(SDK, "emulator", `emulator${EXE}`);
const JAR = path.resolve("apps/desktop/resources/android/scrcpy-server");
const FORBIDDEN_SERIALS = new Set(["emulator-5554"]);

const t0 = Date.now();
const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${event} ${JSON.stringify(data)}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const results: Record<string, unknown> = {};

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function execText(file: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve(`${stdout}${error ? `\n[error] ${error.message} ${stderr}` : ""}`));
  });
}

/** NAL types in an Annex-B buffer. */
function nalTypes(data: Uint8Array): number[] {
  const types: number[] = [];
  for (let i = 0; i + 3 < data.length; i += 1) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      types.push(data[i + 3] & 0x1f);
      i += 2;
    }
  }
  return types;
}

type ReaderStats = {
  name: string;
  firstRecords: Array<{ type: number; keyframe: boolean; bytes: number; nalTypes?: number[]; config?: unknown }>;
  configs: Array<{ atMs: number; config: unknown }>;
  accessUnits: number;
  keyframes: Array<number>;
  deltasBeforeFirstKeyframe: number;
  openedAtMs: number;
  firstRecordAtMs: number | null;
  bytes: number;
  aus: Buffer[];
  auAt: number[];
  keepAus: boolean;
  request: http.ClientRequest;
};

function openReader(name: string, url: string, keepAus = false): ReaderStats {
  const splitter = createVideoRecordSplitter();
  const stats = {
    name,
    firstRecords: [],
    configs: [],
    accessUnits: 0,
    keyframes: [],
    deltasBeforeFirstKeyframe: 0,
    openedAtMs: Date.now(),
    firstRecordAtMs: null,
    bytes: 0,
    aus: [],
    auAt: [],
    keepAus,
  } as unknown as ReaderStats;
  stats.request = http.get(url, (response) => {
    log("reader.status", { name, status: response.statusCode });
    response.on("data", (chunk: Buffer) => {
      stats.bytes += chunk.byteLength;
      for (const record of splitter.push(chunk)) {
        stats.firstRecordAtMs ??= Date.now();
        const keyframe = (record.flags & 1) !== 0;
        if (stats.firstRecords.length < 6) {
          stats.firstRecords.push({
            type: record.type,
            keyframe,
            bytes: record.payload.byteLength,
            ...(record.type === 2 ? { nalTypes: nalTypes(record.payload).slice(0, 6) } : {}),
            ...(record.type === 1 ? { config: JSON.parse(record.payload.toString("utf8")) } : {}),
          });
        }
        if (record.type === 1) {
          stats.configs.push({ atMs: Date.now(), config: JSON.parse(record.payload.toString("utf8")) });
          continue;
        }
        stats.accessUnits += 1;
        stats.auAt.push(Date.now());
        if (keyframe) stats.keyframes.push(Date.now());
        else if (stats.keyframes.length === 0) stats.deltasBeforeFirstKeyframe += 1;
        if (stats.keepAus && (stats.aus.length > 0 || keyframe)) stats.aus.push(Buffer.from(record.payload));
      }
    });
  });
  stats.request.on("error", (error) => log("reader.error", { name, error: error.message }));
  return stats;
}

async function focus(serial: string): Promise<string> {
  const text = await runAdbText(ADB, ["shell", "dumpsys", "window"], { serial, timeoutMs: 15_000 }).catch(() => "");
  const line = text.split(/\r?\n/).find((entry) => entry.includes("mCurrentFocus")) ?? "";
  return line.trim();
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, stepMs = 250): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return Date.now() - start;
    await sleep(stepMs);
  }
  return null;
}

async function uiNodes(serial: string): Promise<Array<{ text: string; desc: string; id: string; cls: string; bounds: number[] }>> {
  await runAdb(ADB, ["shell", "uiautomator", "dump", "/sdcard/ade-ui.xml"], { serial, timeoutMs: 20_000, allowFailure: true });
  const xml = (await runAdb(ADB, ["exec-out", "cat", "/sdcard/ade-ui.xml"], { serial, allowFailure: true })).stdout.toString("utf8");
  const nodes: Array<{ text: string; desc: string; id: string; cls: string; bounds: number[] }> = [];
  for (const match of xml.matchAll(/<node [^>]*>/g)) {
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(match[0])?.[1] ?? "";
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr("bounds"));
    if (!b) continue;
    nodes.push({ text: attr("text"), desc: attr("content-desc"), id: attr("resource-id"), cls: attr("class"), bounds: b.slice(1).map(Number) });
  }
  return nodes;
}

async function tap(serial: string, x: number, y: number): Promise<void> {
  await sendTouch(serial, { action: "down", x, y, pointerId: 0 });
  await sleep(60);
  await sendTouch(serial, { action: "up", x, y, pointerId: 0 });
}

async function swipe(serial: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
  const steps = Math.max(2, Math.round(durationMs / 16));
  await sendTouch(serial, { action: "down", x: x1, y: y1, pointerId: 0 });
  for (let i = 1; i <= steps; i += 1) {
    await sleep(durationMs / steps);
    await sendTouch(serial, { action: "move", x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, pointerId: 0 });
  }
  await sendTouch(serial, { action: "up", x: x2, y: y2, pointerId: 0 });
}

/** Swipes for `ms` and samples the server's fps and bytes/s every 500 ms. */
async function measureSwiping(serial: string, ms: number, size: { w: number; h: number }) {
  const samples: Array<{ fps: number; bps: number }> = [];
  let swiping = true;
  const sampler = (async () => {
    while (swiping) {
      await sleep(500);
      const m = diagnostics(serial)?.metrics;
      if (m) samples.push({ fps: m.fps, bps: m.bytesPerSecond });
    }
  })();
  const end = Date.now() + ms;
  let up = true;
  while (Date.now() < end) {
    const x = size.w / 2;
    if (up) await swipe(serial, x, size.h * 0.75, x, size.h * 0.3, 250);
    else await swipe(serial, x, size.h * 0.3, x, size.h * 0.75, 250);
    up = !up;
  }
  swiping = false;
  await sampler;
  const steady = samples.slice(2);
  const avg = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null);
  return {
    fpsAvg: avg(steady.map((s) => s.fps)),
    fpsMax: Math.max(...samples.map((s) => s.fps)),
    bytesPerSecondAvg: avg(steady.map((s) => s.bps)),
    samples: samples.map((s) => s.fps),
  };
}

async function measureIdle(serial: string, ms: number) {
  // Past the 2 s rate window, so no motion from before is counted.
  await sleep(2_500);
  const samples: number[] = [];
  const bps: number[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(500);
    const m = diagnostics(serial)?.metrics;
    if (m) {
      samples.push(m.fps);
      bps.push(m.bytesPerSecond);
    }
  }
  return { fps: samples, bytesPerSecond: bps };
}

async function main(): Promise<void> {
  log("env", { node: process.version, platform: process.platform, sdk: SDK, adb: existsSync(ADB), emulator: existsSync(EMULATOR), jar: existsSync(JAR) });
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  log("memory", { freeMb });
  if (freeMb < 4_000) {
    log("abort.low_memory", { freeMb });
    return;
  }
  const devicesBefore = await runAdbText(ADB, ["devices"]);
  log("adb.devices.before", { devicesBefore });

  let port = 0;
  for (const candidate of [5610, 5612, 5614, 5616, 5618]) {
    if (FORBIDDEN_SERIALS.has(`emulator-${candidate}`)) continue;
    if (devicesBefore.includes(`emulator-${candidate}`)) continue;
    if ((await portFree(candidate)) && (await portFree(candidate + 1)) && (await portFree(candidate + 3000))) {
      port = candidate;
      break;
    }
  }
  if (!port) throw new Error("no free emulator port");
  const serial = `emulator-${port}`;
  const grpc = port + 3000;
  log("boot.start", { avd: AVD, serial, grpc });

  const bootAt = Date.now();
  const emulator: ChildProcess = spawn(EMULATOR, [
    "-avd", AVD, "-read-only", "-no-snapshot", "-no-window", "-no-audio", "-no-boot-anim",
    "-gpu", "auto", "-port", String(port), "-grpc", String(grpc),
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const emulatorTail: string[] = [];
  const keepTail = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) emulatorTail.push(line.trim());
    while (emulatorTail.length > 15) emulatorTail.shift();
  };
  emulator.stdout?.on("data", keepTail);
  emulator.stderr?.on("data", keepTail);
  let emulatorExited = false;
  emulator.once("exit", (code) => {
    emulatorExited = true;
    log("emulator.exit", { code });
  });

  try {
    const booted = await waitFor(async () => {
      if (emulatorExited) throw new Error(`emulator exited: ${emulatorTail.join(" | ")}`);
      const value = await runAdbText(ADB, ["shell", "getprop", "sys.boot_completed"], { serial, timeoutMs: 5_000, allowFailure: true }).catch(() => "");
      return value === "1";
    }, 180_000, 1_000);
    if (booted === null) throw new Error(`boot timed out: ${emulatorTail.join(" | ")}`);
    results.bootMs = Date.now() - bootAt;
    log("boot.done", { bootMs: results.bootMs });
    // Let first-boot work (dexopt, Play services) settle so numbers compare.
    await sleep(Number(process.env.ADE_STREAM_SETTLE_MS ?? 40_000));
    await runAdb(ADB, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], { serial, allowFailure: true });
    await runAdb(ADB, ["shell", "wm", "dismiss-keyguard"], { serial, allowFailure: true });

    // ── 1. start ────────────────────────────────────────────────────────────
    const startAt = Date.now();
    const transport = await startStream({ adbPath: ADB, serial, serverJarPath: JAR, laneId: "smoke" });
    results.startToTransportMs = Date.now() - startAt;
    const d0 = diagnostics(serial)!;
    results.startTimings = d0.timings;
    results.firstConfigMs = d0.metrics && d0.metrics.firstConfigAtMs ? d0.metrics.firstConfigAtMs - startAt : null;
    log("stream.started", { transport: { ...transport, token: "…", url: transport.url.replace(/token=[0-9a-f]+/, "token=…") }, diagnostics: d0 });
    await sleep(1_500);
    const d1 = diagnostics(serial)!;
    results.firstKeyframeMs = d1.metrics?.firstKeyframeAtMs ? d1.metrics.firstKeyframeAtMs - startAt : null;
    log("stream.first_keyframe", { firstKeyframeMs: results.firstKeyframeMs, deviceName: d1.deviceName, displaySize: d1.displaySize, devicePid: d1.devicePid });

    // Wrong token is refused.
    const badStatus = await new Promise<number>((resolve) => {
      http.get(transport.url.replace(/token=[0-9a-f]+/, "token=bad"), (r) => {
        resolve(r.statusCode ?? 0);
        r.resume();
      }).on("error", () => resolve(-1));
    });
    results.wrongTokenStatus = badStatus;

    const readerA = openReader("A", transport.url, true);
    await sleep(1_500);
    log("readerA.first", { firstRecords: readerA.firstRecords, firstRecordAfterMs: readerA.firstRecordAtMs ? readerA.firstRecordAtMs - readerA.openedAtMs : null });

    const display = d1.displaySize ?? { width: 1080, height: 2400 };
    const size = { w: display.width, h: display.height };

    // ── 2. idle fps ─────────────────────────────────────────────────────────
    await runAdb(ADB, ["shell", "input", "keyevent", "KEYCODE_HOME"], { serial, allowFailure: true });
    results.idle = await measureIdle(serial, 3_000);
    log("idle", results.idle as Record<string, unknown>);

    // ── 3. tap opens an app; HOME and BACK keys ─────────────────────────────
    const homeFocus = await focus(serial);
    const nodes = await uiNodes(serial);
    const wanted = ["Chrome", "Play Store", "Gmail", "Photos", "YouTube", "Phone", "Messages", "Settings", "Maps"];
    const target = nodes.find((node) => wanted.includes(node.text) || wanted.includes(node.desc));
    log("tap.target", { homeFocus, target, nodeCount: nodes.length });
    if (target) {
      const [x1, y1, x2, y2] = target.bounds;
      const tapAt = Date.now();
      await tap(serial, (x1 + x2) / 2, (y1 + y2) / 2);
      const changedAfter = await waitFor(async () => (await focus(serial)) !== homeFocus, 8_000);
      results.tap = { target: target.text || target.desc, before: homeFocus, after: await focus(serial), focusChangedAfterMs: changedAfter, sentAt: tapAt };
      log("tap.result", results.tap as Record<string, unknown>);
      await sleep(1_000);
      await sendKey(serial, "home");
      const homeAfter = await waitFor(async () => (await focus(serial)) === homeFocus, 6_000);
      results.homeKey = { returnedToLauncherAfterMs: homeAfter, focus: await focus(serial) };
      log("key.home", results.homeKey as Record<string, unknown>);
    }
    await runAdb(ADB, ["shell", "am", "start", "-n", "com.android.settings/.Settings"], { serial, allowFailure: true });
    await waitFor(async () => (await focus(serial)).includes("com.android.settings"), 6_000);
    const settingsFocus = await focus(serial);
    await sleep(800);
    await sendKey(serial, "back");
    const backAfter = await waitFor(async () => !(await focus(serial)).includes("com.android.settings"), 6_000);
    results.backKey = { before: settingsFocus, after: await focus(serial), leftSettingsAfterMs: backAfter };
    log("key.back", results.backKey as Record<string, unknown>);

    // ── 4. swipe fps (Settings list) ────────────────────────────────────────
    await runAdb(ADB, ["shell", "am", "start", "-n", "com.android.settings/.Settings"], { serial, allowFailure: true });
    await sleep(1_500);
    results.swipe = await measureSwiping(serial, 5_000, size);
    log("swipe", results.swipe as Record<string, unknown>);

    // ── 5. a second reader joins mid-stream ─────────────────────────────────
    const swipeTail = measureSwiping(serial, 2_500, size);
    await sleep(800);
    const beforeJoin = diagnostics(serial)!.metrics!;
    const readerB = openReader("B", transport.url);
    await swipeTail;
    await sleep(1_000);
    const afterJoin = diagnostics(serial)!.metrics!;
    results.joinMidStream = {
      firstRecords: readerB.firstRecords,
      firstRecordAfterMs: readerB.firstRecordAtMs ? readerB.firstRecordAtMs - readerB.openedAtMs : null,
      keyframesReceived: readerB.keyframes.length,
      freshKeyframeAfterMs: readerB.keyframes.length > 1 ? readerB.keyframes[1] - readerB.openedAtMs : null,
      deltasBeforeFirstKeyframe: readerB.deltasBeforeFirstKeyframe,
      accessUnits: readerB.accessUnits,
      keyframeRequests: afterJoin.totals.keyframeRequests - beforeJoin.totals.keyframeRequests,
      readers: afterJoin.readers,
      readerAMaxGapAroundJoinMs: (() => {
        const window = readerA.auAt.filter((at) => at >= readerB.openedAtMs - 300 && at <= readerB.openedAtMs + 3_000);
        let gap = 0;
        for (let i = 1; i < window.length; i += 1) gap = Math.max(gap, window[i] - window[i - 1]);
        return gap;
      })(),
    };
    log("join", results.joinMidStream as Record<string, unknown>);

    // ── 6. text into the Settings search field ──────────────────────────────
    try {
      const settingsNodes = await uiNodes(serial);
      const search = settingsNodes.find((node) => /search/i.test(node.id) || /search settings/i.test(node.text));
      if (search) {
        const [x1, y1, x2, y2] = search.bounds;
        await tap(serial, (x1 + x2) / 2, (y1 + y2) / 2);
        await sleep(3_000);
        await sendText(serial, "network");
        await sleep(1_000);
        const after = await uiNodes(serial);
        const field = after.find((node) => node.cls.includes("EditText"));
        results.text = { typed: "network", fieldText: field?.text ?? null };
      } else {
        results.text = { skipped: "no search field" };
      }
    } catch (error) {
      results.text = { error: error instanceof Error ? error.message : String(error) };
    }
    log("text", results.text as Record<string, unknown>);
    await sendKey(serial, "home");
    await sleep(1_000);

    // ── 7. rotation ─────────────────────────────────────────────────────────
    await runAdb(ADB, ["shell", "settings", "put", "system", "accelerometer_rotation", "1"], { serial, allowFailure: true });
    await runAdb(ADB, ["shell", "am", "start", "-n", "com.android.settings/.Settings"], { serial, allowFailure: true });
    await sleep(1_500);
    const configsBefore = readerA.configs.length;
    const rotateAt = Date.now();
    await runAdb(ADB, ["emu", "rotate"], { serial, allowFailure: true });
    let rotated = await waitFor(async () => readerA.configs.length > configsBefore, 6_000);
    let method = "emu rotate";
    if (rotated === null) {
      method = "settings user_rotation=1";
      await runAdb(ADB, ["shell", "settings", "put", "system", "accelerometer_rotation", "0"], { serial, allowFailure: true });
      await runAdb(ADB, ["shell", "settings", "put", "system", "user_rotation", "1"], { serial, allowFailure: true });
      rotated = await waitFor(async () => readerA.configs.length > configsBefore, 6_000);
    }
    const rotatedConfig = readerA.configs.at(-1)?.config;
    await sleep(1_000);
    // A tap in landscape is scaled with the swapped size.
    const landscapeDiag = diagnostics(serial)!;
    results.rotation = {
      method,
      newConfigAfterMs: rotated,
      configBefore: readerA.configs[configsBefore - 1]?.config,
      configAfter: rotatedConfig,
      keyframesAfterRotation: readerA.keyframes.filter((at) => at > rotateAt).length,
      metricsConfig: landscapeDiag.metrics?.config,
    };
    log("rotation", results.rotation as Record<string, unknown>);
    // Back to portrait.
    const configsMid = readerA.configs.length;
    if (method === "emu rotate") {
      for (let i = 0; i < 3; i += 1) await runAdb(ADB, ["emu", "rotate"], { serial, allowFailure: true });
    } else {
      await runAdb(ADB, ["shell", "settings", "put", "system", "user_rotation", "0"], { serial, allowFailure: true });
    }
    const back = await waitFor(async () => {
      const last = readerA.configs.at(-1)?.config as { width?: number; height?: number } | undefined;
      return readerA.configs.length > configsMid && Boolean(last && last.height! > last.width!);
    }, 8_000);
    results.rotationBack = { portraitAgainAfterMs: back, config: readerA.configs.at(-1)?.config };
    log("rotation.back", results.rotationBack as Record<string, unknown>);
    await sendKey(serial, "home");
    await sleep(1_000);

    // ── 8. the server dies; the stream restarts on the same transport ───────
    const pid = diagnostics(serial)?.devicePid;
    const keyframesBeforeKill = readerA.keyframes.length;
    const killAt = Date.now();
    if (pid) {
      await runAdb(ADB, ["shell", "kill", String(pid)], { serial, allowFailure: true });
      const recovered = await waitFor(async () => readerA.keyframes.length > keyframesBeforeKill && Boolean(diagnostics(serial)?.running), 15_000);
      const d = diagnostics(serial)!;
      results.restart = {
        killedPid: pid,
        newPid: d.devicePid,
        recoveredAfterMs: recovered,
        restarts: d.restarts,
        lastEnd: d.lastEnd && { reason: d.lastEnd.reason, message: d.lastEnd.message },
        readerAStillOpen: !readerA.request.destroyed,
        firstKeyframeAfterKillMs: readerA.keyframes.find((at) => at > killAt) ? readerA.keyframes.find((at) => at > killAt)! - killAt : null,
      };
      log("restart", results.restart as Record<string, unknown>);
      // Input works on the new run.
      await sendKey(serial, "home");
    }

    // ── 9. stop and clean-up ────────────────────────────────────────────────
    const scrcpyBefore = await runAdbText(ADB, ["shell", "ps", "-A", "-o", "PID,ARGS"], { serial }).catch(() => "");
    const forwardsBefore = await runAdbText(ADB, ["forward", "--list"]);
    const stopAt = Date.now();
    await stopStream(serial);
    results.stopMs = Date.now() - stopAt;
    await sleep(500);
    const forwardsAfter = await runAdbText(ADB, ["forward", "--list"]);
    const scrcpyAfter = await runAdbText(ADB, ["shell", "ps", "-A", "-o", "PID,ARGS"], { serial }).catch(() => "");
    results.cleanup = {
      serverProcessesBefore: scrcpyBefore.split(/\r?\n/).filter((line) => line.includes("scrcpy")),
      forwardsBefore: forwardsBefore.split(/\r?\n/).filter((line) => line.includes(serial)),
      serverProcessesAfter: scrcpyAfter.split(/\r?\n/).filter((line) => line.includes("scrcpy")),
      forwardsAfter: forwardsAfter.split(/\r?\n/).filter((line) => line.includes(serial)),
      readerAClosed: readerA.request.destroyed || readerA.request.socket?.destroyed,
    };
    log("cleanup", results.cleanup as Record<string, unknown>);

    // ── 10. decoded-frame proof ─────────────────────────────────────────────
    const h264Path = path.join(os.tmpdir(), "ade-android-stream-smoke.h264");
    writeFileSync(h264Path, Buffer.concat(readerA.aus));
    const ffprobe = await execText(process.platform === "win32" ? "where" : "which", ["ffprobe"]);
    if (/ffprobe/i.test(ffprobe) && !/error/.test(ffprobe)) {
      const probe = await execText("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,profile,width,height,nb_read_frames", "-of", "json", h264Path], 120_000);
      results.ffprobe = probe.trim();
    } else {
      results.ffprobe = `not installed (${readerA.aus.length} access units, ${Buffer.concat(readerA.aus).byteLength} bytes written to ${h264Path})`;
    }
    log("ffprobe", { ffprobe: results.ffprobe });

  } finally {
    await stopAllStreams().catch((error) => log("stopAll.error", { error: String(error) }));
    const leftForwards = (await runAdbText(ADB, ["forward", "--list"]).catch(() => "")).split(/\r?\n/).filter((line) => line.includes(serial));
    log("final.forwards", { leftForwards });
    log("emulator.kill", { serial });
    await runAdb(ADB, ["emu", "kill"], { serial, allowFailure: true, timeoutMs: 15_000 }).catch(() => undefined);
    const exited = await waitFor(async () => emulatorExited, 30_000, 500);
    if (exited === null) {
      log("emulator.kill.fallback", {});
      emulator.kill();
    }
    if (process.platform === "win32") {
      await sleep(2_000);
      const qemu = await execText("powershell", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name like 'qemu-system%'" | Where-Object { $_.CommandLine -like '*-port ${port}*' -or $_.CommandLine -like '*${AVD}*' } | Select-Object ProcessId,Name | Format-Table -HideTableHeaders | Out-String`]);
      log("qemu.left", { qemu: qemu.trim() || "none" });
    }
    const devicesAfter = await runAdbText(ADB, ["devices"]).catch(() => "");
    log("adb.devices.after", { devicesAfter });
    for (const [key, value] of Object.entries(results)) console.log(`RESULT ${key} = ${JSON.stringify(value, null, 1)}`);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("FAILED", error instanceof Error ? error.stack : error);
    for (const serial of ["emulator-5610", "emulator-5612", "emulator-5614"]) {
      const d = diagnostics(serial);
      if (d) console.log("DIAG " + JSON.stringify({ serial, lastEnd: d.lastEnd, restarts: d.restarts, failure: d.failure, serverLog: d.serverLog }));
    }
    console.log("RESULTS " + JSON.stringify(results, null, 2));
    process.exit(1);
  },
);
