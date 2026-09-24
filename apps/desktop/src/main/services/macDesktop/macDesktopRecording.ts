/**
 * Everything that writes a movie file for a lane's display.
 *
 * Two writers want the same helper: the per-turn time-lapse the chat runtime
 * opens on a turn's first action, and the captioned recording a user or an
 * agent starts deliberately. The helper has exactly one recorder per lane, so
 * this module is where the two are serialized — a user recording stops a
 * running turn clip before it starts, and every path that ends a lane's work
 * closes the turn clip rather than leaving the helper writing into a file
 * nobody will ever claim.
 *
 * The captioned recording follows the Apple device's rules (065f48808):
 *
 * 1. The chat that starts a recording owns it. The proof is filed under that
 *    chat, whichever chat stops it.
 * 2. A recording a chat owns stops itself after ten minutes of wall clock
 *    (`maxSeconds` changes it) and files itself, so an agent that forgets
 *    `record stop` cannot leave the display recording for hours. A recording
 *    with no owning chat has no cap unless it asks for one.
 * 3. Still time is cut by default. `durationMs` is the video; `wallDurationMs`
 *    the real time it covers; `idleCutMs` the difference. `keepIdle` turns it
 *    off. The proof keeps wall-clock times and adds "idle cut m:ss".
 *
 * Split out of `macDesktopService.ts` as pure code motion: the registries and
 * the gates are passed in.
 */

import fs from "node:fs";
import { formatProofDuration, proofIdleCutLabel } from "../../../shared/proofProvenance";
import {
  type DesktopSeatProvider,
  type DesktopSeatReply,
  type MacDesktopEventPayload,
  type MacDesktopRecordStartArgs,
  type MacDesktopRecordingStatus,
  type MacDesktopRecordingStopReason,
  type MacDesktopTimeLapse,
  macDesktopPaneCaption,
} from "../../../shared/types/macDesktop";
import type { Logger } from "../logging/logger";
import type { MacDesktopObservations } from "./macDesktopObservations";
import { clampFps } from "./macDesktopStreamServer";

/** The turn clip's rate. Low on purpose: it is a time-lapse, not a recording. */
const TURN_CLIP_FPS = 4;

/** How long a recording a chat owns may run. Same as the Apple device's. */
export const MAC_DESKTOP_RECORDING_MAX_MS = 10 * 60 * 1000;

/** The longest cap `maxSeconds` may ask for. */
export const MAC_DESKTOP_RECORDING_MAX_SECONDS_LIMIT = 4 * 60 * 60;

/** A caller's `maxSeconds`, in ms, clamped to 1 s .. four hours. Null when absent or not a number. */
function capFromSeconds(maxSeconds: number | null | undefined): number | null {
  if (typeof maxSeconds !== "number" || !Number.isFinite(maxSeconds) || maxSeconds <= 0) return null;
  return Math.round(Math.min(Math.max(maxSeconds, 1), MAC_DESKTOP_RECORDING_MAX_SECONDS_LIMIT) * 1000);
}

/**
 * The cap for a recording: the caller's, or the default when a chat owns it.
 * A person recording with no chat gets none unless they ask.
 */
function recordingCapMs(args: { maxSeconds?: number | null; chatSessionId: string | null }): number | null {
  return capFromSeconds(args.maxSeconds) ?? (args.chatSessionId ? MAC_DESKTOP_RECORDING_MAX_MS : null);
}

type RecordingLengths = { durationMs: number; wallDurationMs: number; idleCutMs: number };

/**
 * The three lengths from a `record.stop` reply.
 *
 * An older driver sends only `durationMs`. It never cuts idle time, so its
 * video length is the wall-clock length and nothing was cut.
 */
function readLengths(reply: DesktopSeatReply): RecordingLengths {
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
  const durationMs = number(reply.durationMs) ?? 0;
  return {
    durationMs,
    wallDurationMs: number(reply.wallDurationMs) ?? durationMs,
    idleCutMs: number(reply.idleCutMs) ?? 0,
  };
}

/** What a recording filed without a caption says first. Apple's, for this display. */
const DEFAULT_RECORDING_DESCRIPTION = "Screen recording of the lane's Mac Desktop.";

/**
 * "0:23" / "1:10 · idle cut 2:07" — the default caption's duration part. The
 * first number is the video's length, which is what the player shows.
 */
function captionDuration(status: MacDesktopRecordingStatus): string {
  const video = formatProofDuration(status.durationMs ?? 0);
  const idleCut = proofIdleCutLabel(status.idleCutMs);
  return idleCut ? `${video} · ${idleCut}` : video;
}

/**
 * The proof's description: the caption (or the default line), then why the
 * video is shorter than its wall-clock times, then the cap when the cap
 * stopped it. Same sentences as the Apple device's proof.
 */
function recordingProofDescription(lead: string, status: MacDesktopRecordingStatus): string {
  const idleCut = proofIdleCutLabel(status.idleCutMs);
  return [
    lead,
    idleCut && typeof status.wallDurationMs === "number"
      ? `Still stretches were shortened: ${idleCut.replace(/^idle cut /, "")} cut from ${formatProofDuration(status.wallDurationMs)} of real time.`
      : null,
    status.stopReason === "cap" && typeof status.maxDurationMs === "number"
      ? `Stopped at its ${formatProofDuration(status.maxDurationMs)} cap.`
      : null,
  ].filter(Boolean).join(" ");
}

/** A finished capture's size for the pane's receipt, or null if it cannot be read. */
export async function readCaptureBytes(filePath: string | null): Promise<number | null> {
  if (!filePath) return null;
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export type MacDesktopRecordingDeps = {
  logger: Logger;
  now: () => number;
  isDarwin: boolean;
  emit: (payload: MacDesktopEventPayload) => void;
  observations: MacDesktopObservations;
  ensureProvider: () => Promise<DesktopSeatProvider>;
  /** The backend only if it is already up: teardown must not start one. */
  activeProvider: () => DesktopSeatProvider | null;
  requireDisplay: (laneId: string) => void;
  assertPermission: (which: "screenRecording" | "accessibility") => void;
  /**
   * The `stop` refusal. The file path is the recording that failed to
   * finalise, when there is one: a second stop after a timeout must name the
   * partial file rather than pretending nothing was ever written.
   */
  recordingNotRunning: (laneId: string, partialFilePath?: string | null) => Error;
  /** The lane's name, for the caption of a recording the cap filed. */
  resolveLaneName?: (laneId: string) => Promise<string | null> | string | null;
  /**
   * A recording was filed as proof. No id: the caller is the service's
   * analytics emitter, and a scratch file that was not filed says nothing.
   */
  onRecordingFiled?: (() => void) | null;
};

export function createMacDesktopRecording(deps: MacDesktopRecordingDeps) {
  /** laneId → the user-facing recording, running or just finished. */
  const recordings = new Map<string, MacDesktopRecordingStatus>();
  /**
   * laneId → the path `record.start` handed the helper.
   *
   * The status only carries a path once a stop returns one, but a stop that
   * fails still leaves a file at this path — and that is the path the caller
   * is told about so a partial recording is not invisible.
   */
  const recordingPaths = new Map<string, string>();
  /** laneId → the timer that stops the recording at its cap. */
  const capTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** laneId → the stop in flight. Serialises a stop against the cap firing. */
  const stopping = new Map<string, Promise<MacDesktopRecordingStatus>>();

  const isUserRecording = (laneId: string): boolean =>
    recordings.get(laneId)?.running === true;

  const clearCap = (laneId: string): void => {
    const timer = capTimers.get(laneId);
    if (timer) clearTimeout(timer);
    capTimers.delete(laneId);
  };

  const armCap = (laneId: string, ms: number): void => {
    clearCap(laneId);
    const timer = setTimeout(() => {
      capTimers.delete(laneId);
      deps.logger.info("mac_desktop.recording.cap_reached", { laneId, maxDurationMs: ms });
      void stopUserRecording(laneId, null, "cap").catch((error: unknown) => {
        deps.logger.warn("mac_desktop.recording.cap_stop_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, ms);
    // A ten-minute timer must not be the reason Electron refuses to quit.
    (timer as unknown as { unref?: () => void }).unref?.();
    capTimers.set(laneId, timer);
  };

  /**
   * Stops the lane's recording and files it under the chat that started it.
   *
   * `stopperChatSessionId` only matters for a recording no chat owns: it is
   * then the chat the proof is filed under, as before owners were kept.
   */
  const stopUserRecording = (
    laneId: string,
    stopperChatSessionId: string | null,
    reason: MacDesktopRecordingStopReason,
  ): Promise<MacDesktopRecordingStatus> => {
    const inFlight = stopping.get(laneId);
    if (inFlight) return inFlight;
    const run = finishUserRecording(laneId, stopperChatSessionId, reason);
    stopping.set(laneId, run);
    const forget = (): void => {
      if (stopping.get(laneId) === run) stopping.delete(laneId);
    };
    run.then(forget, forget);
    return run;
  };

  const finishUserRecording = async (
    laneId: string,
    stopperChatSessionId: string | null,
    reason: MacDesktopRecordingStopReason,
  ): Promise<MacDesktopRecordingStatus> => {
    const existing = recordings.get(laneId);
    if (!existing?.running) {
      // Only a failed recording has a partial file worth naming; a clean
      // stop's path is a finished movie and needs no warning attached.
      throw deps.recordingNotRunning(laneId, existing?.lastError ? existing.filePath : null);
    }
    clearCap(laneId);
    let reply: DesktopSeatReply;
    try {
      const provider = await deps.ensureProvider();
      reply = await provider.stopRecording({ laneId });
    } catch (error) {
      // One truth for recording state. The helper removes its recorder
      // before it finalises, so a stop that fails still means no recording is
      // running — leaving the local status on `running: true` made `status`
      // and the next `stop` disagree, and the pane kept showing a stop
      // button that could only fail. The intended path is kept because a
      // partial file is still inspectable.
      const partialFilePath = recordingPaths.get(laneId) ?? existing.filePath;
      const failed: MacDesktopRecordingStatus = {
        ...existing,
        running: false,
        filePath: partialFilePath,
        lastError: error instanceof Error ? error.message : String(error),
        stopReason: reason,
      };
      recordings.set(laneId, failed);
      // Cleared before the event: a listener that asks to stop again on
      // "stopped" must hear "not running", not get this finished stop back.
      stopping.delete(laneId);
      deps.emit({ type: "recording-changed", status: failed });
      throw error;
    }
    // Wall clock, like the Apple recorder's: the idle cut shortens the video,
    // never the span of real time the proof says it covers.
    const recordedTo = new Date(deps.now()).toISOString();
    recordingPaths.delete(laneId);
    const filePath = typeof reply.filePath === "string" && reply.filePath.trim().length
      ? reply.filePath.trim()
      : null;
    const lengths = readLengths(reply);
    const finished: MacDesktopRecordingStatus = {
      ...existing,
      running: false,
      filePath,
      ...lengths,
      lastError: null,
      stopReason: reason,
    };
    // A caption is the opt-in that makes the file reviewer-facing evidence.
    // Without one it stays a scratch file and nothing reaches the drawer.
    // The pane always sends one; an agent has to write its own. The one
    // exception is the cap: a chat's recording that ran out files itself, as
    // the Apple device's does, under "Mac Desktop recording · {lane} · 0:23".
    const capFiled = !existing.caption && reason === "cap" && Boolean(existing.chatSessionId);
    const caption = existing.caption
      ?? (capFiled
        ? `${macDesktopPaneCaption("recording", await Promise.resolve(deps.resolveLaneName?.(laneId)).catch(() => null))} · ${captionDuration(finished)}`
        : null);
    let proofArtifactId: string | null = null;
    if (caption && filePath) {
      const filed = await deps.observations.ingestProof({
        laneId,
        // The owner, not whoever stopped it: a recording started in one chat
        // and stopped from another (or by the cap) is still the first chat's.
        chatSessionId: existing.chatSessionId ?? stopperChatSessionId,
        toolName: "desktop record",
        title: caption,
        caption: recordingProofDescription(existing.caption ?? DEFAULT_RECORDING_DESCRIPTION, finished),
        filePath,
        kind: "video_recording",
        metadata: {
          durationMs: lengths.durationMs,
          wallDurationMs: lengths.wallDurationMs,
          idleCutMs: lengths.idleCutMs,
          stopReason: reason,
        },
        // ADE's own recorder wrote this file between these two times. Without
        // it the broker read an agent's recording started in an earlier turn
        // as a video "recorded before this request".
        provenance: {
          source: "ade-recorder",
          recordedFrom: existing.startedAt,
          recordedTo,
        },
      }).catch((error: unknown) => {
        deps.logger.warn("mac_desktop.recording_proof_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      proofArtifactId = filed?.artifacts[0]?.id ?? null;
      if (proofArtifactId) deps.onRecordingFiled?.();
    }
    const status: MacDesktopRecordingStatus = {
      ...finished,
      caption,
      proofArtifactId,
      bytes: await readCaptureBytes(filePath),
    };
    recordings.set(laneId, status);
    stopping.delete(laneId);
    deps.emit({ type: "recording-changed", status });
    return status;
  };

  /**
   * Closes any turn clip on the lane, whichever chat and turn opened it.
   *
   * One lane has one writer, so this is a lane question. Asking it per turn id
   * is what let a stale clip keep the helper's recorder — and therefore the
   * lane's only recording slot — after the turn that opened it was gone.
   */
  const closeTurnClips = async (
    laneId: string,
    options: { stopBackend?: boolean } = {},
  ): Promise<{
    ended: ReturnType<MacDesktopObservations["endTurnRecordingsForLane"]>;
    reply: Record<string, unknown> | null;
  }> => {
    const ended = deps.observations.endTurnRecordingsForLane(laneId);
    if (!ended.length) return { ended, reply: null };
    if (options.stopBackend === false) return { ended, reply: null };
    const provider = deps.activeProvider();
    if (!provider) return { ended, reply: null };
    const reply = await provider.stopRecording({ laneId }).catch((error: unknown) => {
      deps.logger.debug("mac_desktop.turn_clip_stop_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    return { ended, reply };
  };

  return {
    recordings,

    /** Counts one action against the turn's clip, if one is open. */
    noteTurnActivity(laneId: string, chatSessionId: string | null | undefined): void {
      const chatId = chatSessionId?.trim();
      if (!chatId) return;
      if (isUserRecording(laneId)) return;
      if (!deps.observations.getTurnRecording(laneId, chatId)) return;
      deps.observations.noteTurnFrame(laneId, chatId);
    },

    /**
     * Starts (or extends) the clip for the turn that is acting right now.
     *
     * There is no cheap frame-assembler in the runtime — no ffmpeg, no encoder —
     * so the clip is the helper's own low-rate recording rather than a pile of
     * stills stitched later. A user-started recording wins: one lane has one
     * writer, and the reviewer-facing capture is the one that matters.
     */
    async startTurnClip(laneId: string, chatSessionId: string, turnId: string): Promise<void> {
      if (isUserRecording(laneId)) return;
      // Under the artifact root, not the scratch root: the thread plays the clip
      // through `ade-artifact://<path>`, and main only serves that scheme from
      // inside `.ade/artifacts`. A clip written anywhere else is a 404 in the UI.
      const filePath = deps.observations.artifactPath(`mac-desktop-turn-${turnId}`, "mp4");
      const recording = deps.observations.beginTurnRecording({
        laneId,
        chatSessionId,
        turnId,
        filePath,
      });
      if (!recording) return;
      try {
        const provider = await deps.ensureProvider();
        await provider.startRecording({ laneId, fps: TURN_CLIP_FPS, filePath });
      } catch (error) {
        deps.observations.endTurnRecording(laneId, chatSessionId);
        deps.logger.debug("mac_desktop.turn_clip_start_failed", {
          laneId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /**
     * Closes the turn clip and publishes the time-lapse.
     *
     * Deliberately not keyed on the turn id: a clip that outlived its turn —
     * a turn that ended without a `done` event, a restarted chat — still holds
     * the lane's one recorder, so whatever is open is what gets closed, and the
     * event carries the turn the clip actually belongs to.
     */
    async noteTurnEnded(args: {
      laneId: string;
      chatSessionId: string;
      turnId: string;
    }): Promise<MacDesktopTimeLapse | null> {
      if (!deps.isDarwin) return null;
      const laneId = args.laneId.trim();
      const chatSessionId = args.chatSessionId.trim();
      // A user recording owns the helper's recorder; the turn clip never
      // started, so its bookkeeping is dropped without touching the backend.
      const userOwnsRecorder = isUserRecording(laneId);
      const { ended, reply } = await closeTurnClips(laneId, { stopBackend: !userOwnsRecorder });
      if (!ended.length || userOwnsRecorder || !reply) return null;
      const recording = ended.find((entry) => entry.turnId === args.turnId) ?? ended[0]!;
      const replyPath = typeof reply.filePath === "string" && reply.filePath.trim().length
        ? reply.filePath.trim()
        : null;
      const replyDuration = typeof reply.durationMs === "number" && Number.isFinite(reply.durationMs)
        ? reply.durationMs
        : null;
      const timeLapse: MacDesktopTimeLapse = {
        laneId,
        chatSessionId: recording.chatSessionId || chatSessionId,
        turnId: recording.turnId,
        filePath: replyPath ?? recording.filePath,
        durationMs: replyDuration ?? Math.max(0, deps.now() - recording.startedAtMs),
        frameCount: recording.frameCount,
        createdAt: new Date(deps.now()).toISOString(),
      };
      // Context, not proof: it never reaches the artifact broker.
      deps.emit({ type: "time-lapse", timeLapse });
      return timeLapse;
    },

    /** Teardown: the lane's display is going away, or its chat ended. */
    async stopTurnClips(laneId: string): Promise<void> {
      await closeTurnClips(laneId, { stopBackend: !isUserRecording(laneId) });
    },

    async startRecording(args: MacDesktopRecordStartArgs): Promise<MacDesktopRecordingStatus> {
      const laneId = args.laneId.trim();
      deps.requireDisplay(laneId);
      const provider = await deps.ensureProvider();
      deps.assertPermission("screenRecording");
      const existing = recordings.get(laneId);
      if (existing?.running) return existing;
      // The helper records one file per lane. A turn clip already writing one
      // would have had its file silently taken over by this start, so it is
      // closed first and the deliberate, reviewer-facing capture wins.
      await closeTurnClips(laneId);
      // Same root as the turn clip: a captioned recording is played back in
      // the thread before it is ever filed as proof.
      const filePath = deps.observations.artifactPath(`mac-desktop-recording-${laneId}`, "mp4");
      const fps = clampFps(args.fps, 15);
      await provider.startRecording({ laneId, fps, filePath, keepIdle: args.keepIdle === true });
      recordingPaths.set(laneId, filePath);
      const chatSessionId = args.chatSessionId?.trim() || null;
      const maxDurationMs = recordingCapMs({ maxSeconds: args.maxSeconds, chatSessionId });
      const status: MacDesktopRecordingStatus = {
        laneId,
        running: true,
        startedAt: new Date(deps.now()).toISOString(),
        filePath: null,
        durationMs: null,
        caption: args.caption?.trim() || null,
        lastError: null,
        chatSessionId,
        maxDurationMs,
      };
      recordings.set(laneId, status);
      if (maxDurationMs !== null) armCap(laneId, maxDurationMs);
      deps.emit({ type: "recording-changed", status });
      return status;
    },

    async stopRecording(args: { laneId: string; chatSessionId?: string | null }): Promise<MacDesktopRecordingStatus> {
      return await stopUserRecording(args.laneId.trim(), args.chatSessionId?.trim() || null, "requested");
    },

    forgetLane(laneId: string): void {
      clearCap(laneId);
      recordings.delete(laneId);
      recordingPaths.delete(laneId);
    },

    clear(): void {
      for (const laneId of [...capTimers.keys()]) clearCap(laneId);
      recordings.clear();
      recordingPaths.clear();
    },
  };
}

export type MacDesktopRecording = ReturnType<typeof createMacDesktopRecording>;
