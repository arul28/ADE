import { randomUUID } from "node:crypto";

import type { Logger } from "../logging/logger";
import type { AudioClip } from "./audioCaptureService";

/**
 * Routes a capture request to a window that can serve it, and waits.
 *
 * The microphone lives in a renderer and the caller does not, so a capture is a
 * request/response across a boundary that only pushes one way: main sends
 * `audioCaptureRequest` to a window, that window records, and it answers on
 * `audioCaptureResult`. This module is the piece in the middle that turns those
 * two one-way messages back into a promise.
 *
 * Three failure modes it has to own, because no one else can see them:
 *
 *   - **No window.** A capture asked for while ADE has no open window cannot be
 *     consented to by anyone, so it is refused immediately rather than left
 *     hanging until a window happens to appear.
 *   - **The window goes away mid-recording.** A closed window sends no result,
 *     so the pending request would hang forever. The destroyed check settles it.
 *   - **A second request.** There is one microphone and one pill; the renderer
 *     refuses concurrent captures too, but refusing here as well means a second
 *     caller never even raises a prompt in front of the user.
 *
 * Deliberately NOT time-limited beyond the caller's own `maxDurationMs`: a
 * recording ends when the person speaking decides it does, and a broker-side
 * timeout would cut off a long recording mid-sentence.
 */

export type AudioCaptureRequestSender = {
  /** True when this window can no longer serve or answer. */
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
};

export type AudioCaptureOutcome =
  | { requestId: string; ok: true; clip: AudioClip }
  | { requestId: string; ok: false; code: string; message: string };

export class AudioCaptureRefused extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AudioCaptureRefused";
    this.code = code;
  }
}

export type AudioCaptureBroker = {
  /** Ask a window to record, and resolve with the clip it produced. */
  requestCapture(args: { label: string; maxDurationMs?: number }): Promise<AudioClip>;
  /** Deliver a renderer's answer. Unknown request ids are ignored. */
  settle(outcome: AudioCaptureOutcome): void;
  /** Fail the in-flight request, if its window just went away. */
  abandonIfServedBy(sender: AudioCaptureRequestSender): void;
  dispose(): void;
};

type Pending = {
  requestId: string;
  sender: AudioCaptureRequestSender;
  resolve: (clip: AudioClip) => void;
  reject: (error: AudioCaptureRefused) => void;
};

export function createAudioCaptureBroker({
  logger,
  resolveSender,
  requestChannel,
}: {
  logger: Logger;
  /** The window that should serve a capture, or null when there is none. */
  resolveSender: () => AudioCaptureRequestSender | null;
  requestChannel: string;
}): AudioCaptureBroker {
  let pending: Pending | null = null;

  const settlePending = (deliver: (entry: Pending) => void): void => {
    const entry = pending;
    if (!entry) return;
    pending = null;
    deliver(entry);
  };

  return {
    requestCapture({ label, maxDurationMs }) {
      if (pending) {
        return Promise.reject(
          new AudioCaptureRefused("audio_capture_busy", "Another recording is already in progress."),
        );
      }
      const sender = resolveSender();
      if (!sender || sender.isDestroyed()) {
        return Promise.reject(
          new AudioCaptureRefused(
            "audio_capture_mic_unavailable",
            "ADE has no open window to record from.",
          ),
        );
      }

      const requestId = randomUUID();
      const promise = new Promise<AudioClip>((resolve, reject) => {
        pending = { requestId, sender, resolve, reject };
      });
      logger.info("audio.capture_requested", { requestId, label });
      sender.send(requestChannel, {
        requestId,
        label,
        ...(maxDurationMs != null ? { maxDurationMs } : {}),
      });
      return promise;
    },

    settle(outcome) {
      if (!pending || pending.requestId !== outcome.requestId) return;
      settlePending((entry) => {
        if (outcome.ok) {
          entry.resolve(outcome.clip);
          return;
        }
        entry.reject(new AudioCaptureRefused(outcome.code, outcome.message));
      });
    },

    abandonIfServedBy(sender) {
      if (!pending || pending.sender !== sender) return;
      settlePending((entry) => {
        entry.reject(
          new AudioCaptureRefused(
            "audio_capture_failed",
            "The window that was recording closed before it finished.",
          ),
        );
      });
    },

    dispose() {
      settlePending((entry) => {
        entry.reject(new AudioCaptureRefused("audio_capture_failed", "ADE is shutting down."));
      });
    },
  };
}
