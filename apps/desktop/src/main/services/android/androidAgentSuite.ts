import fs from "node:fs";
import path from "node:path";
import type {
  AndroidCapabilities,
  AndroidEmulatorAgentServiceApi,
  AndroidEmulatorServiceApi,
  AndroidLaneArgs,
  AndroidLaneDevice,
  AndroidLogLevel,
  AndroidProofBundle,
  AndroidRecording,
  AndroidScreenshot,
  AndroidScrollDirection,
  AndroidSdkStatus,
} from "../../../shared/types/androidEmulator";
import {
  ANDROID_LOG_LEVELS,
  ANDROID_LONG_PRESS_DEFAULT_MS,
  ANDROID_LONG_PRESS_MAX_MS,
  ANDROID_LONG_PRESS_MIN_MS,
  ANDROID_SCROLL_DIRECTIONS,
} from "../../../shared/types/androidEmulator";
import { createDeviceLeases } from "../device/deviceLease";
import type { Logger } from "../logging/logger";
import { getErrorMessage, sleep } from "../shared/utils";
import { runAdb } from "./adb";
import { assertPackageName, createAndroidApps } from "./androidApps";
import { androidLaunchWords, createAndroidAppState } from "./androidAppState";
import { createAndroidInstrumentationTests } from "./androidInstrumentationTests";
import { locateAndroidJdk } from "./androidJdk";
import { ROTATION_PROBE, parseRotation, parseWmSize, runAdbOutput, runDeviceScript, runDeviceShell, type BootedDevice } from "./androidDeviceShell";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
import { isLogcatCursor, logcatArgs, parseLogcatDump, parsePackageUid, parsePidof } from "./androidLogcat";
import { fileAndroidCaptureAsProof, type AndroidArtifactFiler } from "./androidProof";
import { createAndroidRecordingSessions } from "./androidRecordingSession";
import { createAndroidAutoRecord } from "./androidAutoRecord";
import type { DemoEngineSet } from "../demoVideo/demoEngines";
import { demoTypedLabelForField, demoUrlHost } from "../demoVideo/demoTrackTargets";
import type { AndroidMachinePreferences } from "../../../shared/types/androidEmulator";
import { androidLaneFolderName, containAndroidOutPath, writeAndroidFileNoFollow } from "./androidScreenshot";
import type { AndroidStreamHub } from "./androidStream";
import { createAndroidUiSnapshots, elementActionResult, readElementQuery } from "./androidUiSnapshot";
import { describeElementQuery, pickElement } from "./androidUiTree";

/*
 * The P1 agent suite: `ade android` at the level of `ade apple`. Apps, the
 * input verbs Apple has and P0 had not (long press, drag, scroll), the
 * element verbs over the UI tree (`androidUiSnapshot.ts`), logcat, the
 * recordings (`androidRecordingSession.ts`), the lease and the proof bundle.
 * The device settings and controls are in `androidDeviceSettings.ts`. The
 * service (`androidEmulatorService.ts`) spreads `api` into itself and calls
 * the hooks at its seams.
 *
 * Every point is in device pixels, the pixels of a screenshot and of the UI
 * tree, so an agent can read a point from either and tap it.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 120_000;
const WAIT_POLL_MS = 250;
const DRAG_HOLD_MS = 600;
const DRAG_DEFAULT_MS = 500;
const SCROLL_STROKE_MS = 350;
const LOG_DEFAULT_LINES = 200;
const LOG_MAX_LINES = 2_000;
const FILL_CLEAR_MAX = 200;
const KEYCODE_MOVE_END = 123;
const KEYCODE_DEL = 67;

type InputApi = Pick<AndroidEmulatorServiceApi, "tap" | "swipe" | "sendText">;

export type AndroidAgentSuiteDeps = {
  laneDevices: { get: (laneId: string) => AndroidLaneDevice | null; set: (device: AndroidLaneDevice) => void };
  requireBooted: (laneId: string) => Promise<BootedDevice>;
  /** The SDK as read now. */
  readSdk: () => Promise<AndroidSdkStatus>;
  laneRoot: (laneId: string) => string | null;
  isWorkCopy: (laneId: string) => boolean;
  /** Throws when the lane is a work copy that is gone. */
  assertWorkCopyLive: (laneId: string) => void;
  input: InputApi;
  streams: AndroidStreamHub;
  liveStreamSerial: (laneId: string) => string | null;
  /** Starts (or joins) the lane's stream for a recording; answers its serial. */
  holdStreamForRecording: (laneId: string) => Promise<string>;
  /** The recording is done with the stream; it stops unless a viewer holds it. */
  releaseStreamForRecording: (laneId: string) => Promise<void>;
  /** A screen capture with no proof filing (`takeAndroidScreenshot`). */
  captureScreen: (laneId: string, outPath: string | null) => Promise<AndroidScreenshot>;
  artifactFiler: AndroidArtifactFiler | null;
  /** Where proof is placed by path (the project's root). */
  callerRoot: string | null;
  dataDir: string;
  serverJarPath: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  logger: Logger | null;
  now: () => Date;
  /** A recording started or ended (by anyone): the panes read their Record button again. */
  onRecordingChanged?: (laneId: string, recording: AndroidRecording) => void;
  /** Rec: the engines that turn a stopped recording into its demo. */
  demoEngines?: DemoEngineSet | null;
  /** Rec: the machine preferences (overlays, auto-record), read at use. */
  readPreferences: () => AndroidMachinePreferences;
  /** Rec: the project's KV, for the lane's auto-record switch. */
  readSetting?: (<T>(key: string) => T | null) | null;
  writeSetting?: ((key: string, value: unknown) => void) | null;
  /** One coarse product fact for an app installed or a new lease. */
  captureAnalytics?: (outcome: "app_installed" | "device_leased" | "tests_run") => void;
};

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}

export function createAndroidAgentSuite(deps: AndroidAgentSuiteDeps) {
  const { platform, signal, logger, now } = deps;
  const leases = createDeviceLeases();

  const sdkRoot = async (): Promise<string> => {
    const sdk = await deps.readSdk();
    if (!sdk.root) throw new AndroidEmulatorFailure("ANDROID_SDK_NOT_FOUND", "No Android SDK is set up on this machine.");
    return sdk.root;
  };

  const rememberInstalled = (laneId: string, packageName: string) => {
    const device = deps.laneDevices.get(laneId);
    if (!device || device.adeInstalledPackages.includes(packageName)) return;
    deps.laneDevices.set({ ...device, adeInstalledPackages: [...device.adeInstalledPackages, packageName] });
  };
  const forgetInstalled = (laneId: string, packageName: string) => {
    const device = deps.laneDevices.get(laneId);
    if (!device || !device.adeInstalledPackages.includes(packageName)) return;
    deps.laneDevices.set({ ...device, adeInstalledPackages: device.adeInstalledPackages.filter((name) => name !== packageName) });
  };

  const apps = createAndroidApps({
    requireBooted: deps.requireBooted,
    sdkRoot,
    laneRoot: deps.laneRoot,
    isWorkCopy: deps.isWorkCopy,
    laneDevice: (laneId) => deps.laneDevices.get(laneId),
    rememberInstalled,
    forgetInstalled,
    platform,
    env: deps.env,
    signal,
    logger,
  });

  // P3: instrumentation tests, on the same Gradle runner as `install --gradle`.
  const instrumentation = createAndroidInstrumentationTests({
    requireBooted: deps.requireBooted,
    assertWorkCopyLive: deps.assertWorkCopyLive,
    laneRootOrRefuse: apps.laneRootOrRefuse,
    runGradleProcess: apps.runGradleProcess,
    gradleFailure: apps.gradleFailure,
    logger,
    captureAnalytics: deps.captureAnalytics,
  });

  const appState = createAndroidAppState({ requireBooted: deps.requireBooted, assertPackageName, signal, now });

  const ui = createAndroidUiSnapshots({
    requireBooted: deps.requireBooted,
    sdkRoot,
    platform,
    env: deps.env,
    signal,
    logger,
    now,
  });

  const sessions = createAndroidRecordingSessions({
    requireBooted: deps.requireBooted,
    assertWorkCopyLive: deps.assertWorkCopyLive,
    streams: deps.streams,
    holdStreamForRecording: deps.holdStreamForRecording,
    releaseStreamForRecording: deps.releaseStreamForRecording,
    artifactFiler: deps.artifactFiler,
    callerRoot: deps.callerRoot,
    dataDir: deps.dataDir,
    logger,
    now,
    onRecordingChanged: deps.onRecordingChanged,
    demoEngines: deps.demoEngines ?? null,
    readPreferences: deps.readPreferences,
    screenSize: (laneId) => screenSize(laneId),
    deviceName: (laneId) => deps.laneDevices.get(laneId)?.avdName ?? null,
  });

  // Rec: an agent's input starts a recording; every input is drawn on one (`androidAutoRecord.ts`).
  const autoRecord = createAndroidAutoRecord({
    sessions,
    readPreferences: deps.readPreferences,
    readSetting: deps.readSetting ?? null,
    writeSetting: deps.writeSetting ?? null,
    logger,
  });

  /* ---------- input ---------- */

  const longPressAt = async (laneId: string, x: number, y: number, durationMs: number) => {
    const serial = deps.liveStreamSerial(laneId);
    ui.invalidate(laneId);
    if (serial) {
      await deps.streams.sendTouch(serial, { action: "down", x, y });
      try {
        await sleep(durationMs);
      } finally {
        await deps.streams.sendTouch(serial, { action: "up", x, y }).catch(() => undefined);
      }
      return;
    }
    // A swipe that does not move is a press held for its duration.
    const booted = await deps.requireBooted(laneId);
    const point = [String(Math.round(x)), String(Math.round(y))];
    await runAdb(booted.adbPath, ["shell", "input", "swipe", ...point, ...point, String(Math.round(durationMs))], {
      serial: booted.serial,
      timeoutMs: durationMs + 15_000,
      signal,
    });
  };

  const screenSize = async (laneId: string): Promise<{ width: number; height: number }> => {
    const cached = ui.cachedSize(laneId);
    if (cached) return cached;
    const booted = await deps.requireBooted(laneId);
    const text = (await runDeviceScript(booted, "wm size", { timeoutMs: 15_000, signal })).text;
    const size = parseWmSize(text);
    if (!size) throw new Error(`The emulator did not say its screen size: ${text.slice(0, 200)}`);
    let { width, height } = size;
    // `wm size` is the natural orientation; the screen may be turned.
    const rotation = parseRotation((await runDeviceScript(booted, ROTATION_PROBE, { timeoutMs: 15_000, signal })).text);
    if (rotation === 1 || rotation === 3) [width, height] = [height, width];
    return { width, height };
  };

  /* ---------- the API ---------- */

  const laneOf = (args: AndroidLaneArgs | null | undefined): string => requireLaneId(args?.laneId);

  // The device settings and controls come from androidDeviceSettings.ts; the service adds them.
  const api: Omit<
    AndroidEmulatorAgentServiceApi,
    "releaseIfOwnedBy" | "getDeviceSettings" | "setDeviceSetting" | "setLocation" | "setAppearance" | "setPermission"
  > & Pick<AndroidEmulatorServiceApi, "relaunchApp" | "getAppState" | "getForegroundApp"> = {
    async listApps(args) {
      const laneId = laneOf(args);
      return { laneId, apps: await apps.listApps(laneId) };
    },

    async installApp(args) {
      const laneId = laneOf(args);
      deps.assertWorkCopyLive(laneId);
      const result = await apps.install(laneId, { apkPath: args.apkPath ?? null, gradle: args.gradle ?? null });
      ui.invalidate(laneId);
      deps.captureAnalytics?.("app_installed");
      return result;
    },

    async launchApp(args) {
      const laneId = laneOf(args);
      deps.assertWorkCopyLive(laneId);
      const wantsInstall = Boolean(args.apkPath?.trim() || args.gradle);
      const install = wantsInstall ? await apps.install(laneId, { apkPath: args.apkPath ?? null, gradle: args.gradle ?? null }) : null;
      if (install) deps.captureAnalytics?.("app_installed");
      // Checked before anything installs or starts: a bad extra refuses the whole launch.
      const launchWords = androidLaunchWords(args);
      const named = args.packageName?.trim() || null;
      const packageName = named ? assertPackageName(named) : install?.packageName ?? null;
      if (!packageName) {
        throw new Error(install
          ? "The build installed, but ADE could not read its package name. Pass --package <name> to launch it."
          : "launch needs --package <name>, or --apk / --gradle to install and launch.");
      }
      const started = await apps.start(laneId, packageName, args.activity ?? null, launchWords);
      ui.invalidate(laneId);
      return { laneId, packageName, activity: started.activity, install, totalTimeMs: started.totalTimeMs };
    },

    /** Parity (`ade apple relaunch`): force-stop, then the same start as `launch`, with new extras when given. */
    async relaunchApp(args) {
      const laneId = laneOf(args);
      const packageName = assertPackageName(args.packageName);
      const launchWords = androidLaunchWords(args);
      await apps.terminate(laneId, packageName);
      const started = await apps.start(laneId, packageName, args.activity ?? null, launchWords);
      ui.invalidate(laneId);
      return { laneId, packageName, activity: started.activity, install: null, totalTimeMs: started.totalTimeMs };
    },

    getAppState: (args) => appState.getAppState(args),
    getForegroundApp: (args) => appState.getForegroundApp(args),

    async terminateApp(args) {
      const laneId = laneOf(args);
      const packageName = assertPackageName(args.packageName);
      await apps.terminate(laneId, packageName);
      ui.invalidate(laneId);
      return { laneId, packageName };
    },

    async uninstallApp(args) {
      const laneId = laneOf(args);
      const packageName = assertPackageName(args.packageName);
      const uninstalled = await apps.uninstall(laneId, packageName);
      ui.invalidate(laneId);
      return { laneId, packageName, uninstalled };
    },

    async openUrl(args) {
      const laneId = laneOf(args);
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/u.test(url)) throw new Error("url must be a full URL with a scheme (https://…, myapp://…).");
      await autoRecord.around(laneId, args, () => apps.openUrl(laneId, url), () => ({ kind: "navigate", label: demoUrlHost(url) ?? url.split(":")[0] }));
      ui.invalidate(laneId);
      return { laneId, url };
    },

    async longPress(args) {
      const laneId = laneOf(args);
      const x = finiteNumber(args.x, "x");
      const y = finiteNumber(args.y, "y");
      const durationMs = clampNumber(args.durationMs, ANDROID_LONG_PRESS_DEFAULT_MS, ANDROID_LONG_PRESS_MIN_MS, ANDROID_LONG_PRESS_MAX_MS);
      await autoRecord.around(laneId, args, () => longPressAt(laneId, x, y, durationMs), () => ({ kind: "tap", x, y, seconds: durationMs / 1000 }));
    },

    async drag(args) {
      const laneId = laneOf(args);
      const fromX = finiteNumber(args.fromX, "fromX");
      const fromY = finiteNumber(args.fromY, "fromY");
      const toX = finiteNumber(args.toX, "toX");
      const toY = finiteNumber(args.toY, "toY");
      const durationMs = clampNumber(args.durationMs, DRAG_DEFAULT_MS, 50, 10_000);
      ui.invalidate(laneId);
      await autoRecord.beforeInput(laneId, args);
      autoRecord.note({
        laneId, chatSessionId: args.chatSessionId ?? null, kind: "drag", x: fromX, y: fromY, to: { x: toX, y: toY },
        atMs: Date.now(), seconds: (DRAG_HOLD_MS + durationMs) / 1000, source: args.source,
      });
      const serial = deps.liveStreamSerial(laneId);
      if (serial) {
        // Hold first, so the item lifts (a list reorder, an icon), then move.
        await deps.streams.sendTouch(serial, { action: "down", x: fromX, y: fromY });
        try {
          await sleep(DRAG_HOLD_MS);
          const steps = Math.max(1, Math.round(durationMs / 16));
          for (let step = 1; step <= steps; step += 1) {
            await sleep(durationMs / steps);
            const t = step / steps;
            await deps.streams.sendTouch(serial, { action: "move", x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t });
          }
        } finally {
          await deps.streams.sendTouch(serial, { action: "up", x: toX, y: toY }).catch(() => undefined);
        }
        return;
      }
      const booted = await deps.requireBooted(laneId);
      const points = [fromX, fromY, toX, toY].map((value) => String(Math.round(value)));
      const result = await runAdbOutput(booted, ["shell", "input", "draganddrop", ...points, String(Math.round(durationMs + DRAG_HOLD_MS))], {
        timeoutMs: durationMs + DRAG_HOLD_MS + 15_000,
        signal,
      });
      if (result.exitCode !== 0 || /Error|Unknown command/iu.test(result.text)) {
        throw new Error(`The emulator did not take the drag: ${result.text.slice(0, 200) || `exit ${result.exitCode}`}`);
      }
    },

    async scroll(args) {
      const laneId = laneOf(args);
      const direction = args.direction as AndroidScrollDirection;
      if (!(ANDROID_SCROLL_DIRECTIONS as readonly string[]).includes(direction)) {
        throw new Error(`direction must be ${ANDROID_SCROLL_DIRECTIONS.join(", ")}.`);
      }
      const hasAnchorX = args.anchorX != null;
      if (hasAnchorX !== (args.anchorY != null)) throw new Error("anchorX and anchorY must be given together.");
      const size = await screenSize(laneId);
      const vertical = direction === "up" || direction === "down";
      const axis = vertical ? size.height : size.width;
      const amount = args.amount == null ? Math.round(axis * 0.6) : finiteNumber(args.amount, "amount");
      if (amount <= 0) throw new Error("amount must be a positive number of device pixels.");
      const anchorX = hasAnchorX ? finiteNumber(args.anchorX, "anchorX") : size.width / 2;
      const anchorY = hasAnchorX ? finiteNumber(args.anchorY, "anchorY") : size.height / 2;
      // "down" shows what is below: the finger moves up. A stroke is at most
      // 70% of the screen; a longer scroll is several strokes.
      const sign = direction === "down" || direction === "right" ? -1 : 1;
      const stroke = Math.round(axis * 0.7);
      await autoRecord.beforeInput(laneId, args);
      const scrolledAtMs = Date.now();
      let left = amount;
      while (left > 0) {
        const step = Math.min(left, stroke);
        left -= step;
        const along = vertical ? anchorY : anchorX;
        const from = Math.min(axis - 1, Math.max(0, along - (sign * step) / 2));
        const to = Math.min(axis - 1, Math.max(0, along + (sign * step) / 2));
        await deps.input.swipe(vertical
          ? { laneId, fromX: anchorX, fromY: from, toX: anchorX, toY: to, durationMs: SCROLL_STROKE_MS }
          : { laneId, fromX: from, fromY: anchorY, toX: to, toY: anchorY, durationMs: SCROLL_STROKE_MS });
      }
      ui.invalidate(laneId);
      autoRecord.note({
        laneId, chatSessionId: args.chatSessionId ?? null, kind: "scroll", x: anchorX, y: anchorY,
        atMs: scrolledAtMs, seconds: (Date.now() - scrolledAtMs) / 1000, source: args.source,
      });
    },

    async getScreenSnapshot(args) {
      const laneId = laneOf(args);
      return ui.snapshot(laneId, { fresh: args.fresh === true });
    },

    async findElement(args) {
      const laneId = laneOf(args);
      const { picked } = await ui.find(laneId, readElementQuery(args), false);
      return elementActionResult("find", picked);
    },

    async tapElement(args) {
      const laneId = laneOf(args);
      const { picked, element } = await ui.find(laneId, readElementQuery(args), false);
      const holdMs = args.holdMs == null ? null : clampNumber(args.holdMs, ANDROID_LONG_PRESS_DEFAULT_MS, ANDROID_LONG_PRESS_MIN_MS, ANDROID_LONG_PRESS_MAX_MS);
      const { x, y } = element.center;
      await autoRecord.around(
        laneId,
        args,
        () => (holdMs ? longPressAt(laneId, x, y, holdMs) : deps.input.tap({ laneId, x, y })),
        () => ({ kind: "tap", x, y }),
      );
      ui.invalidate(laneId);
      return elementActionResult("tap", picked);
    },

    async fillElement(args) {
      const laneId = laneOf(args);
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) throw new Error("fill needs the text to type (--value).");
      const query = readElementQuery(args);
      const { picked, element } = await ui.find(laneId, query, false);
      await autoRecord.beforeInput(laneId, args);
      if (args.focusFirst !== false) {
        const tappedAtMs = Date.now();
        await deps.input.tap({ laneId, x: element.center.x, y: element.center.y });
        autoRecord.note({ laneId, chatSessionId: args.chatSessionId ?? null, kind: "tap", x: element.center.x, y: element.center.y, atMs: tappedAtMs, source: args.source });
      }
      // Replace what the field holds: go to its end and delete back. A hint
      // reads as text in the tree too; extra deletes in an empty field are harmless.
      const existing = Math.min(FILL_CLEAR_MAX, element.text?.length ?? 0);
      if (existing > 0) {
        const booted = await deps.requireBooted(laneId);
        await runAdb(booted.adbPath, ["shell", "input", "keyevent", String(KEYCODE_MOVE_END), ...Array.from({ length: existing }, () => String(KEYCODE_DEL))], {
          serial: booted.serial,
          timeoutMs: 30_000,
          signal,
        });
      }
      const typed = await autoRecord.typePaced(laneId, text, (piece) => deps.input.sendText({ laneId, text: piece }));
      // A password field never shows its text in a video; nor does a field whose name suggests a secret.
      const label = element.password
        ? undefined
        : demoTypedLabelForField(text, [element.label, element.identifier, element.resourceId, element.text]);
      autoRecord.note({
        laneId, chatSessionId: args.chatSessionId ?? null, kind: "type",
        ...(label ? { label } : {}), atMs: typed.atMs, ...(typed.seconds ? { seconds: typed.seconds } : {}), source: args.source,
      });
      ui.invalidate(laneId);
      if (element.password) return elementActionResult("fill", picked, { typed: "unknown", typedDetail: "A password field does not show its text, so ADE cannot check it." });
      // Read the field back: a keyboard that dropped characters reads as not-seen.
      try {
        const isTextField = (candidate: { className?: string | null; role?: string | null }) =>
          /EditText|TextField/iu.test(candidate.className ?? candidate.role ?? "");
        const readBack = async () => {
          const after = await ui.snapshot(laneId, { fresh: true });
          const same = after.elements.find((candidate) =>
            (element.resourceId && candidate.resourceId === element.resourceId) || candidate.path === element.path) ?? null;
          if (same?.text?.includes(text)) return { same, seen: true };
          // A web field (Chrome, a WebView) has no resource id, and its tree path
          // and place move when the page reflows (google.com lifts its box to the
          // top and opens suggestions). A text field that now shows the text is it.
          const moved = after.elements.find((candidate) => isTextField(candidate) && Boolean(candidate.text?.includes(text))) ?? null;
          return { same: moved ?? same, seen: moved !== null };
        };
        await sleep(300);
        let read = await readBack();
        // A web page under load can show the text a moment later: one more read.
        if (!read.seen && !element.resourceId) {
          await sleep(1_000);
          read = await readBack();
        }
        const { same, seen } = read;
        return elementActionResult("fill", picked, {
          typed: seen ? "verified" : "not-seen",
          typedDetail: seen ? null : `The field now reads ${JSON.stringify(same?.text ?? null)}. Characters the emulator keyboard has no key for (most non-ASCII) are skipped.`,
        });
      } catch (error) {
        return elementActionResult("fill", picked, { typed: "unknown", typedDetail: getErrorMessage(error) });
      }
    },

    async waitForElement(args) {
      const laneId = laneOf(args);
      const query = readElementQuery(args);
      const timeoutMs = clampNumber(args.timeoutMs, WAIT_DEFAULT_MS, 0, WAIT_MAX_MS);
      const wantGone = args.state === "gone";
      const startedAt = Date.now();
      for (;;) {
        const snapshot = await ui.snapshot(laneId, { fresh: true });
        const picked = pickElement(snapshot.elements, query);
        const waitedMs = Date.now() - startedAt;
        if (wantGone ? !picked.match : Boolean(picked.match)) return elementActionResult("wait", picked, { waitedMs });
        if (waitedMs >= timeoutMs || signal.aborted) {
          throw new AndroidEmulatorFailure(
            "ANDROID_WAIT_TIMEOUT",
            wantGone
              ? `${describeElementQuery(query)} was still on screen after ${Math.round(waitedMs / 100) / 10} s.`
              : `${describeElementQuery(query)} did not appear within ${Math.round(waitedMs / 100) / 10} s. Run ade android snapshot to see the screen.`,
          );
        }
        await sleep(WAIT_POLL_MS);
      }
    },

    async assertVisible(args) {
      const laneId = laneOf(args);
      const { picked } = await ui.find(laneId, readElementQuery(args), true);
      return elementActionResult("assert", picked);
    },

    async readLog(args) {
      const laneId = laneOf(args);
      const level = args.level ?? null;
      if (level && !(ANDROID_LOG_LEVELS as readonly string[]).includes(level)) {
        throw new Error(`level must be ${ANDROID_LOG_LEVELS.join(", ")}.`);
      }
      const since = args.since?.trim() || null;
      if (since && !isLogcatCursor(since)) throw new Error("since must be the cursor a log read printed (epoch seconds, like 1730000000.123).");
      const lines = Math.round(clampNumber(args.lines, LOG_DEFAULT_LINES, 1, LOG_MAX_LINES));
      const packageName = args.packageName?.trim() ? assertPackageName(args.packageName) : null;
      const booted = await deps.requireBooted(laneId);
      let pids: number[] = [];
      let uid: number | null = null;
      if (packageName) {
        pids = parsePidof((await runDeviceShell(booted.adbPath, booted.serial, ["pidof", packageName], { timeoutMs: 10_000, signal })).stdout);
        if (pids.length === 0) {
          // Not running: its uid still finds the lines of a process that died (a crash).
          uid = parsePackageUid((await runDeviceShell(booted.adbPath, booted.serial, ["pm", "list", "packages", "-U", packageName], { timeoutMs: 10_000, signal })).stdout, packageName);
          if (uid === null) {
            throw new AndroidEmulatorFailure("ANDROID_APP_NOT_FOUND", `${packageName} is not installed on this lane's emulator.`);
          }
        }
      }
      const result = await runAdb(booted.adbPath, logcatArgs({
        level: level as AndroidLogLevel | null,
        since,
        pid: pids.length === 1 ? pids[0] : null,
        uid,
      }), { serial: booted.serial, timeoutMs: 30_000, signal, allowFailure: true });
      const parsed = parseLogcatDump(result.stdout.toString("utf8"), { pids: pids.length > 1 ? pids : null, since });
      const kept = parsed.slice(-lines);
      return {
        laneId,
        packageName,
        pids,
        lines: kept,
        truncated: parsed.length > kept.length,
        cursor: kept.at(-1)?.time ?? since,
      };
    },

    ...sessions.api,

    async deviceLease(args) {
      const laneId = laneOf(args);
      const avdName = deps.laneDevices.get(laneId)?.avdName ?? null;
      const leaseSignal = args.connectionSignal instanceof AbortSignal ? args.connectionSignal : null;
      const holder = args.holder?.trim() || args.chatSessionId?.trim() || "agent";
      const result = await leases.acquire({
        key: laneId,
        holder,
        chat: args.chatSessionId,
        ttlMs: args.ttlMs,
        waitMs: args.waitMs,
        token: args.token,
        distinct: args.distinct === true,
        signal: leaseSignal,
      });
      if (leaseSignal?.aborted && result.acquired && !result.renewed && result.token) {
        // Granted as the caller went away: nobody will see this token.
        leases.release({ key: laneId, token: result.token });
        return { acquired: false, current: null, queued: 0, device: { avdName } };
      }
      // A renewal or a busy answer is not a new lease.
      if (result.acquired && !result.renewed) deps.captureAnalytics?.("device_leased");
      return { ...result, device: { avdName } };
    },

    async deviceLeaseRelease(args) {
      const laneId = laneOf(args);
      const token = typeof args.token === "string" ? args.token.trim() : "";
      if (!token) throw new Error("A lease release needs the token `android lease` printed: ade android lease release --token <t>.");
      const key = leases.keyOfToken(token, (candidate) => candidate === laneId);
      if (!key) {
        return {
          released: false,
          device: null,
          reason: "This token holds no lease on this lane's emulator. It was released already, it lapsed (a lease lasts its --ttl unless renewed), "
            + "or it is from another lane. Run ade android lease status to see who has the device.",
        };
      }
      leases.release({ key, token });
      return { released: true, device: { avdName: deps.laneDevices.get(laneId)?.avdName ?? null } };
    },

    async deviceLeaseStatus(args) {
      const laneId = laneOf(args);
      return { ...leases.status(laneId), device: { avdName: deps.laneDevices.get(laneId)?.avdName ?? null } };
    },

    async captureProofBundle(args) {
      const laneId = laneOf(args);
      const capturedAt = now();
      const stamp = capturedAt.toISOString().replace(/[:.]/gu, "-");
      let dir: string;
      let chosenRoot: string | null = null;
      if (args.outDir?.trim()) {
        chosenRoot = deps.laneRoot(laneId);
        if (!chosenRoot) {
          throw new AndroidEmulatorFailure("ANDROID_PATH_OUTSIDE_LANE", "ADE cannot find this lane's folder, so it will not write a bundle to a chosen path. Leave --out out.");
        }
        dir = containAndroidOutPath(args.outDir.trim(), chosenRoot, platform);
      } else {
        dir = path.join(deps.dataDir, "proof-bundles", androidLaneFolderName(laneId), stamp);
      }
      fs.mkdirSync(dir, { recursive: true });
      /**
       * Writes one bundle file. In a chosen folder each path is checked again
       * right before its write (a link can be swapped in while the bundle is
       * made), and no file is opened through a link.
       */
      const writeBundleFile = (name: string, data: string | Uint8Array): string => {
        const target = path.join(dir, name);
        if (chosenRoot) containAndroidOutPath(target, chosenRoot, platform);
        writeAndroidFileNoFollow(target, data);
        return target;
      };
      const shot = await deps.captureScreen(laneId, null);
      let screenshotPath: string;
      try {
        screenshotPath = writeBundleFile("screen.png", fs.readFileSync(shot.path));
      } finally {
        fs.rmSync(shot.path, { force: true });
      }
      let elementsPath: string | null = null;
      let foregroundPackage: string | null = null;
      if (args.includeElements !== false) {
        try {
          const snapshot = await ui.snapshot(laneId, { fresh: false });
          foregroundPackage = snapshot.foregroundPackage;
          elementsPath = writeBundleFile("elements.json", `${JSON.stringify(snapshot, null, 2)}\n`);
        } catch (error) {
          logger?.warn("android.proof_bundle_elements_failed", { laneId, error: getErrorMessage(error) });
        }
      }
      let logPath: string | null = null;
      const logLines = Math.round(clampNumber(args.logLines, LOG_DEFAULT_LINES, 0, LOG_MAX_LINES));
      if (logLines > 0) {
        try {
          const packageName = args.packageName?.trim() || null;
          const log = await api.readLog({ laneId, packageName, lines: logLines });
          logPath = writeBundleFile(
            "logcat.txt",
            log.lines.map((line) => `${line.time} ${line.pid} ${line.tid} ${line.level} ${line.tag}: ${line.message}`).join("\n") + "\n",
          );
        } catch (error) {
          logger?.warn("android.proof_bundle_log_failed", { laneId, error: getErrorMessage(error) });
        }
      }
      const device = deps.laneDevices.get(laneId);
      const metaPath = writeBundleFile("meta.json", `${JSON.stringify({
        laneId,
        avdName: device?.avdName ?? null,
        profileId: device?.profileId ?? null,
        capturedAt: capturedAt.toISOString(),
        caption: args.caption?.trim() || null,
        width: shot.width,
        height: shot.height,
        foregroundPackage,
      }, null, 2)}\n`);
      const bundle: AndroidProofBundle = {
        dir,
        screenshotPath,
        elementsPath,
        logPath,
        metaPath,
        width: shot.width,
        height: shot.height,
        capturedAt: capturedAt.toISOString(),
        proofArtifactId: null,
      };
      if (args.proof === false) return bundle;
      const proofArtifactId = fileAndroidCaptureAsProof(deps.artifactFiler, {
        laneId,
        chatSessionId: args.chatSessionId ?? null,
        kind: "screenshot",
        path: screenshotPath,
        mimeType: "image/png",
        title: args.caption?.trim() || "Android emulator proof bundle",
        description: `Screen of the lane's Android emulator at ${bundle.capturedAt}, with its UI tree and log in ${dir}.`,
        toolName: "android_proof_bundle",
        source: "ade-capture",
        callerRoot: deps.callerRoot,
        metadata: { bundleDir: dir, elementsPath, logPath, width: shot.width, height: shot.height },
      }, (error) => logger?.warn("android.proof_bundle_file_failed", { laneId, error: getErrorMessage(error) }));
      return { ...bundle, proofArtifactId };
    },
  };

  return {
    api,
    invalidateUi: ui.invalidate,
    /** Rec: the lane's recordings, for the service's own input verbs, the turn end and the storage count. */
    recordings: sessions,
    autoRecord,

    /** P3: `ade android test`. The run leaves the screen changed, so the UI tree is read again after it. */
    async runInstrumentationTests(args: Parameters<typeof instrumentation.runInstrumentationTests>[0]) {
      try {
        return await instrumentation.runInstrumentationTests(args);
      } finally {
        if (typeof args?.laneId === "string") ui.invalidate(args.laneId.trim());
      }
    },

    /** Files a screenshot into the calling chat's proof drawer; null without a drawer. */
    fileScreenshot(laneId: string, shot: AndroidScreenshot, chatSessionId: string | null, caption: string | null): string | null {
      return fileAndroidCaptureAsProof(deps.artifactFiler, {
        laneId,
        chatSessionId,
        kind: "screenshot",
        path: shot.path,
        mimeType: "image/png",
        title: caption?.trim() || "Android emulator screenshot",
        description: `Screen of the lane's Android emulator at ${shot.capturedAt}.`,
        toolName: "android_screenshot",
        source: "ade-capture",
        callerRoot: deps.callerRoot,
        metadata: { width: shot.width, height: shot.height, capturedAt: shot.capturedAt },
      }, (error) => logger?.warn("android.screenshot_proof_failed", { laneId, error: getErrorMessage(error) }));
    },

    /** What this machine can do for an agent, for `status`. Cheap: no adb call, and it never waits for the Android CLI. */
    async capabilities(sdk: AndroidSdkStatus): Promise<AndroidCapabilities> {
      const adb = sdk.tools.some((tool) => tool.id === "platform-tools" && tool.available);
      const { uiTree, androidCli } = await ui.source(sdk, adb);
      const stream = adb && fs.existsSync(deps.serverJarPath);
      const { jdk } = await locateAndroidJdk({ env: deps.env, platform });
      return {
        adb,
        stream,
        record: stream,
        uiTree,
        logcat: adb,
        gradle: adb && jdk !== null,
        jdk: jdk ? { home: jdk.home, source: jdk.source, version: jdk.version } : null,
        androidCli,
      };
    },

    /** True while a recording holds the lane's stream. */
    isRecording: sessions.isRecording,

    /** The lane's emulator booted: per-boot device setup (Chrome's first run) runs again. */
    onDeviceBooted: (laneId: string): void => apps.forgetBoot(laneId),

    /** Parity (idle power-off): an agent holds the lane's lease now. */
    isLeased: (laneId: string): boolean => leases.status(laneId).held,

    /** The lane's stream is about to stop (the device stopped or crashed): end its recording first. */
    async onStreamEnding(laneId: string): Promise<void> {
      await sessions.finishQuietly(laneId, "device-off", "android.recording_device_off_failed");
    },

    /**
     * The lane lets its device go: end its recording, and on an AVD the lane
     * attached (the user's own), remove each package ADE installed there. A
     * created AVD is deleted whole, so it needs no uninstall. Never throws.
     */
    async beforeRelease(laneId: string): Promise<void> {
      await sessions.finishQuietly(laneId, "released", "android.recording_release_failed", { waitForStart: true });
      ui.invalidate(laneId);
      const device = deps.laneDevices.get(laneId);
      if (!device || device.origin !== "attached" || device.adeInstalledPackages.length === 0) return;
      const removed = await apps.uninstallAdePackages(laneId, device.adeInstalledPackages).catch((error: unknown) => {
        logger?.warn("android.release_uninstall_failed", { laneId, error: getErrorMessage(error) });
        return [] as string[];
      });
      logger?.info("android.release_uninstalled", { laneId, avdName: device.avdName, removed, asked: device.adeInstalledPackages.length });
    },

    /** A chat ended: its recordings stop (filed as proof) and its leases pass on. */
    async releaseIfOwnedBy(chatSessionId: string): Promise<void> {
      const chat = chatSessionId?.trim();
      if (!chat) return;
      for (const laneId of sessions.lanesOfChat(chat)) {
        await sessions.finishQuietly(laneId, "chat-ended", "android.recording_chat_end_failed");
      }
      const ended = leases.endChat(chat);
      if (ended > 0) logger?.info("android.device_leases_ended_with_chat", { chatSessionId: chat, count: ended });
    },

    async dispose(): Promise<void> {
      autoRecord.dispose();
      await sessions.dispose();
      leases.dispose();
      ui.clear();
    },
  };
}
