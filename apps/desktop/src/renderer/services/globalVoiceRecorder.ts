/**
 * App-global voice-dictation recorder (desktop).
 *
 * The Web-Audio capture lifecycle (getUserMedia / AudioContext /
 * ScriptProcessorNode / analyser / timer) lives here as a MODULE-LEVEL
 * SINGLETON so a recording survives React unmounts: the user can start dictating
 * in a chat composer, navigate to another tab/pane, and capture keeps running.
 * The capture used to live inside `VoiceDictationButton.tsx` and died whenever
 * that component unmounted; extracting it here is what makes navigation safe.
 *
 * The recorder publishes its live state to the ROOT app store
 * (`dictationPhase`, `dictationElapsed`, `dictationLevels`) so both the
 * always-mounted header indicator and the (project-scoped) composer pill render
 * the same session. On `finish()` it transcribes via the transcription IPC,
 * inserts the cleaned text into the registered `activeDictationTarget` (if any),
 * and ALWAYS copies the cleaned text to the clipboard as a recovery net.
 */

import {
  DICTATION_WAVEFORM_BARS,
  rootAppStoreApi,
} from "../state/appStore";

const TARGET_SAMPLE_RATE = 16_000;

export type GlobalVoiceRecorderError =
  | "mic_denied"
  | "mic_unavailable"
  | "no_audio"
  | "model_not_installed"
  | "transcribe_failed";

type ErrorListener = (error: GlobalVoiceRecorderError) => void;

/**
 * Downsample mono Float32 PCM from `sourceRate` to 16 kHz and quantize to Int16.
 * Whisper expects 16 kHz mono PCM, so we decode it here rather than shipping a
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

class GlobalVoiceRecorder {
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
  private elapsed = 0;
  /** Guards against double-start while a `start()` is mid-flight (pre-getUserMedia). */
  private starting = false;
  /** Invalidates an optimistic start when Cancel fires before getUserMedia resolves. */
  private startGeneration = 0;
  private readonly errorListeners = new Set<ErrorListener>();

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private emitError(error: GlobalVoiceRecorderError): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        // a listener throwing must not abort teardown / other listeners
      }
    }
  }

  isRecording(): boolean {
    return rootAppStoreApi.getState().dictationPhase === "recording";
  }

  isBusy(): boolean {
    return this.starting || rootAppStoreApi.getState().dictationPhase !== "idle";
  }

  /**
   * Begin capture. Resolves once capture is wired up (or has failed). The store
   * is flipped to `recording` OPTIMISTICALLY by the caller before this resolves;
   * on permission denial / failure we reset the session and emit an error so the
   * UI can revert the optimistic pill.
   *
   * Starting while already recording (or starting) is a no-op — only one
   * recording at a time.
   */
  async start(): Promise<void> {
    if (this.isBusy()) return;
    const generation = this.startGeneration + 1;
    this.startGeneration = generation;
    this.starting = true;
    this.chunks = [];
    this.elapsed = 0;

    const store = rootAppStoreApi.getState();
    store.setDictationElapsed(0);
    store.setDictationLevels(new Array(DICTATION_WAVEFORM_BARS).fill(0.05));
    // Optimistic: open the pill immediately, BEFORE getUserMedia resolves. If
    // permission is denied / capture fails below we reset the session to idle.
    store.setDictationPhase("recording");

    try {
      // On macOS, Electron hands back a silent (all-zero) track instead of
      // throwing when the OS hasn't granted mic access, so confirm/request the
      // system-level permission first rather than silently recording silence.
      const ensureAccess = window.ade?.transcription?.requestMicAccess;
      if (ensureAccess) {
        const access = await ensureAccess();
        if (!this.isActiveStart(generation)) return;
        if (access.status !== "granted") {
          this.teardown();
          rootAppStoreApi.getState().resetDictationSession();
          this.emitError(
            access.status === "denied" || access.status === "restricted"
              ? "mic_denied"
              : "mic_unavailable",
          );
          return;
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this.isActiveStart(generation)) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      this.mediaStream = stream;

      const AudioCtor =
        window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) {
        throw new Error("Web Audio API is not available.");
      }
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
        const channel = event.inputBuffer.getChannelData(0);
        this.chunks.push(new Float32Array(channel));
      };
      source.connect(processor);
      const silentSink = audioContext.createGain();
      silentSink.gain.value = 0;
      this.silentSink = silentSink;
      processor.connect(silentSink);
      silentSink.connect(audioContext.destination);

      // Phase was already flipped to "recording" optimistically above.
      this.startWaveform();
      this.timerId = window.setInterval(() => {
        this.elapsed += 1;
        rootAppStoreApi.getState().setDictationElapsed(this.elapsed);
      }, 1000);
    } catch (error) {
      if (this.startGeneration !== generation) return;
      this.teardown();
      rootAppStoreApi.getState().resetDictationSession();
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      this.emitError(denied ? "mic_denied" : "mic_unavailable");
    } finally {
      this.starting = false;
    }
  }

  /** Discard the in-flight recording and return to idle. */
  cancel(): void {
    this.startGeneration += 1;
    this.teardown();
    this.chunks = [];
    this.elapsed = 0;
    rootAppStoreApi.getState().resetDictationSession();
  }

  private isActiveStart(generation: number): boolean {
    return (
      this.startGeneration === generation
      && rootAppStoreApi.getState().dictationPhase === "recording"
    );
  }

  /**
   * Stop capture, transcribe, insert into the active target (if any), and ALWAYS
   * copy the cleaned transcript to the clipboard. Resets the session to idle.
   */
  async finish(): Promise<void> {
    // Ignore a "done" fired during start()'s optimistic window (phase is already
    // "recording" but the audio graph isn't wired yet) — otherwise we'd finish
    // with zero captured chunks and surface a spurious "no audio" error.
    if (this.starting) return;
    if (rootAppStoreApi.getState().dictationPhase !== "recording") return;
    const sourceRate = this.sampleRate;
    const chunks = this.chunks;
    this.teardown();

    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    if (totalLength === 0) {
      this.chunks = [];
      rootAppStoreApi.getState().resetDictationSession();
      this.emitError("no_audio");
      return;
    }
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];

    rootAppStoreApi.getState().setDictationPhase("transcribing");
    try {
      const pcm = downsampleToInt16(merged, sourceRate);
      // Transfer the ArrayBuffer to main (zero-copy across the IPC boundary).
      const result = await window.ade.transcription.transcribe(
        pcm.buffer as ArrayBuffer,
        { sampleRate: TARGET_SAMPLE_RATE, format: "int16" },
      );
      const cleaned = result.cleaned.trim();
      if (cleaned) {
        // Insert into the currently-registered composer if one exists; otherwise
        // the clipboard copy below is the only landing spot.
        const target = rootAppStoreApi.getState().activeDictationTarget;
        if (target) {
          try {
            target.focus();
          } catch {
            // focus is best-effort
          }
          try {
            target.insertText(cleaned);
          } catch {
            // Clipboard copy below is the recovery path when the live target fails.
          }
        }
        // Always copy to the clipboard as a recovery net (and the sole sink when
        // no composer is registered).
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(cleaned).catch(() => {});
        }
      } else if (!result.raw.trim()) {
        this.emitError("no_audio");
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      this.emitError(
        raw.includes("model_not_installed:")
          ? "model_not_installed"
          : raw.includes("empty_audio:")
            ? "no_audio"
            : "transcribe_failed",
      );
    } finally {
      rootAppStoreApi.getState().resetDictationSession();
    }
  }

  private startWaveform(): void {
    const analyser = this.analyser;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      const currentAnalyser = this.analyser;
      if (!currentAnalyser) return;
      currentAnalyser.getByteTimeDomainData(data);
      // Compute RMS amplitude of the current frame, then fold it into a rolling
      // bar array so the pill shows a live, real-amplitude waveform.
      let sumSquares = 0;
      for (let i = 0; i < data.length; i += 1) {
        const centered = (data[i]! - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      const amplitude = Math.max(0.05, Math.min(1, rms * 3));
      const prev = rootAppStoreApi.getState().dictationLevels;
      const next = prev.slice(1);
      next.push(amplitude);
      rootAppStoreApi.getState().setDictationLevels(next);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Stop animation + timer and fully tear down the audio graph + mic tracks. */
  private teardown(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timerId != null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    try {
      this.processor?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.silentSink?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.sourceNode?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.analyser?.disconnect();
    } catch {
      // ignore
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
export const globalVoiceRecorder = new GlobalVoiceRecorder();
