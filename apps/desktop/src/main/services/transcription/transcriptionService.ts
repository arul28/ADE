import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logging/logger";
import { resolveBundledResource } from "./bundledResources";
import {
  cleanTranscript,
  loadGlossary,
  type PreparedGlossary,
} from "./dictationCleanup";
import {
  DEFAULT_SPEECH_MODEL_BYTES,
  type DownloadProgress,
  type SpeechModelSource,
  downloadSpeechModel,
  isSpeechModelInstalled,
  removeStaleModelFiles,
  speechModelPath,
} from "./speechModelStore";

/**
 * Voice-to-text transcription service (desktop / Electron, v1).
 *
 * Records PCM is captured in the renderer and handed here as 16 kHz mono
 * samples over IPC. We write a self-contained WAV (no ffmpeg dependency), shell
 * out to the bundled transcribe.cpp CLI against the Parakeet Ultra GGUF, read
 * the transcript, then run the shared deterministic cleanup. The model emits
 * punctuation and casing itself; there is no AI polish pass.
 *
 * Calls are serialized: only one transcribe process runs at a time (mirroring the
 * single-flight queue style of `services/jobs/jobEngine.ts`).
 *
 * Distribution note: the transcribe-cli BINARY is bundled under the packaged app's
 * `resources/whisper/` (small). The ~464 MB MODEL is NOT bundled — it is
 * downloaded once at runtime into `<userData>/whisper/` (see speechModelStore),
 * because bundling it inflated the macOS auto-update zip past Squirrel.Mac's
 * in-memory download limit and crashed the updater. If the binary is missing we
 * return `model_not_installed`; if only the model is missing the UI offers a
 * one-time download via `downloadModel`.
 */

export type TranscriptionResult = {
  raw: string;
  cleaned: string;
};

export type TranscriptionStatus = {
  /** True only when BOTH the binary and the model are present (ready to transcribe). */
  installed: boolean;
  /** Bundled transcribe-cli binary present. */
  binaryInstalled: boolean;
  /** Runtime model present (downloaded). */
  modelInstalled: boolean;
  /** A model download is currently in flight. */
  downloading: boolean;
  /** Resolved transcribe-cli binary path, when present. */
  binaryPath: string | null;
  /** Resolved GGUF model path, when present. */
  modelPath: string | null;
};

export type TranscriptionErrorCode =
  | "model_not_installed"
  | "engine_unsupported"
  | "empty_audio"
  | "transcribe_failed";

/** Typed error so the renderer can branch on `code` (surfaced via IPC message prefix). */
export class TranscriptionError extends Error {
  code: TranscriptionErrorCode;
  constructor(code: TranscriptionErrorCode, message: string) {
    super(message);
    this.name = "TranscriptionError";
    this.code = code;
  }
}

/**
 * Download progress plus the step after it. `warmup` is a silent transcription
 * that loads the fresh model once, so the user's first dictation is not the one
 * that pays for it (measured: ~28 s cold, under 2 s after).
 */
export type ModelInstallProgress = DownloadProgress & { stage?: "warmup" };

export type TranscriptionService = {
  transcribe: (pcm: Int16Array | Float32Array, options?: { sampleRate?: number }) => Promise<TranscriptionResult>;
  getStatus: () => TranscriptionStatus;
  /**
   * Download the speech model into the runtime model dir (idempotent + single-
   * flight). Resolves when the model is installed and warmed up; rejects on
   * download failure. A failed warm-up does not fail the install.
   */
  downloadModel: (onProgress?: (p: ModelInstallProgress) => void) => Promise<void>;
  dispose: () => void;
};

// Only transcribe-cli: a stale whisper-cli left in a dev resources dir cannot read
// the GGUF model, so it must never be picked up.
const TRANSCRIBE_BINARY_BASENAME = "transcribe-cli";
// More threads than physical cores slows transcribe.cpp down sharply (measured
// on a 16-core / 32-thread Ryzen: 5.5 s at 16 threads, 28 s at its default of 32).
const MAX_TRANSCRIBE_THREADS = 16;
const TARGET_SAMPLE_RATE = 16_000;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 48_000;
const DEFAULT_TRANSCRIBE_PROCESS_TIMEOUT_MS = 5 * 60_000;
const WARMUP_AUDIO_SECONDS = 0.5;

function transcribeBinaryPath(engineDir: string): string {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  return path.join(engineDir, `${TRANSCRIBE_BINARY_BASENAME}${exeSuffix}`);
}

/**
 * Approximate the physical core count. Node only reports logical CPUs, and
 * x86 desktops almost always run two hardware threads per core; on Apple
 * Silicon the heavy lifting runs on the GPU via Metal anyway.
 */
function resolveTranscribeThreads(logicalCpus = os.availableParallelism()): number {
  return Math.max(1, Math.min(MAX_TRANSCRIBE_THREADS, Math.floor(logicalCpus / 2)));
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// Windows NTSTATUS for an illegal instruction, as an unsigned 32-bit exit code.
const STATUS_ILLEGAL_INSTRUCTION = 0xc000001d;

/**
 * The binary targets AVX2 on x86-64, so an older CPU dies on its first vector
 * instruction: SIGILL on macOS/Linux, STATUS_ILLEGAL_INSTRUCTION on Windows.
 */
function isUnsupportedCpuExit(exitCode: number | null, signal: NodeJS.Signals | null): boolean {
  return signal === "SIGILL" || (exitCode != null && exitCode >>> 0 === STATUS_ILLEGAL_INSTRUCTION);
}

function resolveTranscribeProcessTimeoutMs(): number {
  const configured = Number.parseInt(process.env.ADE_SPEECH_PROCESS_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TRANSCRIBE_PROCESS_TIMEOUT_MS;
}

function validateSampleRate(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new TranscriptionError(
      "transcribe_failed",
      `Invalid audio sample rate; expected ${MIN_SAMPLE_RATE}-${MAX_SAMPLE_RATE} Hz.`,
    );
  }
  return Math.round(sampleRate);
}

/**
 * Resolve the directory that holds the transcribe-cli binary (and, in dev, a
 * locally materialized model).
 *   packaged: <resourcesPath>/whisper
 *   dev:      apps/desktop/resources/whisper
 */
function resolveEngineDir(options: { isPackaged: boolean; resourcesPath?: string | null }): string {
  return resolveBundledResource("whisper", options);
}

/**
 * Encode 16 kHz mono PCM as a 16-bit little-endian WAV. The header is written
 * by hand so there is no ffmpeg / native-codec dependency.
 */
function pcmToWavBuffer(pcm: Int16Array | Float32Array, sampleRate: number): Buffer {
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

/**
 * Fallback when the `-o` transcript file is missing: transcribe-cli prints the
 * transcript on stdout as a `text: ...` line.
 */
function parseTranscribeStdout(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("text:")) return line.slice("text:".length).trim();
  }
  return "";
}

/**
 * Build the transcribe-cli arguments. The transcript is written to `outPath`
 * as plain text; stdout carries a verbose report we only use as a fallback.
 */
function buildTranscribeArgs(
  modelPath: string,
  wavPath: string,
  outPath: string,
  threads: number,
): string[] {
  return [
    "-m",
    modelPath,
    "-l",
    "en",
    "-q", // suppress library logging
    "--timestamps",
    "none",
    "--threads",
    String(threads),
    "-o",
    outPath,
    wavPath,
  ];
}

export function createTranscriptionService({
  logger,
  isPackaged,
  resourcesPath,
  modelDir,
  modelSource,
  glossary,
}: {
  logger: Logger;
  isPackaged: boolean;
  resourcesPath?: string | null;
  /**
   * Writable runtime directory for the downloaded model (`<userData>/whisper`).
   * If omitted, falls back to the bundled `resources/whisper` dir (dev / tests).
   */
  modelDir?: string | null;
  /** Override the model download source (mainly for tests). */
  modelSource?: SpeechModelSource;
  /** Optional pre-loaded glossary (mainly for tests). */
  glossary?: PreparedGlossary;
}): TranscriptionService {
  const engineDir = resolveEngineDir({ isPackaged, resourcesPath });
  // Runtime model dir: the model is downloaded here (not bundled). Fall back to
  // the bundled engine dir so a dev/test checkout with a local model still works.
  const runtimeModelDir = modelDir?.trim() ? modelDir.trim() : engineDir;
  // Upgraded installs still hold the old ~141 MB whisper model, which the new
  // engine cannot read; drop it at startup rather than waiting for the user to
  // download the new one. Dictation stays off until the new model is present.
  // A failure (e.g. a file locked on Windows) is retried on the next launch.
  if (modelDir?.trim()) {
    for (const failure of removeStaleModelFiles(runtimeModelDir)) {
      logger.warn("transcription.stale_model_cleanup_failed", failure);
    }
  }
  const tmpDir = path.join(os.tmpdir(), "ade-voice");
  const activeChildren = new Set<ReturnType<typeof spawn>>();
  const pendingTempFiles = new Set<string>();
  let disposed = false;

  // Single-flight queue: chain transcriptions so only one transcribe process runs
  // at a time, like the per-lane refresh serialization in jobEngine.
  let queueTail: Promise<unknown> = Promise.resolve();

  let modelDownloadPromise: Promise<void> | null = null;

  const resolveBinary = (): string | null => {
    const binaryPath = transcribeBinaryPath(engineDir);
    return isFile(binaryPath) ? binaryPath : null;
  };
  const resolveModel = (): string | null => {
    // Runtime (downloaded) location first, then the bundled dir (dev fallback).
    // A truncated file does not count, so the UI offers the download again.
    if (isSpeechModelInstalled(runtimeModelDir)) return speechModelPath(runtimeModelDir);
    return isSpeechModelInstalled(engineDir) ? speechModelPath(engineDir) : null;
  };

  const getStatus = (): TranscriptionStatus => {
    const binaryPath = resolveBinary();
    const modelPath = resolveModel();
    return {
      installed: Boolean(binaryPath && modelPath),
      binaryInstalled: Boolean(binaryPath),
      modelInstalled: Boolean(modelPath),
      downloading: modelDownloadPromise != null,
      binaryPath,
      modelPath,
    };
  };

  const downloadModel = (onProgress?: (p: ModelInstallProgress) => void): Promise<void> => {
    // Join an in-flight install before checking disk: the model is on disk
    // while warm-up still runs, and a caller must not resolve ahead of it.
    if (modelDownloadPromise) return modelDownloadPromise;
    if (resolveModel()) return Promise.resolve();
    // Single-flight: concurrent callers (UI button + auto-trigger) share one download.
    const startedAt = Date.now();
    logger.info("transcription.model_download_started", { runtimeModelDir });
    modelDownloadPromise = downloadSpeechModel({
      modelDir: runtimeModelDir,
      source: modelSource,
      onProgress,
    })
      .then(async () => {
        logger.info("transcription.model_download_done", {
          durationMs: Date.now() - startedAt,
        });
        await warmUp(onProgress);
      })
      .catch((error: unknown) => {
        logger.warn("transcription.model_download_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        modelDownloadPromise = null;
      });
    return modelDownloadPromise;
  };

  const cleanupTempFile = (filePath: string) => {
    pendingTempFiles.delete(filePath);
    fs.rm(filePath, { force: true }, () => {});
    fs.rm(`${filePath}.txt`, { force: true }, () => {});
  };

  const runTranscribe = async (
    binaryPath: string,
    modelPath: string,
    wavPath: string,
  ): Promise<string> => {
    return await new Promise<string>((resolve, reject) => {
      const outPath = `${wavPath}.txt`;
      const args = buildTranscribeArgs(modelPath, wavPath, outPath, resolveTranscribeThreads());
      const child = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      activeChildren.add(child);

      const timeoutMs = resolveTranscribeProcessTimeoutMs();
      let timeoutHandle: NodeJS.Timeout | null = null;
      let settled = false;
      let stdout = "";
      let stderr = "";

      const clearChildTimeout = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      };
      const rejectOnce = (error: TranscriptionError, removeChild = true) => {
        if (settled) return;
        settled = true;
        clearChildTimeout();
        if (removeChild) activeChildren.delete(child);
        reject(error);
      };

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        rejectOnce(new TranscriptionError("transcribe_failed", error.message));
      });
      timeoutHandle = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // best-effort
        }
        const forceKillTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // best-effort
          }
        }, 1_000);
        forceKillTimer.unref?.();
        rejectOnce(
          new TranscriptionError(
            "transcribe_failed",
            `transcription timed out after ${Math.round(timeoutMs / 1000)}s`,
          ),
          false,
        );
      }, timeoutMs);
      timeoutHandle.unref?.();

      child.on("close", (exitCode, signal) => {
        clearChildTimeout();
        activeChildren.delete(child);
        if (settled) return;
        settled = true;
        if (exitCode !== 0) {
          logger.warn("transcription.process_failed", {
            exitCode,
            signal,
            stderr: stderr.slice(0, 500),
          });
          reject(
            isUnsupportedCpuExit(exitCode, signal)
              ? new TranscriptionError("engine_unsupported", "This CPU lacks AVX2, which the speech engine needs.")
              : new TranscriptionError(
                  "transcribe_failed",
                  `transcribe-cli exited with ${signal ? `signal ${signal}` : `code ${exitCode}`}: ${stderr.slice(0, 500)}`,
                ),
          );
          return;
        }
        // Prefer the transcript file; fall back to stdout parsing.
        let text: string;
        try {
          text = fs.readFileSync(outPath, "utf8").trim();
        } catch {
          text = parseTranscribeStdout(stdout);
        }
        resolve(text);
      });
    });
  };

  const transcribeNow = async (
    pcm: Int16Array | Float32Array,
    options?: { sampleRate?: number },
  ): Promise<TranscriptionResult> => {
    if (disposed) {
      throw new TranscriptionError("transcribe_failed", "Transcription service has been disposed.");
    }
    if (!pcm || pcm.length === 0) {
      throw new TranscriptionError("empty_audio", "No audio was captured.");
    }

    const status = getStatus();
    if (!status.installed || !status.binaryPath || !status.modelPath) {
      logger.warn("transcription.model_not_installed", { engineDir });
      throw new TranscriptionError(
        "model_not_installed",
        "Voice model not installed",
      );
    }

    const sampleRate = validateSampleRate(options?.sampleRate ?? TARGET_SAMPLE_RATE);
    fs.mkdirSync(tmpDir, { recursive: true });
    const wavPath = path.join(tmpDir, `${randomUUID()}.wav`);
    pendingTempFiles.add(wavPath);

    try {
      fs.writeFileSync(wavPath, pcmToWavBuffer(pcm, sampleRate));
      const startedAt = Date.now();
      const raw = (await runTranscribe(status.binaryPath, status.modelPath, wavPath)).trim();
      const preparedGlossary = glossary ?? loadGlossary({ isPackaged, resourcesPath });
      const cleaned = cleanTranscript(raw, preparedGlossary);
      logger.info("transcription.done", {
        durationMs: Date.now() - startedAt,
        rawLength: raw.length,
        cleanedLength: cleaned.length,
      });
      return { raw, cleaned };
    } finally {
      cleanupTempFile(wavPath);
    }
  };

  // Runs inside the download's single-flight promise, so `downloading` stays
  // true and the UI keeps showing setup until the model is warm.
  const warmUp = async (onProgress?: (p: ModelInstallProgress) => void): Promise<void> => {
    const totalBytes = modelSource?.expectedBytes ?? DEFAULT_SPEECH_MODEL_BYTES;
    try {
      onProgress?.({ receivedBytes: totalBytes, totalBytes, stage: "warmup" });
    } catch {
      // A progress listener must not cost the install or the warm-up.
    }
    const startedAt = Date.now();
    try {
      await transcribe(new Int16Array(Math.round(TARGET_SAMPLE_RATE * WARMUP_AUDIO_SECONDS)));
      logger.info("transcription.warmup_done", { durationMs: Date.now() - startedAt });
    } catch (error) {
      // Silence may legitimately transcribe to nothing or fail; the model is
      // installed either way, and the first real dictation just runs cold.
      logger.warn("transcription.warmup_failed", {
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const transcribe = (
    pcm: Int16Array | Float32Array,
    options?: { sampleRate?: number },
  ): Promise<TranscriptionResult> => {
    // Serialize: append to the queue tail so only one transcribe-cli runs at a time.
    const run = queueTail.then(
      () => transcribeNow(pcm, options),
      () => transcribeNow(pcm, options),
    );
    // Keep the tail resolved (never rejected) so a failed call doesn't poison the queue.
    queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    transcribe,
    getStatus,
    downloadModel,
    dispose() {
      disposed = true;
      for (const child of activeChildren) {
        try {
          child.kill();
        } catch {
          // best-effort
        }
      }
      activeChildren.clear();
      for (const filePath of pendingTempFiles) {
        cleanupTempFile(filePath);
      }
      pendingTempFiles.clear();
    },
  };
}
