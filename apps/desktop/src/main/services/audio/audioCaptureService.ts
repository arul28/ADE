import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";

/**
 * Staging for audio clips a plugin asked ADE to record.
 *
 * ADE does not transcribe, recognize, or interpret audio — it has no speech
 * model and no transcriber binary. What it has is the microphone: the renderer
 * owns the Web Audio graph, and a plugin child (a separate process, in the
 * daemon) has no way to reach it. So the app records and hands over a FILE, and
 * whatever the clip is for is entirely the caller's business.
 *
 * That is the whole reason this module is generic. There is no dictation here,
 * no glossary and no plugin id: the same capability serves a transcriber, a
 * voice-memo recorder, or an audio-classification plugin, and core never learns
 * which one asked.
 *
 * A PATH rather than the bytes, because both processes are on this machine and
 * a two-minute clip is several megabytes — routing it through a JSON-RPC
 * envelope would encode and decode it twice for no gain.
 *
 * Clips are CALLER-OWNED once handed over: the caller reads the file and is
 * free to keep or drop it. Nothing here deletes a clip it has already reported,
 * because the caller may still be reading it. Leftovers are the startup sweep's
 * problem — see `legacyAudioArtifacts.ts`.
 */

export type AudioClip = {
  /** Absolute path to a 16-bit PCM WAV, readable by any process on this machine. */
  audioPath: string;
  durationMs: number;
};

export type AudioCaptureErrorCode = "empty_audio" | "capture_failed";

/** Typed so the layer above can map to the SDK's error vocabulary. */
export class AudioCaptureError extends Error {
  code: AudioCaptureErrorCode;
  constructor(code: AudioCaptureErrorCode, message: string) {
    super(message);
    this.name = "AudioCaptureError";
    this.code = code;
  }
}

export type AudioCaptureService = {
  /** Write captured PCM as a WAV clip and report where it landed. */
  writeClip: (pcm: Int16Array | Float32Array, options?: { sampleRate?: number }) => AudioClip;
  /** Delete a clip this service staged. Unknown paths are ignored, never deleted. */
  discardClip: (audioPath: string) => void;
  dispose: () => void;
};

const DEFAULT_SAMPLE_RATE = 16_000;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 48_000;

function validateSampleRate(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new AudioCaptureError(
      "capture_failed",
      `Invalid audio sample rate; expected ${MIN_SAMPLE_RATE}-${MAX_SAMPLE_RATE} Hz.`,
    );
  }
  return Math.round(sampleRate);
}

/**
 * Encode mono PCM as a 16-bit little-endian WAV. The header is written by hand
 * so there is no ffmpeg / native-codec dependency anywhere in this path.
 */
export function pcmToWavBuffer(pcm: Int16Array | Float32Array, sampleRate: number): Buffer {
  let samples: Int16Array;
  if (pcm instanceof Float32Array) {
    samples = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, pcm[i]!));
      samples[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
  } else {
    samples = pcm;
  }

  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // audio format = PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(samples[i]!, 44 + i * bytesPerSample);
  }
  return buffer;
}

export function createAudioCaptureService({
  logger,
  captureDir,
}: {
  logger: Logger;
  /**
   * Scratch directory for staged clips (`<ADE home>/tmp/audio-captures`).
   *
   * Under the ADE home rather than the OS temp dir, and deliberately not
   * inside any sandbox: the reader is a different process, so the path has to
   * be one it can simply open.
   */
  captureDir: string;
}): AudioCaptureService {
  const stagedClips = new Set<string>();

  return {
    writeClip(pcm, options) {
      if (!pcm || pcm.length === 0) {
        throw new AudioCaptureError("empty_audio", "No audio was captured.");
      }
      const sampleRate = validateSampleRate(options?.sampleRate ?? DEFAULT_SAMPLE_RATE);
      fs.mkdirSync(captureDir, { recursive: true });
      const audioPath = path.join(captureDir, `${randomUUID()}.wav`);
      fs.writeFileSync(audioPath, pcmToWavBuffer(pcm, sampleRate), { mode: 0o600 });
      stagedClips.add(audioPath);
      const durationMs = Math.round((pcm.length / sampleRate) * 1000);
      logger.info("audio.clip_staged", { durationMs, sampleRate });
      return { audioPath, durationMs };
    },

    discardClip(audioPath) {
      // Only paths this service minted. The path crosses a process boundary to
      // reach the caller, so accepting an arbitrary one back would turn a
      // capture capability into a file-delete primitive.
      if (!stagedClips.has(audioPath)) return;
      stagedClips.delete(audioPath);
      try {
        fs.rmSync(audioPath, { force: true });
      } catch {
        // A clip we cannot remove is the startup sweep's problem instead.
      }
    },

    dispose() {
      // Staged clips are NOT deleted here. A clip already handed to a caller
      // may still be being read, and this runs on shutdown paths that a caller
      // does not participate in; the startup sweep collects what is stale.
      stagedClips.clear();
    },
  };
}
