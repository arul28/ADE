import fs from "node:fs";
import path from "node:path";
import type {
  AndroidEmulatorAgentServiceApi,
  AndroidMachinePreferences,
  AndroidRecording,
  AndroidRecordingStopReason,
} from "../../../shared/types/androidEmulator";
import { DEFAULT_ANDROID_MACHINE_PREFERENCES } from "../../../shared/types/androidEmulator";
import type { DemoTrackEventKind } from "../../../shared/demoVideo/demoContract";
import { RECORDING_MAX_MS } from "../../../shared/demoVideo/demoContract";
import { demoProofSentence, recordingStopSentence } from "../../../shared/demoVideo/demoProofText";
import { formatProofDuration, proofIdleCutLabel } from "../../../shared/proofProvenance";
import type { DemoEngineSet } from "../demoVideo/demoEngines";
import { watchDemoRecording } from "../demoVideo/demoRecordingGuard";
import { demoRecordingKey, demoTrackRegistry } from "../demoVideo/demoTrackRegistry";
import type { Logger } from "../logging/logger";
import { NOOP_LOGGER } from "../logging/machineLogger";
import { getErrorMessage } from "../shared/utils";
import { androidRawVideoFallback, produceAndroidRecordingVideo } from "./androidDemoRecording";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
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
import type { AndroidStreamHub } from "./androidStream";

/*
 * The lane's recording sessions, at the level of Apple's
 * (`ios/recording/simRecordingService.ts`): one at a time per lane, fed by
 * the packets of the lane's stream.
 *
 * - `auto`: an agent's input started it (`noteInput`). It stops at the end
 *   of that agent's turn (`onTurnEnded`). A `record-start` while it runs
 *   converts it to `manual`, with no gap: the auto cap goes, and the manual
 *   cap counts from the conversion.
 * - Every recording stops at its cap (five minutes at most), after two
 *   minutes with nothing happening, when its raw file or the disk runs out
 *   of room (`watchDemoRecording`), and when the device goes off, the lane
 *   lets it go, or the chat that started it ends.
 * - Each input is noted on the recording's demo track (`android:<lane>`), so
 *   the demo draws a ring where it landed and a badge for typed text (the
 *   machine preferences decide, when it starts). `ade proof step` captions
 *   reach the same track by lane.
 * - At the stop the parts become one video (`androidDemoRecording.ts`),
 *   filed as ONE proof row. Only that file stays.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

export type AndroidRecordingSessionDeps = {
  requireBooted: (laneId: string) => Promise<unknown>;
  /** Throws when the lane is a work copy that is gone. */
  assertWorkCopyLive: (laneId: string) => void;
  streams: Pick<AndroidStreamHub, "subscribePackets">;
  /** Starts (or joins) the lane's stream for a recording; answers its serial. */
  holdStreamForRecording: (laneId: string) => Promise<string>;
  /** The recording is done with the stream; it stops unless a viewer holds it. */
  releaseStreamForRecording: (laneId: string) => Promise<void>;
  artifactFiler: AndroidArtifactFiler | null;
  /** Where proof is placed by path (the project's root). */
  callerRoot: string | null;
  dataDir: string;
  logger: Logger | null;
  now: () => Date;
  /** A recording started or ended (by anyone): the panes read their Record button again. */
  onRecordingChanged?: (laneId: string, recording: AndroidRecording) => void;
  /** The engines that make the demo. Absent: the recording is filed as recorded. */
  demoEngines?: DemoEngineSet | null;
  /** The machine preferences, read at record time. */
  readPreferences?: () => AndroidMachinePreferences;
  /** The screen's size in device pixels now (the unit of input points). */
  screenSize?: (laneId: string) => Promise<{ width: number; height: number }>;
  /** The lane's AVD name, for the proof caption. */
  deviceName?: (laneId: string) => string | null;
};

/** A stopped recording whose video is still made. */
type Render = { id: string; promise: Promise<AndroidRecording> };

type ActiveRecording = {
  recording: AndroidRecording;
  recorder: ReturnType<typeof createAndroidMp4Recorder>;
  untap: () => void;
  capTimer: ReturnType<typeof setTimeout> | null;
  /** The first packet the recorder could not write; the recording ends with it. */
  writeError: string | null;
  /** Ends the idle, size and disk watch. */
  stopWatch: () => void;
  /** The device size in pixels, with the stream picture's orientation when read. */
  deviceSize: { width: number; height: number; landscape: boolean } | null;
  /** The wall clock of the first frame, for the demo track's time 0. */
  firstFrameAtMs: number | null;
};

/** `budgetMs` bounds the demo render; past it the raw video is filed. */
type FinishOptions = { discard?: boolean; proof?: boolean; budgetMs?: number };

/** The demo render's bound while ADE shuts down: the raw video is filed past it. */
const ANDROID_DISPOSE_DEMO_BUDGET_MS = 5_000;

/** What an input noted on a recording carries. Points are device pixels. */
export type AndroidRecordingInput = {
  laneId: string;
  chatSessionId: string | null;
  kind: DemoTrackEventKind;
  by: "user" | "agent";
  x?: number;
  y?: number;
  to?: { x: number; y: number } | null;
  /** Shown as a badge when the keyBadges preference is on. Already checked for secrets. */
  label?: string;
  atMs?: number;
  seconds?: number;
};

/** The recording's key in the demo track registry. One recording per lane. */
export function androidDemoKey(laneId: string): string {
  return demoRecordingKey("android", laneId);
}

export function createAndroidRecordingSessions(deps: AndroidRecordingSessionDeps) {
  const { logger, now } = deps;
  const demoLogger: Logger = logger ?? NOOP_LOGGER;
  const recordings = new Map<string, ActiveRecording>();
  /**
   * A start that has not finished yet. The slot is taken before the first
   * await, so a second start refuses and a stop waits for this one.
   */
  const starting = new Map<string, Promise<AndroidRecording>>();
  /** A recording that ended on its own (its cap, the device going off) and no stop has collected yet. */
  const uncollected = new Map<string, AndroidRecording>();
  /** The id of the lane's newest started recording: only it may set `uncollected`, however the renders finish. */
  const newest = new Map<string, string>();
  /**
   * A stopped recording whose video is still made and filed (up to the demo
   * budget). It no longer holds the lane's slot, as Apple's: the next turn
   * may record while it renders. The newest per lane; a second stop waits on it.
   */
  const rendering = new Map<string, Render>();
  /** Every video still made, on every lane: `dispose` waits for all of them. */
  const renders = new Set<Render>();
  /** `totalBytes`, until a recording starts, ends or is deleted. */
  let bytesOnDisk: number | null = null;

  const preferences = (): AndroidMachinePreferences => {
    try {
      return deps.readPreferences?.() ?? DEFAULT_ANDROID_MACHINE_PREFERENCES;
    } catch (error) {
      logger?.warn("android.preferences_read_failed", { error: getErrorMessage(error) });
      return DEFAULT_ANDROID_MACHINE_PREFERENCES;
    }
  };

  const captionDuration = (recording: AndroidRecording): string => {
    const video = formatProofDuration(recording.durationMs ?? 0);
    const idleCut = proofIdleCutLabel(recording.idleCutMs ?? null);
    return idleCut ? `${video} · ${idleCut}` : video;
  };

  /** Files the recording's video as one proof row (several only when its parts could not be joined). */
  const fileRecording = (recording: AndroidRecording): string[] => {
    const device = deps.deviceName?.(recording.laneId)?.trim() || "Android emulator";
    const description = [
      "Screen recording of the lane's Android emulator.",
      demoProofSentence(recording.demo),
      recordingStopSentence(recording.stopReason, recording.maxDurationMs),
    ].filter(Boolean).join(" ");
    const ids: string[] = [];
    recording.segments.forEach((segment, index) => {
      const part = recording.segments.length > 1 ? ` (part ${index + 1} of ${recording.segments.length})` : "";
      const id = fileAndroidCaptureAsProof(deps.artifactFiler, {
        laneId: recording.laneId,
        chatSessionId: recording.chatSessionId,
        kind: "video_recording",
        path: segment.path,
        mimeType: "video/mp4",
        title: `${recording.label?.trim() || `Emulator recording · ${device} · ${captionDuration(recording)}`}${part}`,
        description,
        toolName: "android_record",
        source: "ade-recorder",
        callerRoot: deps.callerRoot,
        metadata: {
          recordingId: recording.id,
          width: segment.width,
          height: segment.height,
          durationMs: recording.durationMs,
          ...(typeof recording.wallDurationMs === "number" ? { wallDurationMs: recording.wallDurationMs } : {}),
          ...(typeof recording.idleCutMs === "number" ? { idleCutMs: recording.idleCutMs } : {}),
          ...(recording.stopReason ? { stopReason: recording.stopReason } : {}),
          mode: recording.mode ?? "manual",
          overlays: recording.overlays ?? false,
          ...(recording.demo ? { demo: recording.demo } : {}),
          ...(recording.segments.length > 1 ? { part: index + 1 } : {}),
        },
      }, (error) => logger?.warn("android.recording_proof_failed", { laneId: recording.laneId, error: getErrorMessage(error) }));
      if (id) ids.push(id);
    });
    return ids;
  };

  const finish = (laneId: string, reason: AndroidRecordingStopReason, options: FinishOptions = {}): Promise<AndroidRecording> => {
    const active = recordings.get(laneId);
    // The slot is freed before the first await below, so a second finish
    // finds no recording and gets the render already on its way.
    if (!active) {
      return rendering.get(laneId)?.promise
        ?? Promise.reject(new AndroidEmulatorFailure("ANDROID_RECORDING_NOT_FOUND", "No recording is running on this lane."));
    }
    const finishing = (async () => {
      // The capture ends now: the slot is free before the video is made.
      recordings.delete(laneId);
      deps.onRecordingChanged?.(laneId, { ...active.recording, active: false });
      active.untap();
      active.stopWatch();
      if (active.capTimer) clearTimeout(active.capTimer);
      active.capTimer = null;
      const demoKey = androidDemoKey(laneId);
      const stoppedAtMs = Date.now();
      const endedAt = now().toISOString();
      // The stream is not needed for the demo: give it back first, so a
      // viewer-less emulator stops streaming while the demo renders.
      const releaseStream = deps.releaseStreamForRecording(laneId).catch((error: unknown) => {
        logger?.warn("android.recording_stream_release_failed", { laneId, error: getErrorMessage(error) });
      });
      let recording: AndroidRecording;
      if (options.discard) {
        active.recorder.abandon();
        demoTrackRegistry.discard(demoKey);
        recording = { ...active.recording, active: false, endedAt, stopReason: reason, segments: [], durationMs: 0, bytes: 0 };
      } else {
        let segments: AndroidRecording["segments"] = [];
        let lastError: string | null = active.writeError;
        try {
          segments = active.recorder.finish();
        } catch (error) {
          lastError ??= `The video could not be written: ${getErrorMessage(error)}`;
          active.recorder.abandon();
        }
        if (segments.length === 0 && !lastError) {
          lastError = "The emulator sent no picture while the recording ran, so there is no video. Start the emulator's screen (wake it) and record again.";
        }
        const wallMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
        if (active.firstFrameAtMs !== null) demoTrackRegistry.markFirstFrame(demoKey, active.firstFrameAtMs);
        const track = demoTrackRegistry.end(demoKey, { durationSeconds: wallMs / 1000, atMs: stoppedAtMs });
        recording = { ...active.recording, active: false, endedAt, stopReason: reason, segments: [], durationMs: 0, bytes: 0, lastError };
        if (segments.length > 0) {
          const video = await produceAndroidRecordingVideo({
            segments,
            outputPath: active.recording.path,
            track,
            plain: active.recording.plain === true,
            engines: deps.demoEngines?.engines() ?? [],
            missingEngineReason: deps.demoEngines?.missingEngineReason?.() ?? null,
            logger: demoLogger,
            ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
          }).catch((error: unknown) => {
            // Not reached for a render failure (the raw video is filed then);
            // a disk error here keeps the parts where they are.
            logger?.warn("android.recording_video_failed", { laneId, error: getErrorMessage(error) });
            return androidRawVideoFallback(segments, wallMs, null);
          });
          recording = {
            ...recording,
            segments: video.files,
            path: video.files[0]?.path ?? active.recording.path,
            durationMs: video.durationMs,
            wallDurationMs: video.wallDurationMs,
            idleCutMs: video.idleCutMs,
            bytes: video.bytes,
            demo: video.demo,
            lastError: video.unusable ? video.unusable : recording.lastError,
          };
          if (video.files.length > 0) {
            // A disk or proof error must not keep the lane marked as recording.
            try {
              writeAndroidRecordingSidecar(deps.dataDir, recording);
              if (options.proof !== false) {
                recording = { ...recording, proofArtifactIds: fileRecording(recording) };
                writeAndroidRecordingSidecar(deps.dataDir, recording);
              }
            } catch (error) {
              const message = getErrorMessage(error);
              logger?.warn("android.recording_file_failed", { laneId, error: message });
              recording = { ...recording, lastError: recording.lastError ?? `The video could not be filed: ${message}` };
            }
          }
        }
      }
      bytesOnDisk = null;
      // A newer recording on the lane makes this one stale, also when its render ends first:
      // a later stop answers the newer one.
      if (reason !== "requested" && newest.get(laneId) === recording.id) uncollected.set(laneId, recording);
      // A newer recording may run by now: the panes then read that one.
      deps.onRecordingChanged?.(laneId, recordings.get(laneId)?.recording ?? recording);
      logger?.info("android.recording_stopped", {
        laneId,
        id: recording.id,
        reason,
        mode: recording.mode,
        files: recording.segments.length,
        durationMs: recording.durationMs,
        wallDurationMs: recording.wallDurationMs ?? null,
        bytes: recording.bytes,
        engine: recording.demo?.engine ?? null,
        proofs: recording.proofArtifactIds.length,
      });
      await releaseStream;
      return recording;
    })();
    const render: Render = { id: active.recording.id, promise: finishing };
    rendering.set(laneId, render);
    renders.add(render);
    void finishing.finally(() => {
      renders.delete(render);
      if (rendering.get(laneId) === render) rendering.delete(laneId);
    }).catch(() => undefined);
    return finishing;
  };

  /**
   * Ends the lane's recording, if one runs, and logs a failure as `event`.
   * Never throws. `waitForStart` first lets a start still on its way finish,
   * so it cannot hold the stream of a device that is going away. The stream's
   * own ending must not wait: a start can be what ends the old stream.
   */
  const finishQuietly = async (
    laneId: string,
    reason: AndroidRecordingStopReason,
    event: string,
    options: { waitForStart?: boolean; budgetMs?: number } = {},
  ): Promise<void> => {
    if (options.waitForStart) await starting.get(laneId)?.catch(() => null);
    if (!recordings.has(laneId)) return;
    await finish(laneId, reason, options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}).catch((error: unknown) => {
      logger?.warn(event, { laneId, error: getErrorMessage(error) });
    });
  };

  const armCap = (laneId: string, active: ActiveRecording, capMs: number) => {
    if (active.capTimer) clearTimeout(active.capTimer);
    active.capTimer = setTimeout(() => {
      void finishQuietly(laneId, "cap", "android.recording_cap_stop_failed");
    }, capMs);
    (active.capTimer as { unref?: () => void }).unref?.();
  };

  /** Bytes of the `.mp4` files under the recordings folder, every lane. */
  const countRecordingBytes = (): number => {
    const root = path.join(deps.dataDir, "recordings");
    let total = 0;
    let lanes: string[];
    try {
      lanes = fs.readdirSync(root);
    } catch {
      return 0;
    }
    for (const lane of lanes) {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(root, lane));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".mp4")) continue;
        try {
          total += fs.statSync(path.join(root, lane, name)).size;
        } catch {
          // A file removed while counting adds nothing.
        }
      }
    }
    return total;
  };

  type BeginArgs = Parameters<AndroidEmulatorAgentServiceApi["recordStart"]>[0] & { mode: "auto" | "manual" };

  const begin = async (laneId: string, args: BeginArgs): Promise<AndroidRecording> => {
    await deps.requireBooted(laneId);
    const startedAt = now();
    const id = newAndroidRecordingId(startedAt);
    const basePath = path.join(androidRecordingsDir(deps.dataDir, laneId), id);
    const recorder = createAndroidMp4Recorder({ basePath });
    // A machine with no engine here fetches ADE's ffmpeg now, not at the stop.
    try {
      deps.demoEngines?.prepare?.();
    } catch (error) {
      logger?.warn("android.recording_engine_prepare_failed", { laneId, error: getErrorMessage(error) });
    }
    const serial = await deps.holdStreamForRecording(laneId);
    const prefs = preferences();
    const plain = args.plain === true;
    const capMs = args.mode === "auto" ? RECORDING_MAX_MS : androidRecordingCapMs(args.maxSeconds);
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
      mode: args.mode,
      plain,
      overlays: !plain && (prefs.tapRings || prefs.keyBadges),
      maxDurationMs: capMs,
    };
    const demoKey = androidDemoKey(laneId);
    const active: ActiveRecording = {
      recording,
      recorder,
      untap: () => undefined,
      capTimer: null,
      writeError: null,
      stopWatch: () => undefined,
      deviceSize: null,
      firstFrameAtMs: null,
    };
    demoTrackRegistry.begin(demoKey, { surface: "android", chatSessionId: recording.chatSessionId, laneId, zoom: args.zoom === true && !plain });
    try {
      active.untap = deps.streams.subscribePackets(serial, (packet) => {
        if (active.writeError) return;
        try {
          recorder.push(packet);
          if (active.firstFrameAtMs === null && !packet.config && recorder.elapsedMs() > 0) active.firstFrameAtMs = Date.now();
        } catch (error) {
          // One bad write spoils the file: end the recording with the error, once.
          active.writeError = `The video could not be written: ${getErrorMessage(error)}`;
          logger?.warn("android.recording_packet_failed", { laneId, error: getErrorMessage(error) });
          void finish(laneId, "stream-failed").catch(() => undefined);
        }
      });
    } catch (error) {
      demoTrackRegistry.discard(demoKey);
      await deps.releaseStreamForRecording(laneId).catch(() => undefined);
      throw error;
    }
    recordings.set(laneId, active);
    newest.set(laneId, id);
    // Only a start that took replaces the last unread recording: a failed one keeps it.
    uncollected.delete(laneId);
    bytesOnDisk = null;
    if (active.writeError) {
      // The first packet failed before the slot was set.
      void finish(laneId, "stream-failed").catch(() => undefined);
      return recording;
    }
    armCap(laneId, active, capMs);
    active.stopWatch = watchDemoRecording({
      key: demoKey,
      rawPath: recording.path,
      logger: demoLogger,
      onLimit: (limit) => {
        void finishQuietly(laneId, limit, "android.recording_limit_stop_failed");
      },
    });
    logger?.info("android.recording_started", { laneId, id, capMs, mode: args.mode, plain });
    deps.onRecordingChanged?.(laneId, recording);
    return recording;
  };

  const startSlot = async (laneId: string, args: BeginArgs): Promise<AndroidRecording> => {
    const start = begin(laneId, args);
    starting.set(laneId, start);
    try {
      return await start;
    } finally {
      if (starting.get(laneId) === start) starting.delete(laneId);
    }
  };

  /** The point as a fraction of the recorded frame; null when the size is not known. */
  const normalize = async (active: ActiveRecording, laneId: string, x: number, y: number): Promise<{ x: number; y: number } | null> => {
    const picture = active.recorder.pictureSize();
    const landscape = picture ? picture.width > picture.height : null;
    let size = active.deviceSize;
    if (!size || (landscape !== null && size.landscape !== landscape)) {
      if (size && landscape !== null && size.landscape !== landscape) {
        // The screen turned: the same device, its sides swapped.
        size = { width: size.height, height: size.width, landscape };
      } else {
        const read = await deps.screenSize?.(laneId).catch(() => null);
        if (!read || read.width <= 0 || read.height <= 0) return null;
        size = { ...read, landscape: read.width > read.height };
      }
      active.deviceSize = size;
    }
    return { x: x / size.width, y: y / size.height };
  };

  const api: Pick<AndroidEmulatorAgentServiceApi, "recordStart" | "recordStop" | "recordList" | "recordDelete"> = {
    async recordStart(args) {
      const laneId = requireLaneId(args?.laneId);
      deps.assertWorkCopyLive(laneId);
      await starting.get(laneId)?.catch(() => null);
      const running = recordings.get(laneId);
      if (running && running.recording.mode === "auto") {
        // Conversion, not restart: the file keeps going, the auto cap goes,
        // and the manual cap counts from now.
        const capMs = androidRecordingCapMs(args.maxSeconds);
        running.recording = {
          ...running.recording,
          mode: "manual",
          label: args.label?.trim() || running.recording.label,
          chatSessionId: running.recording.chatSessionId ?? (args.chatSessionId?.trim() || null),
          maxDurationMs: capMs,
          plain: args.plain === true ? true : running.recording.plain,
        };
        armCap(laneId, running, capMs);
        if (args.zoom === true) demoTrackRegistry.requestZoom(androidDemoKey(laneId));
        logger?.info("android.recording_converted", { laneId, id: running.recording.id, capMs });
        deps.onRecordingChanged?.(laneId, running.recording);
        return running.recording;
      }
      if (running || starting.has(laneId)) {
        throw new AndroidEmulatorFailure(
          "ANDROID_RECORDING_ACTIVE",
          running
            ? `A recording (${running.recording.id}) is already running on this lane since ${running.recording.startedAt}. Stop it first: ade android record-stop.`
            : "A recording is starting on this lane. Stop it first: ade android record-stop.",
        );
      }
      return startSlot(laneId, { ...args, mode: "manual" });
    },

    async recordStop(args) {
      const laneId = requireLaneId(args?.laneId);
      // A start still on its way: let it finish (or fail) first, then stop what it started.
      await starting.get(laneId)?.catch(() => null);
      if (!recordings.has(laneId)) {
        // Stopped by its turn or its cap, and its video is still made: answer that one when it is filed.
        const inFlight = rendering.get(laneId);
        if (inFlight) {
          const ended = await inFlight.promise;
          if (uncollected.get(laneId) === ended) uncollected.delete(laneId);
          return ended;
        }
        const ended = uncollected.get(laneId);
        if (ended) {
          // It already ended (its cap, the device going off): answer that one, once.
          uncollected.delete(laneId);
          return ended;
        }
        throw new AndroidEmulatorFailure("ANDROID_RECORDING_NOT_FOUND", "No recording is running on this lane. Start one with ade android record-start.");
      }
      const discard = args.discard === true && args.keep !== true;
      return finish(laneId, "requested", { discard, ...(args.proof === false ? { proof: false } : {}) });
    },

    async recordList(args) {
      const laneId = requireLaneId(args?.laneId);
      const active = recordings.get(laneId);
      const done = listAndroidRecordings(deps.dataDir, laneId);
      return { laneId, recordings: active ? [{ ...active.recording, durationMs: active.recorder.elapsedMs() }, ...done] : done };
    },

    async recordDelete(args) {
      const laneId = requireLaneId(args?.laneId);
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) throw new Error("record-delete needs --id <recording id> (ade android record-list shows them).");
      if (recordings.get(laneId)?.recording.id === id) {
        throw new AndroidEmulatorFailure("ANDROID_RECORDING_ACTIVE", "That recording is still running. Stop it first (ade android record-stop --discard drops it).");
      }
      if ([...renders].some((render) => render.id === id)) {
        throw new AndroidEmulatorFailure("ANDROID_RECORDING_ACTIVE", "That recording's video is still being made. Delete it when record-stop answers.");
      }
      const deleted = deleteAndroidRecording(deps.dataDir, laneId, id);
      bytesOnDisk = null;
      if (!deleted) throw new AndroidEmulatorFailure("ANDROID_RECORDING_NOT_FOUND", `No recording ${id} on this lane. ade android record-list shows them.`);
      return { laneId, id, deleted };
    },
  };

  return {
    api,
    finishQuietly,

    /** True while a recording holds the lane's stream. */
    isRecording(laneId: string): boolean {
      return recordings.has(laneId);
    },

    /** The lanes whose recording a chat started. */
    lanesOfChat(chatSessionId: string): string[] {
      return [...recordings].filter(([, active]) => active.recording.chatSessionId === chatSessionId).map(([laneId]) => laneId);
    },

    /**
     * Starts an automatic recording for an agent's input, when none runs.
     * The caller has checked the opt-outs. Never throws: an input never
     * fails because a recording could not start.
     */
    async startAuto(laneId: string, chatSessionId: string | null): Promise<void> {
      if (recordings.has(laneId) || starting.has(laneId)) {
        await starting.get(laneId)?.catch(() => null);
        return;
      }
      try {
        deps.assertWorkCopyLive(laneId);
        await startSlot(laneId, { laneId, chatSessionId, mode: "auto" });
      } catch (error) {
        logger?.warn("android.recording_auto_start_failed", { laneId, error: getErrorMessage(error) });
      }
    },

    /** True while the lane's recording makes a demo (not plain), so typing is paced. */
    isDemoRecording(laneId: string): boolean {
      return demoTrackRegistry.isRecording(androidDemoKey(laneId));
    },

    /**
     * Notes an input on the lane's recording, for the demo: a ring at its
     * point (`tapRings`), a badge for its label (`keyBadges`). Nothing when
     * no recording runs. Never throws.
     */
    async noteInput(input: AndroidRecordingInput): Promise<void> {
      const active = recordings.get(input.laneId);
      if (!active) return;
      try {
        const atMs = input.atMs ?? Date.now();
        const overlays = active.recording.overlays === true;
        const prefs = preferences();
        const rings = overlays && prefs.tapRings;
        const point = rings && typeof input.x === "number" && typeof input.y === "number"
          ? await normalize(active, input.laneId, input.x, input.y)
          : null;
        const to = point && input.to ? await normalize(active, input.laneId, input.to.x, input.to.y) : null;
        const label = overlays && prefs.keyBadges ? input.label?.trim() : undefined;
        demoTrackRegistry.note(androidDemoKey(input.laneId), {
          kind: input.kind,
          by: input.by,
          atMs,
          ...(point ? { x: point.x, y: point.y } : {}),
          ...(to ? { to: [to.x, to.y] as [number, number] } : {}),
          ...(label ? { label } : {}),
          ...(input.seconds ? { seconds: input.seconds } : {}),
        });
      } catch (error) {
        logger?.warn("android.recording_note_failed", { laneId: input.laneId, error: getErrorMessage(error) });
      }
    },

    /** The device turned or changed size: read its size again on the next note. */
    forgetScreenSize(laneId: string): void {
      const active = recordings.get(laneId);
      if (active) active.deviceSize = null;
    },

    /**
     * A chat's turn ended: its automatic recordings stop and are filed. Never
     * throws. A start still in flight (scrcpy can take longer than the input's
     * wait) belongs to this turn too: it is waited for and then stopped. Only
     * what was running or starting when the turn ended stops, so the chat's
     * next turn keeps its own recording.
     */
    async onTurnEnded(chatSessionId: string): Promise<void> {
      const ownedBy = (recording: AndroidRecording | null | undefined): recording is AndroidRecording =>
        recording?.mode === "auto" && recording.chatSessionId === chatSessionId;
      const ending = new Map<string, string>();
      for (const [laneId, active] of recordings) {
        if (ownedBy(active.recording)) ending.set(laneId, active.recording.id);
      }
      const pending = [...starting.entries()];
      for (const [laneId, start] of pending) {
        const started = await start.catch(() => null);
        if (ownedBy(started)) ending.set(laneId, started.id);
      }
      for (const [laneId, recordingId] of ending) {
        if (recordings.get(laneId)?.recording.id !== recordingId) continue;
        await finishQuietly(laneId, "turn-end", "android.recording_turn_end_stop_failed");
      }
    },

    /** Bytes of this project's Android recordings on disk, every lane. Counted again after a start, an end or a delete. */
    totalBytes(): number {
      bytesOnDisk ??= countRecordingBytes();
      return bytesOnDisk;
    },

    async dispose(): Promise<void> {
      await Promise.all([...starting.values()].map((start) => start.catch(() => null)));
      for (const laneId of [...recordings.keys()]) {
        await finishQuietly(laneId, "device-off", "android.recording_dispose_stop_failed", { budgetMs: ANDROID_DISPOSE_DEMO_BUDGET_MS });
      }
      // A video still made from an earlier stop is filed before the service goes.
      await Promise.all([...renders].map((render) => render.promise.catch(() => null)));
    },
  };
}
