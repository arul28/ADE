import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  AndroidCapabilities,
  AndroidElementActionResult,
  AndroidElementQuery,
  AndroidElementQueryArgs,
  AndroidEmulatorAgentServiceApi,
  AndroidEmulatorServiceApi,
  AndroidLaneArgs,
  AndroidLaneDevice,
  AndroidLogLevel,
  AndroidProofBundle,
  AndroidRecording,
  AndroidRecordingStopReason,
  AndroidScreenshot,
  AndroidScrollDirection,
  AndroidSdkStatus,
  AndroidUiElement,
  AndroidUiSnapshot,
  AndroidUiTreeSource,
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
import { androidCliArgs, locateAndroidCli } from "./androidCli";
import { locateAndroidJdk } from "./androidJdk";
import { runDeviceShell } from "./androidDeviceShell";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
import { isLogcatCursor, logcatArgs, parseLogcatDump, parsePackageUid, parsePidof } from "./androidLogcat";
import { fileAndroidCaptureAsProof, type AndroidArtifactFiler } from "./androidProof";
import {
  androidRecordingCapMs,
  androidRecordingsDir,
  createAndroidMp4Recorder,
  deleteAndroidRecording,
  listAndroidRecordings,
  newAndroidRecordingId,
  writeAndroidRecordingSidecar,
} from "./androidRecording";
import { containAndroidOutPath } from "./androidScreenshot";
import type { AndroidStreamHub } from "./androidStream";
import {
  describeElementQuery,
  hasElementQuery,
  parseAndroidCliLayout,
  parseUiautomatorXml,
  pickElement,
  type ParsedUiTree,
} from "./androidUiTree";

/*
 * The P1 agent suite: `ade android` at the level of `ade apple`. Apps, the
 * input verbs Apple has and P0 had not (long press, drag, scroll), the UI
 * tree and the element verbs, logcat, recordings, the lease, three emulator
 * controls and the proof bundle. The service (`androidEmulatorService.ts`)
 * spreads `api` into itself and calls the hooks at its seams.
 *
 * Every point is in device pixels, the pixels of a screenshot and of the UI
 * tree, so an agent can read a point from either and tap it.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** A cached UI tree serves this long, while no input came and the focused window is the same. */
const UI_CACHE_TTL_MS = 5_000;
const UI_DUMP_TIMEOUT_MS = 30_000;
/** A first `android layout` unpacks the CLI's bundle (~150 MB). */
const ANDROID_CLI_LAYOUT_TIMEOUT_MS = 120_000;
/** After a failed `android layout`, uiautomator serves for this long before the CLI is tried again. */
const ANDROID_CLI_RETRY_MS = 10 * 60_000;
/** The package of the server `android layout` installs and leaves running on the device. */
const ANDROID_CLI_LAYOUT_PACKAGE = "com.android.cli.interact.instrumentation";

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

type BootedDevice = { serial: string; adbPath: string };

/** `uiautomator dump` prints a bare "Killed" when it cannot get UI automation. */
function isKilled(text: string): boolean {
  return /^\s*Killed\s*$/mu.test(text);
}

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
};

type UiCacheEntry = { at: number; focus: string | null; snapshot: AndroidUiSnapshot };

type ActiveRecording = {
  recording: AndroidRecording;
  recorder: ReturnType<typeof createAndroidMp4Recorder>;
  untap: () => void;
  capTimer: ReturnType<typeof setTimeout> | null;
  finishing: Promise<AndroidRecording> | null;
};

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}

/** The focused window line (`mCurrentFocus=Window{… u0 com.app/com.app.Main}`) and its package. */
function parseFocus(text: string): { focus: string | null; packageName: string | null } {
  const line = /mCurrentFocus=(.*)$/mu.exec(text)?.[1]?.trim() ?? null;
  const packageName = line ? /\s([A-Za-z][\w.]*)\/[\w.$]+\}?\s*$/u.exec(line)?.[1] ?? null : null;
  return { focus: line, packageName };
}

/** The XML a `uiautomator dump /dev/tty` printed, without its trailing status line. */
function extractUiXml(text: string): string | null {
  const start = text.indexOf("<?xml");
  const end = text.lastIndexOf("</hierarchy>");
  if (start < 0 || end < start) return null;
  return text.slice(start, end + "</hierarchy>".length);
}

/** `camera` → `android.permission.CAMERA`; a dotted name stays as it is. */
export function androidPermissionName(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z][\w.]*$/u.test(trimmed)) throw new Error(`permission ${JSON.stringify(value)} is not a permission name.`);
  return trimmed.includes(".") ? trimmed : `android.permission.${trimmed.toUpperCase()}`;
}

function runFile(file: string, args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: options.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: options.env,
      signal: options.signal,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${path.basename(file)} ${args.filter((arg) => !arg.startsWith("--sdk=")).join(" ")} failed: ${String(stderr || error.message).trim().slice(0, 400)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function createAndroidAgentSuite(deps: AndroidAgentSuiteDeps) {
  const { platform, signal, logger, now } = deps;
  const uiCache = new Map<string, UiCacheEntry>();
  const recordings = new Map<string, ActiveRecording>();
  /** A recording that ended on its own (its cap, the device going off) and no stop has collected yet. */
  const uncollected = new Map<string, AndroidRecording>();
  const leases = createDeviceLeases();
  let androidCliFailedAt = 0;

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

  /** Anything that changes the screen ends the lane's cached tree. */
  const invalidateUi = (laneId: string) => {
    uiCache.delete(laneId);
  };

  const shellLine = async (booted: BootedDevice, line: string, timeoutMs = 15_000) => {
    const result = await runAdb(booted.adbPath, ["shell", line], { serial: booted.serial, timeoutMs, signal, allowFailure: true });
    return `${result.stdout.toString("utf8")}${result.stderr}`;
  };

  const readFocus = async (booted: BootedDevice) => parseFocus(await shellLine(booted, "dumpsys window | grep -m1 mCurrentFocus"));

  /* ---------- the UI tree ---------- */

  /**
   * Stops the Android CLI's layout server (`android layout` leaves it running
   * on the device). It holds the device's one UiAutomation connection, so
   * `uiautomator dump` cannot run next to it ("Killed"). The next
   * `android layout` starts it again.
   */
  const stopAndroidCliServer = async (booted: BootedDevice) => {
    await shellLine(booted, `am force-stop ${ANDROID_CLI_LAYOUT_PACKAGE}`, 10_000).catch(() => "");
  };

  const dumpWithUiautomator = async (booted: BootedDevice): Promise<ParsedUiTree> => {
    let lastText = "";
    let freedCliServer = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(500);
      const direct = await runAdb(booted.adbPath, ["exec-out", "uiautomator", "dump", "/dev/tty"], {
        serial: booted.serial,
        timeoutMs: UI_DUMP_TIMEOUT_MS,
        signal,
        allowFailure: true,
      });
      lastText = `${direct.stdout.toString("utf8")}${direct.stderr}`;
      let xml = extractUiXml(lastText);
      if (!xml && !/idle state/iu.test(lastText) && !isKilled(lastText)) {
        // Some images cannot write to /dev/tty: write a file and read it back.
        const viaFile = await runDeviceShell(booted.adbPath, booted.serial, [
          "sh", "-c", "uiautomator dump /data/local/tmp/ade-ui.xml >/dev/null && cat /data/local/tmp/ade-ui.xml",
        ], { timeoutMs: UI_DUMP_TIMEOUT_MS, signal });
        lastText = viaFile.text;
        xml = extractUiXml(viaFile.stdout);
      }
      if (xml) return parseUiautomatorXml(xml);
      if (isKilled(lastText) && !freedCliServer) {
        // Another UiAutomation client holds the device: most often the CLI's layout server.
        freedCliServer = true;
        await stopAndroidCliServer(booted);
      }
    }
    const busy = /idle state/iu.test(lastText);
    throw new AndroidEmulatorFailure(
      "ANDROID_UI_TREE_FAILED",
      busy
        ? "The screen kept changing (an animation or a video), so uiautomator could not read it. Wait for the screen to settle and try again, or use a screenshot."
        : isKilled(lastText)
          ? "uiautomator could not connect to the device's UI automation (\"Killed\"): another client holds it. "
            + "ADE stopped the Android CLI's layout server and tried again, and the connection was still taken: "
            + "an instrumentation test (`am instrument`, a Gradle connectedCheck) or another tool can hold it. "
            + "Stop that run and try again, or use a screenshot."
          : `uiautomator could not read the screen: ${lastText.trim().slice(0, 300) || "no output"}.`,
    );
  };

  /**
   * `android layout` waits for the screen to settle first. A screen that
   * never settles (the launcher's animated icons, a video) answers "Could not
   * obtain idle state": then it is read as it is (`--no-idle`). Measured on
   * API 37: 3.0 s settled, 1.0 s with `--no-idle`. The first call on a device
   * installs the CLI's layout server and prints a line about it before the
   * JSON; `parseAndroidCliLayout` skips that line. The server stays on the
   * device between calls, so `uiautomator dump` cannot run while it does
   * (`stopAndroidCliServer`).
   */
  const dumpWithAndroidCli = async (booted: BootedDevice, cliPath: string, root: string): Promise<ParsedUiTree> => {
    const run = (extra: string[]) => runFile(cliPath, androidCliArgs(root, ["layout", `--device=${booted.serial}`, ...extra]), {
      timeoutMs: ANDROID_CLI_LAYOUT_TIMEOUT_MS,
      env: { ...deps.env, ANDROID_HOME: root, ANDROID_SDK_ROOT: root },
      signal,
    });
    let stdout: string;
    try {
      stdout = await run([]);
    } catch (error) {
      if (!/idle state/iu.test(getErrorMessage(error))) throw error;
      stdout = await run(["--no-idle"]);
    }
    return parseAndroidCliLayout(stdout);
  };

  const snapshotLane = async (laneId: string, options: { fresh: boolean }): Promise<AndroidUiSnapshot> => {
    const booted = await deps.requireBooted(laneId);
    const focus = await readFocus(booted);
    const cached = uiCache.get(laneId);
    if (!options.fresh && cached && Date.now() - cached.at < UI_CACHE_TTL_MS && cached.focus === focus.focus) {
      return { ...cached.snapshot, cached: true };
    }
    const startedAt = Date.now();
    let tree: ParsedUiTree | null = null;
    let source: AndroidUiTreeSource = "uiautomator";
    if (Date.now() - androidCliFailedAt > ANDROID_CLI_RETRY_MS) {
      const root = await sdkRoot().catch(() => null);
      const cli = root ? await locateAndroidCli({ sdkRoot: root, env: deps.env, platform }) : null;
      if (cli && root) {
        try {
          tree = await dumpWithAndroidCli(booted, cli.path, root);
          source = "android-cli";
        } catch (error) {
          androidCliFailedAt = Date.now();
          logger?.warn("android.ui_tree_cli_failed", { laneId, error: getErrorMessage(error) });
          // Its server can still hold UI automation; free it for uiautomator.
          await stopAndroidCliServer(booted);
        }
      }
    }
    tree ??= await dumpWithUiautomator(booted);
    const snapshot: AndroidUiSnapshot = {
      laneId,
      source,
      capturedAt: now().toISOString(),
      durationMs: Date.now() - startedAt,
      cached: false,
      width: tree.width,
      height: tree.height,
      foregroundPackage: focus.packageName,
      elements: tree.elements,
    };
    uiCache.set(laneId, { at: Date.now(), focus: focus.focus, snapshot });
    return snapshot;
  };

  const readQuery = (args: AndroidElementQueryArgs): AndroidElementQuery => {
    const query = args.query ?? {};
    if (!hasElementQuery(query)) throw new Error("Name the element: --ref, --identifier, --label, --text or --role.");
    if (query.index != null && (!Number.isInteger(query.index) || query.index < 0)) throw new Error("index must be a whole number, 0 or more.");
    return query;
  };

  /** A refusal that lists a few elements that are on screen, so the next try can aim better. */
  const notFound = (query: AndroidElementQuery, snapshot: AndroidUiSnapshot, matchCount: number): AndroidEmulatorFailure => {
    const named = snapshot.elements
      .filter((element) => element.label || element.text || element.identifier)
      .slice(0, 12)
      .map((element) => element.ref);
    const what = describeElementQuery(query);
    const detail = matchCount > 0 && typeof query.index === "number"
      ? `${matchCount} element(s) match ${what.replace(/ --index \d+$/u, "")}, so there is no --index ${query.index}.`
      : `No element on screen matches ${what}.`;
    return new AndroidEmulatorFailure(
      "ANDROID_ELEMENT_NOT_FOUND",
      `${detail}${named.length ? ` On screen: ${named.join(", ")}.` : " The screen has no named elements."} Run ade android snapshot to see every element.`,
    );
  };

  const resultFor = (
    action: AndroidElementActionResult["action"],
    picked: ReturnType<typeof pickElement>,
    extra: Partial<AndroidElementActionResult> = {},
  ): AndroidElementActionResult => ({
    ok: true,
    action,
    match: picked.match,
    matchCount: picked.matches.length,
    others: picked.matches
      .map((element, index) => ({ index, ref: element.ref, center: element.center }))
      .filter((entry) => entry.ref !== picked.match?.ref)
      .slice(0, 5),
    message: picked.match?.note ?? null,
    waitedMs: null,
    ...extra,
  });

  const findOrRefuse = async (laneId: string, query: AndroidElementQuery, fresh: boolean) => {
    const snapshot = await snapshotLane(laneId, { fresh });
    const picked = pickElement(snapshot.elements, query);
    if (!picked.match) {
      // A cached tree may be older than the screen: read it again before refusing.
      if (snapshot.cached) return findOrRefuse(laneId, query, true);
      throw notFound(query, snapshot, picked.matches.length);
    }
    return { snapshot, picked, element: picked.match.element };
  };

  /* ---------- input ---------- */

  const longPressAt = async (laneId: string, x: number, y: number, durationMs: number) => {
    const serial = deps.liveStreamSerial(laneId);
    invalidateUi(laneId);
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
    const cached = uiCache.get(laneId)?.snapshot;
    if (cached?.width && cached.height) return { width: cached.width, height: cached.height };
    const booted = await deps.requireBooted(laneId);
    const text = await shellLine(booted, "wm size");
    const size = /Override size:\s*(\d+)x(\d+)/u.exec(text) ?? /Physical size:\s*(\d+)x(\d+)/u.exec(text);
    if (!size) throw new Error(`The emulator did not say its screen size: ${text.trim().slice(0, 200)}`);
    let width = Number(size[1]);
    let height = Number(size[2]);
    // `wm size` is the natural orientation; the screen may be turned.
    const rotation = /mRotation=(\d)/u.exec(await shellLine(booted, "dumpsys window | grep -m1 -oE 'mRotation=[0-9]'"))?.[1];
    if (rotation === "1" || rotation === "3") [width, height] = [height, width];
    return { width, height };
  };

  /* ---------- recordings ---------- */

  const fileRecording = (recording: AndroidRecording): string[] => {
    const ids: string[] = [];
    recording.segments.forEach((segment, index) => {
      const id = fileAndroidCaptureAsProof(deps.artifactFiler, {
        laneId: recording.laneId,
        chatSessionId: recording.chatSessionId,
        kind: "video_recording",
        path: segment.path,
        mimeType: "video/mp4",
        title: `${recording.label?.trim() || "Android emulator recording"}${recording.segments.length > 1 ? ` (part ${index + 1} of ${recording.segments.length})` : ""}`,
        description: `Screen recording of the lane's Android emulator, ${Math.round(segment.durationMs / 100) / 10} s, from ${recording.startedAt}.`,
        toolName: "android_record",
        source: "ade-recorder",
        callerRoot: deps.callerRoot,
        metadata: { recordingId: recording.id, width: segment.width, height: segment.height, durationMs: segment.durationMs, part: index + 1 },
      }, (error) => logger?.warn("android.recording_proof_failed", { laneId: recording.laneId, error: getErrorMessage(error) }));
      if (id) ids.push(id);
    });
    return ids;
  };

  const finishRecording = (
    laneId: string,
    reason: AndroidRecordingStopReason,
    options: { discard?: boolean; proof?: boolean } = {},
  ): Promise<AndroidRecording> => {
    const active = recordings.get(laneId);
    if (!active) return Promise.reject(new AndroidEmulatorFailure("ANDROID_RECORDING_NOT_FOUND", "No recording is running on this lane."));
    active.finishing ??= (async () => {
      active.untap();
      if (active.capTimer) clearTimeout(active.capTimer);
      active.capTimer = null;
      const endedAt = now().toISOString();
      let recording: AndroidRecording;
      if (options.discard) {
        active.recorder.abandon();
        recording = { ...active.recording, active: false, endedAt, stopReason: reason, segments: [], durationMs: 0, bytes: 0 };
      } else {
        let segments: AndroidRecording["segments"] = [];
        let lastError: string | null = null;
        try {
          segments = active.recorder.finish();
        } catch (error) {
          lastError = `The video could not be written: ${getErrorMessage(error)}`;
          active.recorder.abandon();
        }
        if (segments.length === 0 && !lastError) {
          lastError = "The emulator sent no picture while the recording ran, so there is no video. Start the emulator's screen (wake it) and record again.";
        }
        recording = {
          ...active.recording,
          active: false,
          endedAt,
          stopReason: reason,
          segments,
          path: segments[0]?.path ?? active.recording.path,
          durationMs: segments.reduce((sum, segment) => sum + segment.durationMs, 0),
          bytes: segments.reduce((sum, segment) => sum + segment.bytes, 0),
          lastError,
        };
        if (segments.length > 0) {
          writeAndroidRecordingSidecar(deps.dataDir, recording);
          if (options.proof !== false) {
            recording = { ...recording, proofArtifactIds: fileRecording(recording) };
            writeAndroidRecordingSidecar(deps.dataDir, recording);
          }
        }
      }
      recordings.delete(laneId);
      if (reason !== "requested") uncollected.set(laneId, recording);
      deps.onRecordingChanged?.(laneId, recording);
      logger?.info("android.recording_stopped", {
        laneId,
        id: recording.id,
        reason,
        segments: recording.segments.length,
        durationMs: recording.durationMs,
        bytes: recording.bytes,
        proofs: recording.proofArtifactIds.length,
      });
      await deps.releaseStreamForRecording(laneId).catch((error: unknown) => {
        logger?.warn("android.recording_stream_release_failed", { laneId, error: getErrorMessage(error) });
      });
      return recording;
    })();
    return active.finishing;
  };

  /* ---------- the API ---------- */

  const laneOf = (args: AndroidLaneArgs | null | undefined): string => requireLaneId(args?.laneId);

  // The device settings come from androidDeviceSettings.ts; the service adds them.
  const api: Omit<AndroidEmulatorAgentServiceApi, "releaseIfOwnedBy" | "getDeviceSettings" | "setDeviceSetting"> = {
    async listApps(args) {
      const laneId = laneOf(args);
      return { laneId, apps: await apps.listApps(laneId) };
    },

    async installApp(args) {
      const laneId = laneOf(args);
      deps.assertWorkCopyLive(laneId);
      const result = await apps.install(laneId, { apkPath: args.apkPath ?? null, gradle: args.gradle ?? null });
      invalidateUi(laneId);
      return result;
    },

    async launchApp(args) {
      const laneId = laneOf(args);
      deps.assertWorkCopyLive(laneId);
      const wantsInstall = Boolean(args.apkPath?.trim() || args.gradle);
      const install = wantsInstall ? await apps.install(laneId, { apkPath: args.apkPath ?? null, gradle: args.gradle ?? null }) : null;
      const named = args.packageName?.trim() || null;
      const packageName = named ? assertPackageName(named) : install?.packageName ?? null;
      if (!packageName) {
        throw new Error(install
          ? "The build installed, but ADE could not read its package name. Pass --package <name> to launch it."
          : "launch needs --package <name>, or --apk / --gradle to install and launch.");
      }
      const started = await apps.start(laneId, packageName, args.activity ?? null);
      invalidateUi(laneId);
      return { laneId, packageName, activity: started.activity, install, totalTimeMs: started.totalTimeMs };
    },

    async terminateApp(args) {
      const laneId = laneOf(args);
      const packageName = assertPackageName(args.packageName);
      await apps.terminate(laneId, packageName);
      invalidateUi(laneId);
      return { laneId, packageName };
    },

    async uninstallApp(args) {
      const laneId = laneOf(args);
      const packageName = assertPackageName(args.packageName);
      const uninstalled = await apps.uninstall(laneId, packageName);
      invalidateUi(laneId);
      return { laneId, packageName, uninstalled };
    },

    async openUrl(args) {
      const laneId = laneOf(args);
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/u.test(url)) throw new Error("url must be a full URL with a scheme (https://…, myapp://…).");
      await apps.openUrl(laneId, url);
      invalidateUi(laneId);
      return { laneId, url };
    },

    async longPress(args) {
      const laneId = laneOf(args);
      const x = finiteNumber(args.x, "x");
      const y = finiteNumber(args.y, "y");
      const durationMs = clampNumber(args.durationMs, ANDROID_LONG_PRESS_DEFAULT_MS, ANDROID_LONG_PRESS_MIN_MS, ANDROID_LONG_PRESS_MAX_MS);
      await longPressAt(laneId, x, y, durationMs);
    },

    async drag(args) {
      const laneId = laneOf(args);
      const fromX = finiteNumber(args.fromX, "fromX");
      const fromY = finiteNumber(args.fromY, "fromY");
      const toX = finiteNumber(args.toX, "toX");
      const toY = finiteNumber(args.toY, "toY");
      const durationMs = clampNumber(args.durationMs, DRAG_DEFAULT_MS, 50, 10_000);
      invalidateUi(laneId);
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
      const result = await runAdb(booted.adbPath, ["shell", "input", "draganddrop", ...points, String(Math.round(durationMs + DRAG_HOLD_MS))], {
        serial: booted.serial,
        timeoutMs: durationMs + DRAG_HOLD_MS + 15_000,
        signal,
        allowFailure: true,
      });
      const text = `${result.stdout.toString("utf8")}${result.stderr}`;
      if (result.exitCode !== 0 || /Error|Unknown command/iu.test(text)) {
        throw new Error(`The emulator did not take the drag: ${text.trim().slice(0, 200) || `exit ${result.exitCode}`}`);
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
      invalidateUi(laneId);
    },

    async getScreenSnapshot(args) {
      const laneId = laneOf(args);
      return snapshotLane(laneId, { fresh: args.fresh === true });
    },

    async findElement(args) {
      const laneId = laneOf(args);
      const { picked } = await findOrRefuse(laneId, readQuery(args), false);
      return resultFor("find", picked);
    },

    async tapElement(args) {
      const laneId = laneOf(args);
      const { picked, element } = await findOrRefuse(laneId, readQuery(args), false);
      const holdMs = args.holdMs == null ? null : clampNumber(args.holdMs, ANDROID_LONG_PRESS_DEFAULT_MS, ANDROID_LONG_PRESS_MIN_MS, ANDROID_LONG_PRESS_MAX_MS);
      if (holdMs) await longPressAt(laneId, element.center.x, element.center.y, holdMs);
      else await deps.input.tap({ laneId, x: element.center.x, y: element.center.y });
      invalidateUi(laneId);
      return resultFor("tap", picked);
    },

    async fillElement(args) {
      const laneId = laneOf(args);
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) throw new Error("fill needs the text to type (--value).");
      const query = readQuery(args);
      const { picked, element } = await findOrRefuse(laneId, query, false);
      if (args.focusFirst !== false) await deps.input.tap({ laneId, x: element.center.x, y: element.center.y });
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
      await deps.input.sendText({ laneId, text });
      invalidateUi(laneId);
      if (element.password) return resultFor("fill", picked, { typed: "unknown", typedDetail: "A password field does not show its text, so ADE cannot check it." });
      // Read the field back: a keyboard that dropped characters reads as not-seen.
      await sleep(300);
      try {
        const after = await snapshotLane(laneId, { fresh: true });
        const same = after.elements.find((candidate) =>
          (element.resourceId && candidate.resourceId === element.resourceId) || candidate.path === element.path) ?? null;
        const seen = Boolean(same?.text?.includes(text));
        return resultFor("fill", picked, {
          typed: seen ? "verified" : "not-seen",
          typedDetail: seen ? null : `The field now reads ${JSON.stringify(same?.text ?? null)}. Characters the emulator keyboard has no key for (most non-ASCII) are skipped.`,
        });
      } catch (error) {
        return resultFor("fill", picked, { typed: "unknown", typedDetail: getErrorMessage(error) });
      }
    },

    async waitForElement(args) {
      const laneId = laneOf(args);
      const query = readQuery(args);
      const timeoutMs = clampNumber(args.timeoutMs, WAIT_DEFAULT_MS, 0, WAIT_MAX_MS);
      const wantGone = args.state === "gone";
      const startedAt = Date.now();
      for (;;) {
        const snapshot = await snapshotLane(laneId, { fresh: true });
        const picked = pickElement(snapshot.elements, query);
        const waitedMs = Date.now() - startedAt;
        if (wantGone ? !picked.match : Boolean(picked.match)) return resultFor("wait", picked, { waitedMs });
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
      const { picked } = await findOrRefuse(laneId, readQuery(args), true);
      return resultFor("assert", picked);
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

    async recordStart(args) {
      const laneId = laneOf(args);
      deps.assertWorkCopyLive(laneId);
      if (recordings.has(laneId)) {
        const running = recordings.get(laneId)!.recording;
        throw new AndroidEmulatorFailure(
          "ANDROID_RECORDING_ACTIVE",
          `A recording (${running.id}) is already running on this lane since ${running.startedAt}. Stop it first: ade android record-stop.`,
        );
      }
      await deps.requireBooted(laneId);
      uncollected.delete(laneId);
      const startedAt = now();
      const id = newAndroidRecordingId(startedAt);
      const dir = androidRecordingsDir(deps.dataDir, laneId);
      const basePath = path.join(dir, id);
      const recorder = createAndroidMp4Recorder({ basePath });
      const serial = await deps.holdStreamForRecording(laneId);
      let untap: () => void;
      try {
        untap = deps.streams.subscribePackets(serial, (packet) => {
          try {
            recorder.push(packet);
          } catch (error) {
            logger?.warn("android.recording_packet_failed", { laneId, error: getErrorMessage(error) });
          }
        });
      } catch (error) {
        await deps.releaseStreamForRecording(laneId).catch(() => undefined);
        throw error;
      }
      const recording: AndroidRecording = {
        id,
        laneId,
        chatSessionId: args.chatSessionId?.trim() || null,
        label: args.label?.trim() || null,
        path: `${basePath}.mp4`,
        segments: [],
        startedAt: startedAt.toISOString(),
        endedAt: null,
        durationMs: null,
        bytes: null,
        active: true,
        stopReason: null,
        proofArtifactIds: [],
        lastError: null,
      };
      const active: ActiveRecording = { recording, recorder, untap, capTimer: null, finishing: null };
      recordings.set(laneId, active);
      const capMs = androidRecordingCapMs(args.maxSeconds);
      active.capTimer = setTimeout(() => {
        void finishRecording(laneId, "cap").catch((error: unknown) => {
          logger?.warn("android.recording_cap_stop_failed", { laneId, error: getErrorMessage(error) });
        });
      }, capMs);
      (active.capTimer as { unref?: () => void }).unref?.();
      logger?.info("android.recording_started", { laneId, id, capMs });
      deps.onRecordingChanged?.(laneId, recording);
      return recording;
    },

    async recordStop(args) {
      const laneId = laneOf(args);
      if (!recordings.has(laneId)) {
        const ended = uncollected.get(laneId);
        if (ended) {
          // It already ended (its cap, the device going off): answer that one, once.
          uncollected.delete(laneId);
          return ended;
        }
        throw new AndroidEmulatorFailure("ANDROID_RECORDING_NOT_FOUND", "No recording is running on this lane. Start one with ade android record-start.");
      }
      return finishRecording(laneId, "requested", { discard: args.discard === true, ...(args.proof === false ? { proof: false } : {}) });
    },

    async recordList(args) {
      const laneId = laneOf(args);
      const active = recordings.get(laneId);
      const done = listAndroidRecordings(deps.dataDir, laneId);
      return { laneId, recordings: active ? [{ ...active.recording, durationMs: active.recorder.elapsedMs() }, ...done] : done };
    },

    async recordDelete(args) {
      const laneId = laneOf(args);
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) throw new Error("record-delete needs --id <recording id> (ade android record-list shows them).");
      if (recordings.get(laneId)?.recording.id === id) {
        throw new AndroidEmulatorFailure("ANDROID_RECORDING_ACTIVE", "That recording is still running. Stop it first (ade android record-stop --discard drops it).");
      }
      const deleted = deleteAndroidRecording(deps.dataDir, laneId, id);
      if (!deleted) throw new AndroidEmulatorFailure("ANDROID_RECORDING_NOT_FOUND", `No recording ${id} on this lane. ade android record-list shows them.`);
      return { laneId, id, deleted };
    },

    async deviceLease(args) {
      const laneId = laneOf(args);
      const avdName = deps.laneDevices.get(laneId)?.avdName ?? null;
      const connectionSignal = (args as { connectionSignal?: unknown }).connectionSignal;
      const leaseSignal = connectionSignal instanceof AbortSignal ? connectionSignal : null;
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
        return { acquired: false as const, current: null, queued: 0, device: { avdName } };
      }
      return { ...result, device: { avdName } } as Awaited<ReturnType<AndroidEmulatorAgentServiceApi["deviceLease"]>>;
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

    async setLocation(args) {
      const laneId = laneOf(args);
      const latitude = finiteNumber(args.latitude, "latitude");
      const longitude = finiteNumber(args.longitude, "longitude");
      if (latitude < -90 || latitude > 90) throw new Error("latitude must be between -90 and 90.");
      if (longitude < -180 || longitude > 180) throw new Error("longitude must be between -180 and 180.");
      const booted = await deps.requireBooted(laneId);
      // The emulator console takes longitude first.
      const result = await runAdb(booted.adbPath, ["emu", "geo", "fix", String(longitude), String(latitude)], {
        serial: booted.serial,
        timeoutMs: 15_000,
        signal,
        allowFailure: true,
      });
      const text = `${result.stdout.toString("utf8")}${result.stderr}`;
      if (result.exitCode !== 0 || /KO|error/iu.test(text)) {
        throw new Error(`The emulator did not take the location: ${text.trim().slice(0, 200) || `exit ${result.exitCode}`}`);
      }
      return { laneId, latitude, longitude };
    },

    async setAppearance(args) {
      const laneId = laneOf(args);
      const appearance = args.appearance;
      if (appearance !== "light" && appearance !== "dark") throw new Error("appearance must be light or dark.");
      const booted = await deps.requireBooted(laneId);
      const result = await runDeviceShell(booted.adbPath, booted.serial, ["cmd", "uimode", "night", appearance === "dark" ? "yes" : "no"], { timeoutMs: 15_000, signal });
      if (result.exitCode !== 0 || /Error|Exception|Unknown/u.test(result.text)) {
        throw new Error(`The emulator did not change its appearance: ${result.text.slice(0, 200)}`);
      }
      invalidateUi(laneId);
      return { laneId, appearance };
    },

    async setPermission(args) {
      const laneId = laneOf(args);
      const action = args.action;
      if (action !== "grant" && action !== "revoke") throw new Error("action must be grant or revoke.");
      const packageName = assertPackageName(args.packageName);
      const permission = androidPermissionName(typeof args.permission === "string" ? args.permission : "");
      const booted = await deps.requireBooted(laneId);
      const result = await runDeviceShell(booted.adbPath, booted.serial, ["pm", action, packageName, permission], { timeoutMs: 15_000, signal });
      if (result.exitCode !== 0 || /Exception|Error|Unknown/u.test(result.text)) {
        const notInstalled = /Unknown package|not installed/iu.test(result.text);
        if (notInstalled) throw new AndroidEmulatorFailure("ANDROID_APP_NOT_FOUND", `${packageName} is not installed on this lane's emulator.`);
        throw new Error(`pm ${action} ${permission} failed: ${result.text.split(/\r?\n/u)[0]?.slice(0, 240) ?? `exit ${result.exitCode}`}. Only runtime (dangerous) permissions the app declares can be granted or revoked.`);
      }
      return { laneId, action, packageName, permission };
    },

    async captureProofBundle(args) {
      const laneId = laneOf(args);
      const capturedAt = now();
      const stamp = capturedAt.toISOString().replace(/[:.]/gu, "-");
      let dir: string;
      if (args.outDir?.trim()) {
        const root = deps.laneRoot(laneId);
        if (!root) {
          throw new AndroidEmulatorFailure("ANDROID_PATH_OUTSIDE_LANE", "ADE cannot find this lane's folder, so it will not write a bundle to a chosen path. Leave --out out.");
        }
        dir = containAndroidOutPath(args.outDir.trim(), root, platform);
      } else {
        dir = path.join(deps.dataDir, "proof-bundles", laneId.replace(/[^A-Za-z0-9_-]+/gu, "_"), stamp);
      }
      fs.mkdirSync(dir, { recursive: true });
      const shot = await deps.captureScreen(laneId, null);
      const screenshotPath = path.join(dir, "screen.png");
      fs.copyFileSync(shot.path, screenshotPath);
      fs.rmSync(shot.path, { force: true });
      let elementsPath: string | null = null;
      let foregroundPackage: string | null = null;
      if (args.includeElements !== false) {
        try {
          const snapshot = await snapshotLane(laneId, { fresh: false });
          foregroundPackage = snapshot.foregroundPackage;
          elementsPath = path.join(dir, "elements.json");
          fs.writeFileSync(elementsPath, `${JSON.stringify(snapshot, null, 2)}\n`);
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
          logPath = path.join(dir, "logcat.txt");
          fs.writeFileSync(logPath, log.lines.map((line) => `${line.time} ${line.pid} ${line.tid} ${line.level} ${line.tag}: ${line.message}`).join("\n") + "\n");
        } catch (error) {
          logger?.warn("android.proof_bundle_log_failed", { laneId, error: getErrorMessage(error) });
        }
      }
      const metaPath = path.join(dir, "meta.json");
      const device = deps.laneDevices.get(laneId);
      fs.writeFileSync(metaPath, `${JSON.stringify({
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
    invalidateUi,

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

    /** What this machine can do for an agent, for `status`. Cheap: no adb call. */
    async capabilities(sdk: AndroidSdkStatus): Promise<AndroidCapabilities> {
      const adb = sdk.tools.some((tool) => tool.id === "platform-tools" && tool.available);
      const cli = sdk.root ? await locateAndroidCli({ sdkRoot: sdk.root, env: deps.env, platform }).catch(() => null) : null;
      const stream = adb && fs.existsSync(deps.serverJarPath);
      const { jdk } = await locateAndroidJdk({ env: deps.env, platform });
      return {
        adb,
        stream,
        record: stream,
        uiTree: adb ? (cli && Date.now() - androidCliFailedAt > ANDROID_CLI_RETRY_MS ? "android-cli" : "uiautomator") : null,
        logcat: adb,
        gradle: adb && jdk !== null,
        jdk: jdk ? { home: jdk.home, source: jdk.source, version: jdk.version } : null,
        androidCli: cli ? { path: cli.path, version: cli.version } : null,
      };
    },

    /** True while a recording holds the lane's stream. */
    isRecording(laneId: string): boolean {
      return recordings.has(laneId);
    },

    /** The lane's stream is about to stop (the device stopped or crashed): end its recording first. */
    async onStreamEnding(laneId: string): Promise<void> {
      if (!recordings.has(laneId)) return;
      await finishRecording(laneId, "device-off").catch((error: unknown) => {
        logger?.warn("android.recording_device_off_failed", { laneId, error: getErrorMessage(error) });
      });
    },

    /**
     * The lane lets its device go: end its recording, and on an AVD the lane
     * attached (the user's own), remove each package ADE installed there. A
     * created AVD is deleted whole, so it needs no uninstall. Never throws.
     */
    async beforeRelease(laneId: string): Promise<void> {
      if (recordings.has(laneId)) {
        await finishRecording(laneId, "released").catch((error: unknown) => {
          logger?.warn("android.recording_release_failed", { laneId, error: getErrorMessage(error) });
        });
      }
      invalidateUi(laneId);
      const device = deps.laneDevices.get(laneId);
      if (!device || device.origin !== "attached" || device.adeInstalledPackages.length === 0) return;
      const removed = await apps.uninstallAdePackages(laneId, device.adeInstalledPackages).catch(() => [] as string[]);
      logger?.info("android.release_uninstalled", { laneId, avdName: device.avdName, removed, asked: device.adeInstalledPackages.length });
    },

    /** A chat ended: its recordings stop (filed as proof) and its leases pass on. */
    async releaseIfOwnedBy(chatSessionId: string): Promise<void> {
      const chat = chatSessionId?.trim();
      if (!chat) return;
      for (const [laneId, active] of [...recordings]) {
        if (active.recording.chatSessionId !== chat) continue;
        await finishRecording(laneId, "chat-ended").catch((error: unknown) => {
          logger?.warn("android.recording_chat_end_failed", { laneId, error: getErrorMessage(error) });
        });
      }
      const ended = leases.endChat(chat);
      if (ended > 0) logger?.info("android.device_leases_ended_with_chat", { chatSessionId: chat, count: ended });
    },

    async dispose(): Promise<void> {
      for (const laneId of [...recordings.keys()]) {
        await finishRecording(laneId, "device-off").catch(() => undefined);
      }
      leases.dispose();
      uiCache.clear();
    },
  };
}

export type AndroidAgentSuite = ReturnType<typeof createAndroidAgentSuite>;
export type { AndroidUiElement };
