/**
 * App Control recording: a movie of the app a lane drives.
 *
 * The contract is Mac Desktop's (`macDesktopRecording.ts`), so an agent learns
 * one set of rules:
 *
 * 1. One recording per lane. The chat that starts it owns it; the proof is
 *    filed under that chat, whichever chat stops it.
 * 2. No recording runs longer than five minutes (`maxSeconds` may ask for
 *    less); two minutes with no action, or a full disk, stops it too. A
 *    chat's recording that a limit stopped files itself.
 * 3. The engine records a raw file; the stop turns it into a demo
 *    (`demoRenderService.ts`) unless `plain`, and keeps only that. The
 *    Chromium demo engine reads the screencast's `.aderaw`, the Swift one the
 *    window capture's MP4. `durationMs` is the video, `wallDurationMs` the
 *    real time it covers, `idleCutMs` the difference.
 * 4. A caption files the video as proof: owners are the lane, the chat and the
 *    lane's pull request. With no caption it stays a scratch file, except when
 *    the cap, the app closing or the chat ending stopped a chat's recording —
 *    then it files itself with a default caption, as Mac Desktop's cap does.
 *
 * Two engines make the video:
 *
 * - macOS, `window-capture`: the desktop helper records the app's own window
 *   (ScreenCaptureKit, one window, wherever it sits). Needs Screen Recording.
 * - Windows and Linux, `screencast`: the CDP screencast frames the pane
 *   already shows are written to an `.aderaw` file by a recorder the ADE
 *   desktop app hosts. A machine with no desktop app has no recorder, and the
 *   start says so.
 */

import fs from "node:fs";
import type { DemoArtifactMetadata, DemoEngine, DemoTrack } from "../../../shared/demoVideo/demoContract";
import { DEMO_RAW_FILE_EXTENSION } from "../../../shared/demoVideo/demoContract";
import { demoProofSentence, recordingStopSentence } from "../../../shared/demoVideo/demoProofText";
import { appControlProofCaption, formatProofDuration, proofIdleCutLabel } from "../../../shared/proofProvenance";
import type {
  AppControlEventPayload,
  AppControlRecordStartArgs,
  AppControlRecordingEngine,
  AppControlRecordingStatus,
  AppControlRecordingStopReason,
  AppControlScreencastFrame,
  AppControlSession,
} from "../../../shared/types/appControl";
import type {
  ComputerUseArtifactIngestionRequest,
  ComputerUseArtifactIngestionResult,
  ComputerUseArtifactOwner,
} from "../../../shared/types/computerUseArtifacts";
import type { MacDesktopPermissions, MacDesktopPermissionState } from "../../../shared/types/macDesktop";
import { createComputerUseArtifactPath } from "../computerUse/localComputerUse";
import type { Logger } from "../logging/logger";
import {
  readCaptureBytes,
  readLengths,
  startHelperRecording,
  type RecordingLengths,
} from "../macDesktop/macDesktopRecording";
import { clampFps } from "../macDesktop/macDesktopStreamServer";
import { createDemoEngineSet, type DemoEngineSet } from "../demoVideo/demoEngines";
import { finalPathForRaw, rawPathFor, recordingCapMsFor, watchDemoRecording } from "../demoVideo/demoRecordingGuard";
import { demoLengths, produceDemoVideo, DemoRecordingUnusableError } from "../demoVideo/demoRenderService";
import { demoTrackRegistry } from "../demoVideo/demoTrackRegistry";

/** The broker's backend name for everything App Control files. */
export const APP_CONTROL_PROOF_BACKEND_NAME = "ade-app-control";

export const APP_CONTROL_RECORDING_NEEDS_DESKTOP_CODE = "APP_CONTROL_RECORDING_NEEDS_DESKTOP";
export const APP_CONTROL_SCREEN_RECORDING_DENIED_CODE = "APP_CONTROL_SCREEN_RECORDING_DENIED";
export const APP_CONTROL_RECORDING_NOT_RUNNING_CODE = "APP_CONTROL_RECORDING_NOT_RUNNING";
export const APP_CONTROL_RECORDING_NO_WINDOW_CODE = "APP_CONTROL_RECORDING_NO_WINDOW";

/** What the screencast engine records at when the caller names no rate. */
const DEFAULT_RECORDING_FPS = 15;

/** A coded error the CLI's hint table can key on; carries the permission state. */
export class AppControlRecordingError extends Error {
  readonly code: string;
  readonly permissions: MacDesktopPermissions | null;

  constructor(code: string, message: string, permissions: MacDesktopPermissions | null = null) {
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = "AppControlRecordingError";
    this.code = code;
    this.permissions = permissions;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
   Engines
   ────────────────────────────────────────────────────────────────────────── */

/**
 * The finished raw file, as either engine reports it. `firstFrameAtMs` is the
 * wall clock of its first frame when the engine knows it.
 */
export type AppControlRecordingFinish = RecordingLengths & { filePath: string; firstFrameAtMs?: number | null };

/**
 * Windows and Linux: the encoder the ADE desktop app hosts.
 *
 * `start` reserves the recorder and answers with the real file path (the
 * encoder picks mp4 or webm, so the extension can change). Frames are pushed as
 * the screencast produces them; a frame that arrives while the previous one is
 * still being drawn replaces it. `stop` finalises and reports the lengths.
 */
export type AppControlScreencastRecorderBackend = {
  start(args: { key: string; filePath: string; fps: number; keepIdle: boolean }): Promise<{ filePath: string }>;
  pushFrame(key: string, frame: AppControlScreencastFrame): void;
  stop(key: string): Promise<AppControlRecordingFinish>;
  /** Drops a recording without finishing it. Best effort. */
  cancel?(key: string): void;
};

/** One window of the app, as the desktop helper lists it. */
export type AppControlAppWindow = {
  id: number;
  title: string | null;
  width: number;
  height: number;
  minimized: boolean;
};

/** macOS: the desktop helper, narrowed to what window recording uses. */
export type AppControlWindowRecorder = {
  readPermissions(): Promise<MacDesktopPermissions | null>;
  listWindowsForPid(pid: number): Promise<AppControlAppWindow[]>;
  start(args: { key: string; windowId: number; fps: number; filePath: string; keepIdle: boolean }): Promise<void>;
  stop(key: string): Promise<AppControlRecordingFinish>;
  /** The helper says a window recording's stream ended (window closed, app quit). */
  onInterrupted(listener: (key: string) => void): () => void;
  dispose(): void;
};

/**
 * The window a recording follows: the one whose title is the CDP page's,
 * else the largest one that is not minimized. An Electron app's main window is
 * almost always its largest; a matching title settles apps with several.
 */
export function pickAppWindow(
  windows: readonly AppControlAppWindow[],
  preferredTitle: string | null,
): AppControlAppWindow | null {
  const visible = windows.filter((window) => !window.minimized && window.width > 1 && window.height > 1);
  if (!visible.length) return null;
  const title = preferredTitle?.trim();
  if (title) {
    const titled = visible.find((window) => window.title?.trim() === title);
    if (titled) return titled;
  }
  return [...visible].sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}

function asPermissionState(value: unknown): MacDesktopPermissionState {
  return value === "granted" || value === "denied" || value === "unknown" ? value : "unknown";
}

export function readDriverPermissions(value: Record<string, unknown> | null): MacDesktopPermissions | null {
  if (!value) return null;
  return {
    screenRecording: asPermissionState(value.screenRecording),
    accessibility: asPermissionState(value.accessibility),
  };
}

export function readDriverWindows(rows: ReadonlyArray<Record<string, unknown>>): AppControlAppWindow[] {
  const out: AppControlAppWindow[] = [];
  for (const row of rows) {
    const id = typeof row.id === "number" && Number.isInteger(row.id) && row.id > 0 ? row.id : null;
    if (id == null) continue;
    const frame = row.frame && typeof row.frame === "object" ? row.frame as Record<string, unknown> : {};
    const width = typeof frame.width === "number" && Number.isFinite(frame.width) ? frame.width : 0;
    const height = typeof frame.height === "number" && Number.isFinite(frame.height) ? frame.height : 0;
    out.push({
      id,
      title: typeof row.title === "string" && row.title.trim().length ? row.title : null,
      width,
      height,
      minimized: row.minimized === true,
    });
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   Recording
   ────────────────────────────────────────────────────────────────────────── */

export type AppControlRecordingDeps = {
  logger: Logger;
  projectRoot: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  emit: (payload: AppControlEventPayload) => void;
  /** The lane's App Control session, live or not. */
  getSession: (laneId: string) => AppControlSession | null;
  /** The newest screencast frame of the lane, to seed a screencast recording. */
  getLastFrame: (laneId: string) => AppControlScreencastFrame | null;
  /**
   * One fresh capture when the lane has no cached frame. A lane nobody watches
   * streams no screencast, so a recording started there would otherwise know
   * neither the page's viewport nor its first picture.
   */
  getLatestFrame?: (laneId: string) => Promise<AppControlScreencastFrame | null>;
  /** The pid that owns the app's windows (Electron's main process). */
  resolveAppProcessId: (laneId: string) => Promise<number | null>;
  /** The page title the lane's session is attached to, to pick its window. */
  resolveTargetTitle?: (laneId: string) => Promise<string | null> | string | null;
  /** macOS engine. Null off macOS or when the helper binary is missing. */
  windowRecorder: AppControlWindowRecorder | null;
  /** Windows/Linux engine. Read at start: the desktop app may attach later. */
  screencastRecorder: () => AppControlScreencastRecorderBackend | null;
  ingestArtifacts?: ((request: ComputerUseArtifactIngestionRequest) =>
    Promise<ComputerUseArtifactIngestionResult> | ComputerUseArtifactIngestionResult) | null;
  resolvePrimaryPrUrl?: ((laneId: string) => Promise<string | null> | string | null) | null;
  resolveLaneName?: ((laneId: string) => Promise<string | null> | string | null) | null;
  /** The desktop app's Chromium demo engine, which reads the screencast's raw file. Null without a desktop app. */
  getChromiumDemoEngine?: (() => DemoEngine | null) | null;
  /** Overrides the engine set (tests, or a host that already built one). */
  demoEngines?: DemoEngineSet | null;
};

/** The helper's recording key for a lane. Prefixed so it never names a Mac Desktop lane. */
export function appControlRecordingKey(laneId: string): string {
  return `app-control:${laneId}`;
}

const DEFAULT_RECORDING_DESCRIPTION = "Recording of the lane's App Control app.";

function captionDuration(status: AppControlRecordingStatus): string {
  const video = formatProofDuration(status.durationMs ?? 0);
  const idleCut = proofIdleCutLabel(status.idleCutMs);
  return idleCut ? `${video} · ${idleCut}` : video;
}

function recordingProofDescription(lead: string, status: AppControlRecordingStatus, demo: DemoArtifactMetadata | null): string {
  return [
    lead,
    demoProofSentence(demo),
    recordingStopSentence(status.stopReason, status.maxDurationMs),
    status.stopReason === "app-closed" ? "Stopped when the app's window closed." : null,
    status.stopReason === "chat-ended" ? "Stopped when the chat that started it ended." : null,
  ].filter(Boolean).join(" ");
}

/**
 * Moves a track measured against the page's viewport into the recorded
 * window's frame. The macOS window capture records the whole window, title
 * bar included, while every App Control action is measured in the page's CSS
 * viewport, which sits at the bottom of the window and spans its width.
 * Without this, every ring and zoom would land a title bar too high.
 */
export function mapViewportTrackToWindow(
  track: DemoTrack,
  viewport: { width: number; height: number },
  window: { width: number; height: number },
): DemoTrack {
  const valid = viewport.width > 0 && viewport.height > 0 && window.width > 0 && window.height > 0
    && viewport.width <= window.width + 1 && viewport.height <= window.height + 1
    // A viewport far smaller than the window is a measurement from another
    // state (zoomed, docked devtools); leave the track alone rather than guess.
    && viewport.height >= window.height * 0.6;
  if (!valid) return track;
  const offsetX = Math.max(0, (window.width - viewport.width) / 2);
  const offsetY = Math.max(0, window.height - viewport.height);
  const mapX = (x: number) => (x * viewport.width + offsetX) / window.width;
  const mapY = (y: number) => (y * viewport.height + offsetY) / window.height;
  return {
    ...track,
    events: track.events.map((event) => ({
      ...event,
      ...(typeof event.x === "number" ? { x: mapX(event.x) } : {}),
      ...(typeof event.y === "number" ? { y: mapY(event.y) } : {}),
      ...(event.rect
        ? {
          rect: [
            mapX(event.rect[0]),
            mapY(event.rect[1]),
            (event.rect[2] * viewport.width) / window.width,
            (event.rect[3] * viewport.height) / window.height,
          ] as DemoTrack["events"][number]["rect"],
        }
        : {}),
    })),
  };
}

export function createAppControlRecording(deps: AppControlRecordingDeps) {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => Date.now());
  const recordings = new Map<string, AppControlRecordingStatus>();
  /** laneId → the path the engine was told to write, for a stop that fails. */
  const recordingPaths = new Map<string, string>();
  /** The app's page title when the recording started, for a self-filed caption after the app is gone. */
  const recordingAppTitles = new Map<string, string>();
  const capTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const stopping = new Map<string, Promise<AppControlRecordingStatus>>();
  /** laneId → the start in flight, so a second start joins it instead of racing the engine. */
  const starting = new Map<string, Promise<AppControlRecordingStatus>>();
  /** laneId → bumped by forgetLane, so a start that was in flight when the lane went away discards itself. */
  const laneEpochs = new Map<string, number>();
  /** laneId → the screencast backend a running recording feeds. */
  const screencastBackends = new Map<string, AppControlScreencastRecorderBackend>();

  const currentFrame = async (laneId: string): Promise<AppControlScreencastFrame | null> =>
    deps.getLastFrame(laneId)
    ?? await Promise.resolve(deps.getLatestFrame?.(laneId)).catch(() => null)
    ?? null;
  /** laneId → the recorded window and the page viewport at the start, for a window capture. */
  const windowGeometry = new Map<string, { window: { width: number; height: number }; viewport: { width: number; height: number } | null }>();
  /** laneId → where the demo goes, whether it is plain, and the idle/disk watch. */
  const raws = new Map<string, { finalPath: string; plain: boolean; stopWatch: () => void }>();
  const demoEngines = deps.demoEngines ?? createDemoEngineSet({
    logger: deps.logger,
    getChromiumDemoEngine: deps.getChromiumDemoEngine ?? null,
  });
  const endRaw = (laneId: string) => {
    const raw = raws.get(laneId) ?? null;
    raw?.stopWatch();
    raws.delete(laneId);
    return raw;
  };

  const engineForPlatform = (): AppControlRecordingEngine =>
    platform === "darwin" ? "window-capture" : "screencast";

  const publish = (status: AppControlRecordingStatus): void => {
    deps.emit({ type: "recording-changed", laneId: status.laneId, status });
  };

  const clearCap = (laneId: string): void => {
    const timer = capTimers.get(laneId);
    if (timer) clearTimeout(timer);
    capTimers.delete(laneId);
  };

  const armCap = (laneId: string, ms: number): void => {
    clearCap(laneId);
    const timer = setTimeout(() => {
      capTimers.delete(laneId);
      deps.logger.info("app_control.recording.cap_reached", { laneId, maxDurationMs: ms });
      void stopRecording(laneId, null, "cap").catch((error: unknown) => {
        deps.logger.warn("app_control.recording.cap_stop_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    capTimers.set(laneId, timer);
  };

  const refuse = (
    laneId: string,
    engine: AppControlRecordingEngine,
    error: AppControlRecordingError,
    chatSessionId: string | null,
  ): never => {
    // The refusal is state too: the pane shows why Record did nothing, and the
    // permission answer, without a second read.
    const previous = recordings.get(laneId);
    const status: AppControlRecordingStatus = {
      laneId,
      running: false,
      startedAt: null,
      filePath: previous?.filePath ?? null,
      durationMs: previous?.durationMs ?? null,
      caption: null,
      lastError: error.message,
      chatSessionId,
      engine,
      permissions: error.permissions,
    };
    recordings.set(laneId, status);
    publish(status);
    throw error;
  };

  const startWindowCapture = async (
    laneId: string,
    session: AppControlSession,
    args: { fps: number; filePath: string; keepIdle: boolean; chatSessionId: string | null },
  ): Promise<string> => {
    const recorder = deps.windowRecorder;
    if (!recorder) {
      return refuse(laneId, "window-capture", new AppControlRecordingError(
        APP_CONTROL_RECORDING_NEEDS_DESKTOP_CODE,
        "Recording needs ADE's desktop helper (ade-desktop-driver), and this install has none.",
      ), args.chatSessionId);
    }
    const permissions = await recorder.readPermissions().catch(() => null);
    if (permissions?.screenRecording === "denied") {
      return refuse(laneId, "window-capture", new AppControlRecordingError(
        APP_CONTROL_SCREEN_RECORDING_DENIED_CODE,
        "Recording the app's window needs Screen Recording permission for ADE. "
          + "Grant it in System Settings > Privacy & Security > Screen Recording "
          + "(the Mac Desktop pane has a button for it), then start the recording again.",
        permissions,
      ), args.chatSessionId);
    }
    const pid = await deps.resolveAppProcessId(laneId).catch(() => null);
    if (!pid) {
      return refuse(laneId, "window-capture", new AppControlRecordingError(
        APP_CONTROL_RECORDING_NO_WINDOW_CODE,
        `ADE could not find the process of the app on CDP port ${session.cdpPort ?? "unknown"}, so it cannot find its window.`,
        permissions,
      ), args.chatSessionId);
    }
    const title = await Promise.resolve(deps.resolveTargetTitle?.(laneId)).catch(() => null) ?? null;
    const windows = await recorder.listWindowsForPid(pid);
    const window = pickAppWindow(windows, title);
    if (!window) {
      return refuse(laneId, "window-capture", new AppControlRecordingError(
        APP_CONTROL_RECORDING_NO_WINDOW_CODE,
        "The app has no open window to record. Show its window, then start the recording again.",
        permissions,
      ), args.chatSessionId);
    }
    const frame = await currentFrame(laneId);
    windowGeometry.set(laneId, {
      window: { width: window.width, height: window.height },
      viewport: frame?.viewportWidth && frame.viewportHeight
        ? { width: frame.viewportWidth, height: frame.viewportHeight }
        : null,
    });
    const key = appControlRecordingKey(laneId);
    try {
      await startHelperRecording({
        start: () => recorder.start({
          key,
          windowId: window.id,
          fps: args.fps,
          filePath: args.filePath,
          keepIdle: args.keepIdle,
        }),
        stop: async () => (await recorder.stop(key)).filePath || null,
        logger: deps.logger,
        key,
      });
    } catch (error) {
      // A grant revoked or never made shows up here as a ScreenCaptureKit
      // refusal, not in the probe above ("unknown" until first use). Ask again
      // so the answer carries the permission, not only the SCK error text.
      const after = await recorder.readPermissions().catch(() => permissions);
      const message = error instanceof Error ? error.message : String(error);
      if (after?.screenRecording === "denied" || /-3801|declined|not authori[sz]ed/i.test(message)) {
        return refuse(laneId, "window-capture", new AppControlRecordingError(
          APP_CONTROL_SCREEN_RECORDING_DENIED_CODE,
          "Recording the app's window needs Screen Recording permission for ADE. "
            + "Grant it in System Settings > Privacy & Security > Screen Recording "
            + "(the Mac Desktop pane has a button for it), then start the recording again.",
          after ?? permissions,
        ), args.chatSessionId);
      }
      return refuse(laneId, "window-capture", new AppControlRecordingError(
        APP_CONTROL_RECORDING_NO_WINDOW_CODE,
        `The app's window could not be recorded: ${message}`,
        after ?? permissions,
      ), args.chatSessionId);
    }
    return args.filePath;
  };

  const startScreencast = async (
    laneId: string,
    args: { fps: number; filePath: string; keepIdle: boolean; chatSessionId: string | null },
  ): Promise<string> => {
    const backend = deps.screencastRecorder();
    if (!backend) {
      return refuse(laneId, "screencast", new AppControlRecordingError(
        APP_CONTROL_RECORDING_NEEDS_DESKTOP_CODE,
        "Recording App Control on this machine needs the ADE desktop app open on this machine. "
          + "Open ADE here, then start the recording again.",
      ), args.chatSessionId);
    }
    const key = appControlRecordingKey(laneId);
    const started = await backend.start({ key, filePath: args.filePath, fps: args.fps, keepIdle: args.keepIdle });
    screencastBackends.set(laneId, backend);
    // A still app sends no frames, so the recording would start black. Seed it
    // with the newest frame, or a fresh capture.
    const seed = await currentFrame(laneId);
    if (seed) backend.pushFrame(key, seed);
    return started.filePath;
  };

  /** Drops what an engine started for a start that no longer has a lane or session to belong to. */
  const discardStartedEngine = async (laneId: string, engine: AppControlRecordingEngine): Promise<void> => {
    const key = appControlRecordingKey(laneId);
    try {
      if (engine === "window-capture") {
        await deps.windowRecorder?.stop(key);
      } else {
        const backend = screencastBackends.get(laneId);
        screencastBackends.delete(laneId);
        backend?.cancel?.(key);
      }
    } catch (error) {
      deps.logger.debug("app_control.recording.discard_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const startRecording = (
    laneId: string,
    args: AppControlRecordStartArgs,
  ): Promise<AppControlRecordingStatus> => {
    const existing = recordings.get(laneId);
    if (existing?.running) return Promise.resolve(existing);
    const pending = starting.get(laneId);
    if (pending) return pending;
    const run = beginRecording(laneId, args);
    starting.set(laneId, run);
    const forget = (): void => {
      if (starting.get(laneId) === run) starting.delete(laneId);
    };
    run.then(forget, forget);
    return run;
  };

  const beginRecording = async (
    laneId: string,
    args: AppControlRecordStartArgs,
  ): Promise<AppControlRecordingStatus> => {
    const epoch = laneEpochs.get(laneId) ?? 0;
    const inFlight = stopping.get(laneId);
    if (inFlight) await inFlight.catch(() => null);
    const session = deps.getSession(laneId);
    const chatSessionId = args.chatSessionId?.trim() || null;
    const engine = engineForPlatform();
    if (!session || !["connected", "running", "starting"].includes(session.status)) {
      return refuse(laneId, engine, new AppControlRecordingError(
        APP_CONTROL_RECORDING_NOT_RUNNING_CODE,
        "This lane has no running App Control app to record. Launch or connect one first.",
      ), chatSessionId);
    }
    const fps = clampFps(args.fps ?? null, DEFAULT_RECORDING_FPS);
    const plain = args.plain === true || args.keepIdle === true;
    // Under the artifact root: the thread plays it back through
    // `ade-artifact://`, which only serves `.ade/artifacts`. The engine writes
    // the raw file beside it; the stop makes the demo here and deletes that.
    const finalPath = createComputerUseArtifactPath(deps.projectRoot, `app-control-recording-${laneId}`, "mp4");
    const reserved = rawPathFor(finalPath, engine === "window-capture" ? ".mp4" : DEMO_RAW_FILE_EXTENSION);
    const request = { fps, filePath: reserved, keepIdle: true, chatSessionId };
    const demoKey = appControlRecordingKey(laneId);
    demoTrackRegistry.begin(demoKey, { surface: "app-control", chatSessionId, laneId });
    let filePath: string;
    try {
      filePath = engine === "window-capture"
        ? await startWindowCapture(laneId, session, request)
        : await startScreencast(laneId, request);
    } catch (error) {
      demoTrackRegistry.discard(demoKey);
      throw error;
    }
    // The awaits above leave room for the lane to close or its session to
    // change. A recording that outlived its session would run uncapped with
    // nothing to stop it, so drop it here instead.
    const current = deps.getSession(laneId);
    if (
      (laneEpochs.get(laneId) ?? 0) !== epoch
      || !current
      || current.id !== session.id
      || !["connected", "running", "starting"].includes(current.status)
    ) {
      await discardStartedEngine(laneId, engine);
      demoTrackRegistry.discard(demoKey);
      deps.logger.info("app_control.recording.start_discarded", { laneId, engine });
      throw new AppControlRecordingError(
        APP_CONTROL_RECORDING_NOT_RUNNING_CODE,
        "The lane's App Control app stopped while the recording was starting, so nothing is being recorded.",
      );
    }
    recordingPaths.set(laneId, filePath);
    endRaw(laneId);
    raws.set(laneId, {
      finalPath,
      plain,
      stopWatch: watchDemoRecording({
        key: demoKey,
        rawPath: filePath,
        logger: deps.logger,
        now,
        onLimit: (limit) => {
          void stopRecording(laneId, null, limit).catch((error: unknown) => {
            deps.logger.warn("app_control.recording.limit_stop_failed", {
              laneId,
              limit,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
      }),
    });
    const maxDurationMs = recordingCapMsFor(args.maxSeconds);
    const status: AppControlRecordingStatus = {
      laneId,
      running: true,
      startedAt: new Date(now()).toISOString(),
      filePath: null,
      durationMs: null,
      caption: args.caption?.trim() || null,
      lastError: null,
      chatSessionId,
      maxDurationMs,
      engine,
      sessionId: session.id,
      permissions: null,
      plain,
    };
    recordings.set(laneId, status);
    recordingAppTitles.delete(laneId);
    void Promise.resolve(deps.resolveTargetTitle?.(laneId))
      .then((title) => {
        if (title?.trim()) recordingAppTitles.set(laneId, title.trim());
      })
      .catch(() => {});
    armCap(laneId, maxDurationMs);
    deps.logger.info("app_control.recording.started", { laneId, engine, fps, plain, maxDurationMs });
    publish(status);
    return status;
  };

  const finishEngine = async (laneId: string, engine: AppControlRecordingEngine): Promise<AppControlRecordingFinish> => {
    if (engine === "window-capture") {
      if (!deps.windowRecorder) throw new Error("The desktop helper is gone; the recording could not be finished.");
      return await deps.windowRecorder.stop(appControlRecordingKey(laneId));
    }
    const backend = screencastBackends.get(laneId);
    screencastBackends.delete(laneId);
    if (!backend) throw new Error("The desktop recorder is gone; the recording could not be finished.");
    return await backend.stop(appControlRecordingKey(laneId));
  };

  const fileProof = async (
    laneId: string,
    existing: AppControlRecordingStatus,
    finished: AppControlRecordingStatus,
    stopperChatSessionId: string | null,
    reason: AppControlRecordingStopReason,
    recordedTo: string,
    demo: DemoArtifactMetadata | null,
  ): Promise<{ caption: string | null; proofArtifactId: string | null }> => {
    const selfFiled = !existing.caption && reason !== "requested" && Boolean(existing.chatSessionId);
    const startTitle = recordingAppTitles.get(laneId) ?? null;
    recordingAppTitles.delete(laneId);
    let caption = existing.caption;
    if (!caption && selfFiled) {
      const [liveTitle, laneName] = await Promise.all([
        Promise.resolve(deps.resolveTargetTitle?.(laneId)).catch(() => null),
        Promise.resolve(deps.resolveLaneName?.(laneId)).catch(() => null),
      ]);
      caption = `${appControlProofCaption(liveTitle || startTitle, laneName)} · ${captionDuration(finished)}`;
    }
    if (!caption || !finished.filePath || !deps.ingestArtifacts) return { caption, proofArtifactId: null };
    const owners: ComputerUseArtifactOwner[] = [{ kind: "lane", id: laneId, relation: "attached_to" }];
    const chatSessionId = existing.chatSessionId ?? stopperChatSessionId;
    if (chatSessionId) owners.push({ kind: "chat_session", id: chatSessionId, relation: "attached_to" });
    const prUrl = (await Promise.resolve(deps.resolvePrimaryPrUrl?.(laneId)).catch(() => null))?.trim() || null;
    if (prUrl) owners.push({ kind: "github_pr", id: prUrl, relation: "published_to" });
    try {
      const filed = await deps.ingestArtifacts({
        backend: { name: APP_CONTROL_PROOF_BACKEND_NAME, style: "manual", toolName: "app-control record" },
        callerRoot: deps.projectRoot,
        provenance: { source: "ade-recorder", recordedFrom: existing.startedAt, recordedTo },
        inputs: [{
          kind: "video_recording",
          title: caption,
          description: recordingProofDescription(existing.caption ?? DEFAULT_RECORDING_DESCRIPTION, finished, demo),
          path: finished.filePath,
          metadata: {
            durationMs: finished.durationMs,
            wallDurationMs: finished.wallDurationMs,
            idleCutMs: finished.idleCutMs,
            stopReason: reason,
            engine: finished.engine,
            ...(demo ? { demo } : {}),
          },
        }],
        owners,
      });
      return { caption, proofArtifactId: filed?.artifacts[0]?.id ?? null };
    } catch (error) {
      deps.logger.warn("app_control.recording_proof_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { caption, proofArtifactId: null };
    }
  };

  const finishRecording = async (
    laneId: string,
    stopperChatSessionId: string | null,
    reason: AppControlRecordingStopReason,
  ): Promise<AppControlRecordingStatus> => {
    const existing = recordings.get(laneId);
    if (!existing?.running) {
      throw new AppControlRecordingError(
        APP_CONTROL_RECORDING_NOT_RUNNING_CODE,
        existing?.lastError && existing.filePath
          ? `This lane is not recording. The last recording failed; its partial file is ${existing.filePath}.`
          : "This lane is not recording.",
      );
    }
    clearCap(laneId);
    let finish: AppControlRecordingFinish;
    try {
      finish = await finishEngine(laneId, existing.engine);
    } catch (error) {
      // One truth: the engine dropped its recorder either way, so the status
      // says "not running" and names the partial file.
      const failed: AppControlRecordingStatus = {
        ...existing,
        running: false,
        filePath: recordingPaths.get(laneId) ?? existing.filePath,
        lastError: error instanceof Error ? error.message : String(error),
        stopReason: reason,
      };
      recordingPaths.delete(laneId);
      endRaw(laneId);
      demoTrackRegistry.discard(appControlRecordingKey(laneId));
      recordings.set(laneId, failed);
      stopping.delete(laneId);
      publish(failed);
      throw error;
    }
    const stoppedAtMs = now();
    const recordedTo = new Date(stoppedAtMs).toISOString();
    recordingPaths.delete(laneId);
    const raw = endRaw(laneId);
    const rawLengths = readLengths(finish as unknown as Record<string, unknown>);
    const rawFilePath = finish.filePath?.trim() || null;
    const demoKey = appControlRecordingKey(laneId);
    demoTrackRegistry.markFirstFrame(demoKey, finish.firstFrameAtMs ?? stoppedAtMs - rawLengths.wallDurationMs);
    const endedTrack = demoTrackRegistry.end(demoKey, { durationSeconds: rawLengths.wallDurationMs / 1000, atMs: stoppedAtMs });
    const geometry = windowGeometry.get(laneId) ?? null;
    windowGeometry.delete(laneId);
    const track = endedTrack && existing.engine === "window-capture" && geometry?.viewport
      ? mapViewportTrackToWindow(endedTrack, geometry.viewport, geometry.window)
      : endedTrack;
    const making: AppControlRecordingStatus = { ...existing, running: false, makingDemo: true, stopReason: reason };
    recordings.set(laneId, making);
    publish(making);

    let filePath = rawFilePath;
    let lengths = rawLengths;
    let demo: DemoArtifactMetadata | null = null;
    let demoError: string | null = null;
    if (rawFilePath) {
      try {
        const produced = await produceDemoVideo({
          rawPath: rawFilePath,
          outputPath: raw?.finalPath ?? finalPathForRaw(rawFilePath),
          track,
          plain: raw?.plain ?? false,
          engines: demoEngines.engines(),
          missingEngineReason: demoEngines.missingEngineReason?.() ?? null,
          logger: deps.logger,
        });
        filePath = produced.path;
        demo = produced.metadata;
        lengths = demoLengths(produced.metadata);
      } catch (error) {
        demoError = error instanceof Error ? error.message : String(error);
        deps.logger.warn("app_control.recording_demo_failed", { laneId, error: demoError });
        // A screencast's raw file cannot be played, so there is nothing to
        // file, and nothing will ever read it: it goes (it can be 2 GB).
        // An empty or unfinished movie is not proof either.
        if (rawFilePath.endsWith(DEMO_RAW_FILE_EXTENSION) || error instanceof DemoRecordingUnusableError) {
          filePath = null;
          await fs.promises.rm(rawFilePath, { force: true }).catch(() => {});
        }
      }
    }
    const finished: AppControlRecordingStatus = {
      ...existing,
      running: false,
      makingDemo: false,
      filePath,
      ...lengths,
      lastError: demoError,
      stopReason: reason,
    };
    const { caption, proofArtifactId } = await fileProof(
      laneId,
      existing,
      finished,
      stopperChatSessionId,
      reason,
      recordedTo,
      demo,
    );
    const status: AppControlRecordingStatus = {
      ...finished,
      caption,
      proofArtifactId,
      bytes: await readCaptureBytes(finished.filePath),
    };
    recordings.set(laneId, status);
    stopping.delete(laneId);
    deps.logger.info("app_control.recording.stopped", {
      laneId,
      reason,
      engine: status.engine,
      durationMs: status.durationMs,
      idleCutMs: status.idleCutMs,
      filed: Boolean(proofArtifactId),
    });
    publish(status);
    return status;
  };

  const stopRecording = (
    laneId: string,
    stopperChatSessionId: string | null,
    reason: AppControlRecordingStopReason,
  ): Promise<AppControlRecordingStatus> => {
    const inFlight = stopping.get(laneId);
    if (inFlight) return inFlight;
    const run = finishRecording(laneId, stopperChatSessionId, reason);
    stopping.set(laneId, run);
    const forget = (): void => {
      if (stopping.get(laneId) === run) stopping.delete(laneId);
    };
    run.then(forget, forget);
    return run;
  };

  /** Stops a running recording because the app went away, and files it. Never throws. */
  const stopForAppClosed = async (laneId: string): Promise<AppControlRecordingStatus | null> => {
    if (!recordings.get(laneId)?.running) return null;
    return await stopRecording(laneId, null, "app-closed").catch((error: unknown) => {
      deps.logger.warn("app_control.recording.app_closed_stop_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      return recordings.get(laneId) ?? null;
    });
  };

  const unsubscribeInterrupted = deps.windowRecorder?.onInterrupted((key) => {
    const prefix = appControlRecordingKey("");
    if (!key.startsWith(prefix)) return;
    const laneId = key.slice(prefix.length);
    deps.logger.info("app_control.recording.window_lost", { laneId });
    void stopForAppClosed(laneId);
  }) ?? null;

  return {
    startRecording,

    stopRecording: (laneId: string, stopperChatSessionId: string | null = null) =>
      stopRecording(laneId, stopperChatSessionId, "requested"),

    getStatus(laneId: string): AppControlRecordingStatus {
      return recordings.get(laneId) ?? {
        laneId,
        running: false,
        startedAt: null,
        filePath: null,
        durationMs: null,
        caption: null,
        lastError: null,
        engine: engineForPlatform(),
      };
    },

    isRecording(laneId: string): boolean {
      return recordings.get(laneId)?.running === true;
    },

    /** Feeds a screencast frame to the lane's recording, when one is running on that engine. */
    noteFrame(laneId: string, frame: AppControlScreencastFrame): void {
      const backend = screencastBackends.get(laneId);
      if (!backend || !recordings.get(laneId)?.running) return;
      try {
        backend.pushFrame(appControlRecordingKey(laneId), frame);
      } catch (error) {
        deps.logger.debug("app_control.recording.frame_push_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    stopForAppClosed,

    /** A chat ended: its recordings stop and file themselves. */
    async stopForChat(chatSessionId: string): Promise<void> {
      const chatId = chatSessionId.trim();
      if (!chatId) return;
      const lanes = [...recordings.values()]
        .filter((status) => status.running && status.chatSessionId === chatId)
        .map((status) => status.laneId);
      await Promise.all(lanes.map((laneId) => stopRecording(laneId, chatId, "chat-ended").catch(() => null)));
    },

    /** Waits for a start in flight on the lane, so a caller reads the settled recording state. Never throws. */
    async settleStart(laneId: string): Promise<void> {
      await starting.get(laneId)?.catch(() => null);
    },

    /**
     * Drops the lane's recording state. A start still in flight sees the lane
     * went away when its engine answers, and discards what it started.
     */
    forgetLane(laneId: string): void {
      laneEpochs.set(laneId, (laneEpochs.get(laneId) ?? 0) + 1);
      starting.delete(laneId);
      clearCap(laneId);
      recordings.delete(laneId);
      recordingPaths.delete(laneId);
      endRaw(laneId);
      demoTrackRegistry.discard(appControlRecordingKey(laneId));
      screencastBackends.get(laneId)?.cancel?.(appControlRecordingKey(laneId));
      screencastBackends.delete(laneId);
    },

    dispose(): void {
      unsubscribeInterrupted?.();
      for (const laneId of [...capTimers.keys()]) clearCap(laneId);
      for (const laneId of [...raws.keys()]) {
        endRaw(laneId);
        demoTrackRegistry.discard(appControlRecordingKey(laneId));
      }
      for (const [laneId, backend] of screencastBackends) backend.cancel?.(appControlRecordingKey(laneId));
      screencastBackends.clear();
      recordings.clear();
      recordingPaths.clear();
      deps.windowRecorder?.dispose();
    },
  };
}

export type AppControlRecording = ReturnType<typeof createAppControlRecording>;
