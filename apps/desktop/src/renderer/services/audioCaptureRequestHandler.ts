import {
  AudioCaptureFailure,
  audioCaptureRecorder,
  type AudioCaptureRequest,
} from "./audioCaptureRecorder";

/**
 * Serve capture requests the main process routes to this window.
 *
 * The renderer is the only place with a microphone, so it answers rather than
 * asks: main pushes a request, the recorder runs, and the outcome goes back on
 * the reply channel. Installed once at app start, outside React, because a
 * capture must survive whatever the user navigates to while it runs.
 *
 * Every path answers exactly once. A request that is never settled leaves the
 * calling plugin waiting forever with no pill on screen to explain it, so the
 * failure branch is not a nicety — an unhandled throw here IS the hang.
 */
export function installAudioCaptureRequestHandler(): () => void {
  const api = window.ade?.audio;
  if (!api?.onCaptureRequest || !api.settleCaptureRequest) return () => {};

  return api.onCaptureRequest((request: AudioCaptureRequest) => {
    void (async () => {
      try {
        const clip = await audioCaptureRecorder.capture(request);
        await api.settleCaptureRequest({ requestId: request.requestId, ok: true, clip });
      } catch (error) {
        const code = error instanceof AudioCaptureFailure ? error.code : "audio_capture_failed";
        const message = error instanceof Error && error.message
          ? error.message
          : "The recording failed.";
        try {
          await api.settleCaptureRequest({ requestId: request.requestId, ok: false, code, message });
        } catch {
          // Main has gone away; there is no one left to tell.
        }
      }
    })();
  });
}
