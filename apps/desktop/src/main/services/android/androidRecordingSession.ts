import path from "node:path";
import type {
  AndroidEmulatorAgentServiceApi,
  AndroidRecording,
  AndroidRecordingStopReason,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
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
 * The lane's recording sessions: one at a time per lane, fed by the packets
 * of the lane's stream, ended by a stop, its cap, the device going off, the
 * lane letting the device go, or the chat that started it ending.
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
};

type ActiveRecording = {
  recording: AndroidRecording;
  recorder: ReturnType<typeof createAndroidMp4Recorder>;
  untap: () => void;
  capTimer: ReturnType<typeof setTimeout> | null;
  finishing: Promise<AndroidRecording> | null;
  /** The first packet the recorder could not write; the recording ends with it. */
  writeError: string | null;
};

type FinishOptions = { discard?: boolean; proof?: boolean };

export function createAndroidRecordingSessions(deps: AndroidRecordingSessionDeps) {
  const { logger, now } = deps;
  const recordings = new Map<string, ActiveRecording>();
  /**
   * A start that has not finished yet. The slot is taken before the first
   * await, so a second start refuses and a stop waits for this one.
   */
  const starting = new Map<string, Promise<AndroidRecording>>();
  /** A recording that ended on its own (its cap, the device going off) and no stop has collected yet. */
  const uncollected = new Map<string, AndroidRecording>();

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

  const finish = (laneId: string, reason: AndroidRecordingStopReason, options: FinishOptions = {}): Promise<AndroidRecording> => {
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
    options: { waitForStart?: boolean } = {},
  ): Promise<void> => {
    if (options.waitForStart) await starting.get(laneId)?.catch(() => null);
    if (!recordings.has(laneId)) return;
    await finish(laneId, reason).catch((error: unknown) => {
      logger?.warn(event, { laneId, error: getErrorMessage(error) });
    });
  };

  const begin = async (laneId: string, args: Parameters<AndroidEmulatorAgentServiceApi["recordStart"]>[0]): Promise<AndroidRecording> => {
    await deps.requireBooted(laneId);
    uncollected.delete(laneId);
    const startedAt = now();
    const id = newAndroidRecordingId(startedAt);
    const basePath = path.join(androidRecordingsDir(deps.dataDir, laneId), id);
    const recorder = createAndroidMp4Recorder({ basePath });
    const serial = await deps.holdStreamForRecording(laneId);
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
    const active: ActiveRecording = { recording, recorder, untap: () => undefined, capTimer: null, finishing: null, writeError: null };
    try {
      active.untap = deps.streams.subscribePackets(serial, (packet) => {
        if (active.writeError) return;
        try {
          recorder.push(packet);
        } catch (error) {
          // One bad write spoils the file: end the recording with the error, once.
          active.writeError = `The video could not be written: ${getErrorMessage(error)}`;
          logger?.warn("android.recording_packet_failed", { laneId, error: getErrorMessage(error) });
          void finish(laneId, "stream-failed").catch(() => undefined);
        }
      });
    } catch (error) {
      await deps.releaseStreamForRecording(laneId).catch(() => undefined);
      throw error;
    }
    recordings.set(laneId, active);
    if (active.writeError) {
      // The first packet failed before the slot was set.
      void finish(laneId, "stream-failed").catch(() => undefined);
      return recording;
    }
    const capMs = androidRecordingCapMs(args.maxSeconds);
    active.capTimer = setTimeout(() => {
      void finishQuietly(laneId, "cap", "android.recording_cap_stop_failed");
    }, capMs);
    (active.capTimer as { unref?: () => void }).unref?.();
    logger?.info("android.recording_started", { laneId, id, capMs });
    deps.onRecordingChanged?.(laneId, recording);
    return recording;
  };

  const api: Pick<AndroidEmulatorAgentServiceApi, "recordStart" | "recordStop" | "recordList" | "recordDelete"> = {
    async recordStart(args) {
      const laneId = requireLaneId(args?.laneId);
      deps.assertWorkCopyLive(laneId);
      const running = recordings.get(laneId)?.recording;
      if (running || starting.has(laneId)) {
        throw new AndroidEmulatorFailure(
          "ANDROID_RECORDING_ACTIVE",
          running
            ? `A recording (${running.id}) is already running on this lane since ${running.startedAt}. Stop it first: ade android record-stop.`
            : "A recording is starting on this lane. Stop it first: ade android record-stop.",
        );
      }
      // Take the slot before the first await: a second start refuses, and a stop waits.
      const start = begin(laneId, args);
      starting.set(laneId, start);
      try {
        return await start;
      } finally {
        if (starting.get(laneId) === start) starting.delete(laneId);
      }
    },

    async recordStop(args) {
      const laneId = requireLaneId(args?.laneId);
      // A start still on its way: let it finish (or fail) first, then stop what it started.
      await starting.get(laneId)?.catch(() => null);
      if (!recordings.has(laneId)) {
        const ended = uncollected.get(laneId);
        if (ended) {
          // It already ended (its cap, the device going off): answer that one, once.
          uncollected.delete(laneId);
          return ended;
        }
        throw new AndroidEmulatorFailure("ANDROID_RECORDING_NOT_FOUND", "No recording is running on this lane. Start one with ade android record-start.");
      }
      return finish(laneId, "requested", { discard: args.discard === true, ...(args.proof === false ? { proof: false } : {}) });
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
      const deleted = deleteAndroidRecording(deps.dataDir, laneId, id);
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

    async dispose(): Promise<void> {
      await Promise.all([...starting.values()].map((start) => start.catch(() => null)));
      for (const laneId of [...recordings.keys()]) {
        await finishQuietly(laneId, "device-off", "android.recording_dispose_stop_failed");
      }
    },
  };
}
