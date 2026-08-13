// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rootAppStoreApi } from "../state/appStore";
import { AudioCaptureFailure, audioCaptureRecorder } from "./audioCaptureRecorder";

/**
 * The renderer half of `ade.audio.captureClip`.
 *
 * Every assertion here is really about one promise settling exactly once: the
 * requesting plugin has no timeout and no UI, so a capture that neither
 * resolves nor rejects is a plugin hung forever with nothing on screen.
 *
 * The Web Audio graph is stubbed rather than driven — jsdom has no
 * `AudioContext` and no microphone — so what is exercised is the lifecycle
 * (who settles, with what, and whether the pill returns to idle), not the DSP.
 */

/**
 * Reach past `private` to seed the sample buffer.
 *
 * The audio graph is what normally fills `chunks`, and jsdom has none — so the
 * alternative to this cast is a fake `AudioContext` that also drives
 * `onaudioprocess`, which would test the stub rather than the lifecycle.
 */
type RecorderInternals = {
  chunks: Float32Array[];
  sampleRate: number;
};

const recorder = audioCaptureRecorder as unknown as RecorderInternals;

let writeClip: ReturnType<typeof vi.fn>;
let requestMicAccess: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;

function installAudioStubs(): void {
  writeClip = vi.fn(async () => ({ audioPath: "/tmp/clip.wav", durationMs: 1234 }));
  requestMicAccess = vi.fn(async () => ({ status: "granted" as const }));
  (window as unknown as { ade: Record<string, unknown> }).ade = {
    ...(window as unknown as { ade?: Record<string, unknown> }).ade,
    audio: { writeClip, requestMicAccess, discardClip: vi.fn() },
  };

  const track = { stop: vi.fn() };
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });

  // A minimal AudioContext: enough for the recorder to wire its graph without
  // asserting anything about the audio itself.
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  (window as unknown as { AudioContext: unknown }).AudioContext = class {
    sampleRate = 16_000;
    state = "running";
    createMediaStreamSource = vi.fn(() => node());
    createAnalyser = vi.fn(() => ({ ...node(), fftSize: 0, frequencyBinCount: 8, getByteTimeDomainData: vi.fn() }));
    createScriptProcessor = vi.fn(() => ({ ...node(), onaudioprocess: null }));
    createGain = vi.fn(() => ({ ...node(), gain: { value: 0 } }));
    destination = {};
    close = vi.fn(async () => {});
  };
  window.requestAnimationFrame = (() => 0) as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = (() => {}) as unknown as typeof window.cancelAnimationFrame;
}

/** Put samples in the buffer the way the audio graph would have. */
function seedCapturedAudio(samples = 16_000): void {
  recorder.chunks = [new Float32Array(samples)];
  recorder.sampleRate = 16_000;
}

describe("audio capture recorder", () => {
  beforeEach(() => {
    installAudioStubs();
    rootAppStoreApi.getState().resetAudioCaptureSession();
  });

  afterEach(() => {
    recorder.chunks = [];
    rootAppStoreApi.getState().resetAudioCaptureSession();
  });

  it("resolves with the clip main wrote, and returns the pill to idle", async () => {
    const capture = audioCaptureRecorder.capture({ requestId: "r1", label: "Voice" });
    await Promise.resolve();
    seedCapturedAudio();
    await audioCaptureRecorder.finish();

    await expect(capture).resolves.toEqual({ audioPath: "/tmp/clip.wav", durationMs: 1234 });
    expect(rootAppStoreApi.getState().audioCapturePhase).toBe("idle");
    expect(rootAppStoreApi.getState().audioCaptureRequester).toBeNull();
  });

  it("names the requester on the pill while recording", async () => {
    const capture = audioCaptureRecorder.capture({ requestId: "r1", label: "Voice" });
    // Set synchronously, before getUserMedia resolves: the attribution has to
    // be on screen by the time the OS permission prompt appears.
    expect(rootAppStoreApi.getState().audioCaptureRequester).toEqual({
      requestId: "r1",
      label: "Voice",
    });
    expect(rootAppStoreApi.getState().audioCapturePhase).toBe("recording");

    audioCaptureRecorder.cancel();
    await expect(capture).rejects.toBeInstanceOf(AudioCaptureFailure);
  });

  it("rejects with audio_capture_cancelled when the user dismisses the pill", async () => {
    const capture = audioCaptureRecorder.capture({ requestId: "r1", label: "Voice" });
    await Promise.resolve();
    audioCaptureRecorder.cancel();

    await expect(capture).rejects.toMatchObject({ code: "audio_capture_cancelled" });
    expect(rootAppStoreApi.getState().audioCapturePhase).toBe("idle");
  });

  it("rejects a concurrent request with audio_capture_busy and keeps the first alive", async () => {
    const first = audioCaptureRecorder.capture({ requestId: "r1", label: "Voice" });
    await Promise.resolve();

    await expect(
      audioCaptureRecorder.capture({ requestId: "r2", label: "Notes" }),
    ).rejects.toMatchObject({ code: "audio_capture_busy" });

    // The refusal must not have disturbed the recording already on screen.
    expect(rootAppStoreApi.getState().audioCaptureRequester?.requestId).toBe("r1");
    seedCapturedAudio();
    await audioCaptureRecorder.finish();
    await expect(first).resolves.toMatchObject({ audioPath: "/tmp/clip.wav" });
  });

  it("resolves rather than rejects when maxDurationMs elapses", async () => {
    vi.useFakeTimers();
    try {
      const capture = audioCaptureRecorder.capture({
        requestId: "r1",
        label: "Voice",
        maxDurationMs: 50,
      });
      await Promise.resolve();
      await Promise.resolve();
      seedCapturedAudio();

      // The caller asked for AT MOST this much audio, so what was captured up
      // to the cap is the answer — rejecting would throw away a real recording.
      await vi.advanceTimersByTimeAsync(60);

      await expect(capture).resolves.toMatchObject({ audioPath: "/tmp/clip.wav" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with audio_capture_empty when nothing was recorded", async () => {
    const capture = audioCaptureRecorder.capture({ requestId: "r1", label: "Voice" });
    await Promise.resolve();
    recorder.chunks = [];
    await audioCaptureRecorder.finish();

    await expect(capture).rejects.toMatchObject({ code: "audio_capture_empty" });
    expect(writeClip).not.toHaveBeenCalled();
  });

  it("rejects when the OS refuses the microphone, without opening a graph", async () => {
    requestMicAccess.mockResolvedValueOnce({ status: "denied" });
    const capture = audioCaptureRecorder.capture({ requestId: "r1", label: "Voice" });

    await expect(capture).rejects.toMatchObject({ code: "audio_capture_mic_unavailable" });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(rootAppStoreApi.getState().audioCapturePhase).toBe("idle");
  });

  it("rejects when the clip cannot be written", async () => {
    writeClip.mockRejectedValueOnce(new Error("capture_failed: disk full"));
    const capture = audioCaptureRecorder.capture({ requestId: "r1", label: "Voice" });
    await Promise.resolve();
    seedCapturedAudio();
    await audioCaptureRecorder.finish();

    await expect(capture).rejects.toMatchObject({ code: "audio_capture_failed" });
    expect(rootAppStoreApi.getState().audioCapturePhase).toBe("idle");
  });

  it("frees the microphone for the next request after a failure", async () => {
    requestMicAccess.mockResolvedValueOnce({ status: "denied" });
    await expect(
      audioCaptureRecorder.capture({ requestId: "r1", label: "Voice" }),
    ).rejects.toBeInstanceOf(AudioCaptureFailure);

    const second = audioCaptureRecorder.capture({ requestId: "r2", label: "Voice" });
    await Promise.resolve();
    seedCapturedAudio();
    await audioCaptureRecorder.finish();
    await expect(second).resolves.toMatchObject({ audioPath: "/tmp/clip.wav" });
  });
});
