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
 * Split out of `macDesktopService.ts` as pure code motion: the registries and
 * the gates are passed in.
 */

import {
  type DesktopSeatProvider,
  type MacDesktopEventPayload,
  type MacDesktopRecordStartArgs,
  type MacDesktopRecordingStatus,
  type MacDesktopTimeLapse,
} from "../../../shared/types/macDesktop";
import type { Logger } from "../logging/logger";
import type { MacDesktopObservations } from "./macDesktopObservations";

/** The turn clip's rate. Low on purpose: it is a time-lapse, not a recording. */
const TURN_CLIP_FPS = 4;

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
  recordingNotRunning: (laneId: string) => Error;
};

export function createMacDesktopRecording(deps: MacDesktopRecordingDeps) {
  /** laneId → the user-facing recording, running or just finished. */
  const recordings = new Map<string, MacDesktopRecordingStatus>();

  const isUserRecording = (laneId: string): boolean =>
    recordings.get(laneId)?.running === true;

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
      const fps = Math.max(1, Math.min(60, Math.round(args.fps ?? 15)));
      await provider.startRecording({ laneId, fps, filePath });
      const status: MacDesktopRecordingStatus = {
        laneId,
        running: true,
        startedAt: new Date(deps.now()).toISOString(),
        filePath: null,
        durationMs: null,
        caption: args.caption?.trim() || null,
      };
      recordings.set(laneId, status);
      deps.emit({ type: "recording-changed", status });
      return status;
    },

    async stopRecording(args: { laneId: string; chatSessionId?: string | null }): Promise<MacDesktopRecordingStatus> {
      const laneId = args.laneId.trim();
      const existing = recordings.get(laneId);
      if (!existing?.running) throw deps.recordingNotRunning(laneId);
      const provider = await deps.ensureProvider();
      const reply = await provider.stopRecording({ laneId });
      const status: MacDesktopRecordingStatus = {
        ...existing,
        running: false,
        filePath: typeof reply.filePath === "string" && reply.filePath.trim().length
          ? reply.filePath.trim()
          : null,
        durationMs: typeof reply.durationMs === "number" && Number.isFinite(reply.durationMs)
          ? reply.durationMs
          : 0,
      };
      recordings.set(laneId, status);
      deps.emit({ type: "recording-changed", status });
      // A caption is the opt-in that makes the file reviewer-facing evidence.
      // Without one it stays a scratch file and nothing reaches the drawer.
      if (status.caption && status.filePath) {
        await deps.observations.ingestProof({
          laneId,
          chatSessionId: args.chatSessionId ?? null,
          toolName: "desktop record",
          title: status.caption,
          caption: status.caption,
          filePath: status.filePath,
          kind: "video_recording",
          metadata: { durationMs: status.durationMs },
        }).catch((error: unknown) => {
          deps.logger.warn("mac_desktop.recording_proof_failed", {
            laneId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return status;
    },

    forgetLane(laneId: string): void {
      recordings.delete(laneId);
    },

    clear(): void {
      recordings.clear();
    },
  };
}

export type MacDesktopRecording = ReturnType<typeof createMacDesktopRecording>;
