/**
 * App-global audio recorder (desktop).
 *
 * ADE records clips on a plugin's behalf, because a plugin child is a separate
 * process and has no microphone. Nothing here knows what a clip is FOR: the
 * same capture serves a transcriber, a voice memo, or an audio classifier, and
 * this module never learns which plugin asked beyond the name it shows on the
 * pill.
 *
 * The Web-Audio capture lifecycle (getUserMedia / AudioContext /
 * ScriptProcessorNode / analyser / timer) lives here as a MODULE-LEVEL
 * SINGLETON so a recording survives React unmounts: the user can start a
 * capture, navigate to another tab, and it keeps running. It publishes its live
 * state to the ROOT app store so the always-mounted header pill renders the
 * session from anywhere.
 *
 * ## One at a time
 *
 * There is one microphone and one pill. A second request while a capture is in
 * flight is REFUSED rather than queued: a plugin that waited its turn would
 * start recording at a moment the user has no reason to associate with it, and
 * the pill can only honestly attribute one requester at a time.
 */

import {
  AUDIO_CAPTURE_WAVEFORM_BARS,
  rootAppStoreApi,
} from "../state/appStore";

const TARGET_SAMPLE_RATE = 16_000;

/**
 * Why a capture ended without a clip. These strings are the wire contract —
 * they travel to the requesting plugin as its rejection code.
 */
export type AudioCaptureFailureCode =
  /** The user dismissed the pill. */
  | "audio_capture_cancelled"
  /** Another capture was already in flight. */
  | "audio_capture_busy"
  /** The OS or the browser refused the microphone. */
  | "audio_capture_mic_unavailable"
  /** Recording worked but produced no samples. */
  | "audio_capture_empty"
  /** Anything else — the graph failed, or the clip could not be written. */
  | "audio_capture_failed";

export class AudioCaptureFailure extends Error {
  code: AudioCaptureFailureCode;
  constructor(code: AudioCaptureFailureCode, message: string) {
    super(message);
    this.name = "AudioCaptureFailure";
    this.code = code;
  }
}

export type AudioCaptureRequest = {
  requestId: string;
  /** The requesting plugin's display name, shown on the pill. */
  label: string;
  /** Stop and resolve automatically after this long. */
  maxDurationMs?: number;
};

export type AudioCaptureResult = {
  audioPath: string;
  durationMs: number;
};

/**
 * Downsample mono Float32 PCM from `sourceRate` to 16 kHz and quantize to Int16.
 *
 * 16 kHz mono is what speech models want and it is a quarter the bytes of the
 * typical 48 kHz capture, so the decode happens here rather than shipping a
 * webm/MediaRecorder blob the main process would have to transcode.
 */
export function downsampleToInt16(input: Float32Array, sourceRate: number): Int16Array {
  if (sourceRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]!));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    // Average the source window that maps to this output sample to avoid aliasing.
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j]!;
      count += 1;
    }
    const sample = count > 0 ? sum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

type PendingCapture = {
  requestId: string;
  resolve: (result: AudioCaptureResult) => void;
  reject: (error: AudioCaptureFailure) => void;
  settled: boolean;
};

class AudioCaptureRecorder {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentSink: GainNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = TARGET_SAMPLE_RATE;
  private rafId: number | null = null;
  private timerId: number | null = null;
  private maxDurationTimer: number | null = null;
  private elapsed = 0;
  private pending: PendingCapture | null = null;


  isBusy(): boolean {
    return this.pending != null;
  }

  /**
   * Still recording for THIS request.
   *
   * The id comparison matters as much as the null check: `capture()` awaits the
   * microphone permission and `getUserMedia`, and a cancel during either await
   * settles the request and clears `pending`. Without the id, a capture that
   * started immediately afterwards would be adopted by the resumed older call.
   */
  private isStillPending(requestId: string): boolean {
    return this.pending?.requestId === requestId;
  }

  /**
   * Record one clip and resolve with where it landed.
   *
   * The promise is the whole API: it settles when the user stops the recording
   * (resolve), dismisses the pill (reject `audio_capture_cancelled`), or
   * `maxDurationMs` elapses (resolve with what was captured).
   */
  async capture(request: AudioCaptureRequest): Promise<AudioCaptureResult> {
    if (this.pending) {
      throw new AudioCaptureFailure(
        "audio_capture_busy",
        "Another recording is already in progress.",
      );
    }

    const store = rootAppStoreApi.getState();
    this.chunks = [];
    this.elapsed = 0;
    store.setAudioCaptureElapsed(0);
    store.setAudioCaptureLevels(new Array(AUDIO_CAPTURE_WAVEFORM_BARS).fill(0.05));
    store.setAudioCaptureRequester({ requestId: request.requestId, label: request.label });
    // Optimistic: open the pill immediately, BEFORE getUserMedia resolves, so
    // the user sees who is asking at the moment the OS prompt appears.
    store.setAudioCapturePhase("recording");

    const settlement = new Promise<AudioCaptureResult>((resolve, reject) => {
      this.pending = { requestId: request.requestId, resolve, reject, settled: false };
    });

    try {
      // On macOS, Electron hands back a silent (all-zero) track instead of
      // throwing when the OS hasn't granted mic access, so confirm/request the
      // system-level permission first rather than silently recording silence.
      const ensureAccess = window.ade?.audio?.requestMicAccess;
      if (ensureAccess) {
        const access = await ensureAccess();
        if (!this.isStillPending(request.requestId)) return await settlement;
        if (access.status !== "granted") {
          this.fail(
            "audio_capture_mic_unavailable",
            access.status === "denied" || access.status === "restricted"
              ? "ADE does not have microphone access."
              : "Could not start the microphone.",
          );
          return await settlement;
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this.isStillPending(request.requestId)) {
        for (const track of stream.getTracks()) track.stop();
        return await settlement;
      }
      this.mediaStream = stream;

      const AudioCtor =
        window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) throw new Error("Web Audio API is not available.");
      const audioContext = new AudioCtor();
      this.audioContext = audioContext;
      this.sampleRate = audioContext.sampleRate;

      const source = audioContext.createMediaStreamSource(stream);
      this.sourceNode = source;

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      this.analyser = analyser;
      source.connect(analyser);

      // ScriptProcessorNode is deprecated but still the broadest Electron-safe
      // option for dependency-free PCM capture. Migrate this to AudioWorkletNode
      // once the renderer can bundle a worklet module without changing the
      // downstream 16 kHz PCM pipeline.
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      this.processor = processor;
      processor.onaudioprocess = (event) => {
        this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      const silentSink = audioContext.createGain();
      silentSink.gain.value = 0;
      this.silentSink = silentSink;
      processor.connect(silentSink);
      silentSink.connect(audioContext.destination);

      this.startWaveform();
      this.timerId = window.setInterval(() => {
        this.elapsed += 1;
        rootAppStoreApi.getState().setAudioCaptureElapsed(this.elapsed);
      }, 1000);

      if (request.maxDurationMs && request.maxDurationMs > 0) {
        // Resolve rather than reject: the caller asked for AT MOST this much
        // audio, so what was captured up to the cap is the answer, not a
        // failure. Rejecting would throw away a recording the user just made.
        this.maxDurationTimer = window.setTimeout(() => {
          void this.finish();
        }, request.maxDurationMs);
      }
    } catch (error) {
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      this.fail(
        denied ? "audio_capture_mic_unavailable" : "audio_capture_failed",
        error instanceof Error && error.message ? error.message : "Could not start the microphone.",
      );
    }

    return await settlement;
  }

  /** Discard the in-flight recording; the requester gets a cancellation. */
  cancel(): void {
    this.fail("audio_capture_cancelled", "The recording was cancelled.");
  }

  /** Stop capture, write the clip, and resolve the requester with its path. */
  async finish(): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    if (rootAppStoreApi.getState().audioCapturePhase !== "recording") return;

    const sourceRate = this.sampleRate;
    const chunks = this.chunks;
    this.teardown();
    this.chunks = [];

    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    if (totalLength === 0) {
      this.fail("audio_capture_empty", "No audio was captured.");
      return;
    }

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    rootAppStoreApi.getState().setAudioCapturePhase("saving");
    try {
      const pcm = downsampleToInt16(merged, sourceRate);
      // Transfer the ArrayBuffer to main (zero-copy across the IPC boundary).
      const clip = await window.ade.audio.writeClip(pcm.buffer as ArrayBuffer, {
        sampleRate: TARGET_SAMPLE_RATE,
        format: "int16",
      });
      this.settle(pending, () => pending.resolve(clip));
    } catch (error) {
      this.fail(
        "audio_capture_failed",
        error instanceof Error && error.message ? error.message : "Could not save the recording.",
      );
    }
  }

  private fail(code: AudioCaptureFailureCode, message: string): void {
    const pending = this.pending;
    this.teardown();
    this.chunks = [];
    if (!pending || pending.settled) {
      rootAppStoreApi.getState().resetAudioCaptureSession();
      return;
    }
    this.settle(pending, () => pending.reject(new AudioCaptureFailure(code, message)));
  }

  /** Settle exactly once, and always return the pill to idle. */
  private settle(pending: PendingCapture, deliver: () => void): void {
    pending.settled = true;
    this.pending = null;
    rootAppStoreApi.getState().resetAudioCaptureSession();
    deliver();
  }

  private startWaveform(): void {
    const analyser = this.analyser;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      const currentAnalyser = this.analyser;
      if (!currentAnalyser) return;
      currentAnalyser.getByteTimeDomainData(data);
      // RMS amplitude of the current frame, folded into a rolling bar array so
      // the pill shows a live, real-amplitude waveform.
      let sumSquares = 0;
      for (let i = 0; i < data.length; i += 1) {
        const centered = (data[i]! - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      const amplitude = Math.max(0.05, Math.min(1, rms * 3));
      const prev = rootAppStoreApi.getState().audioCaptureLevels;
      const next = prev.slice(1);
      next.push(amplitude);
      rootAppStoreApi.getState().setAudioCaptureLevels(next);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Stop animation + timers and fully tear down the audio graph + mic tracks. */
  private teardown(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timerId != null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.maxDurationTimer != null) {
      window.clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    for (const disconnect of [this.processor, this.silentSink, this.sourceNode, this.analyser]) {
      try {
        disconnect?.disconnect();
      } catch {
        // Best-effort: a node the context already tore down throws here.
      }
    }
    this.processor = null;
    this.silentSink = null;
    this.sourceNode = null;
    this.analyser = null;
    if (this.audioContext && this.audioContext.state !== "closed") {
      void this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    for (const track of this.mediaStream?.getTracks() ?? []) {
      track.stop();
    }
    this.mediaStream = null;
  }
}

/** The single app-global recorder instance. */
export const audioCaptureRecorder = new AudioCaptureRecorder();
