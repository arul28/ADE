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

/**
 * Voice-to-text transcription service (desktop / Electron, v1).
 *
 * Records PCM is captured in the renderer and handed here as 16 kHz mono
 * samples over IPC. We write a self-contained WAV (no ffmpeg dependency), shell
 * out to the bundled whisper.cpp CLI against `ggml-base.en.bin`, parse the
 * transcript, then run the shared deterministic cleanup. There is NO AI polish
 * on desktop in v1 — deterministic cleanup only.
 *
 * Calls are serialized: only one whisper process runs at a time (mirroring the
 * single-flight queue style of `services/jobs/jobEngine.ts`).
 *
 * Distribution note: the whisper binary + model are shipped under the packaged
 * app's `resources/whisper/`. The release packaging + auto-updater MUST deliver
 * these to existing installs on update (see package.json `extraResources` and
 * `scripts/materialize-whisper-resources.mjs`). If they are absent at runtime we
 * return a typed `model_not_installed` error the UI surfaces as
 * "Voice model not installed".
 */

export type TranscriptionResult = {
  raw: string;
  cleaned: string;
};

export type TranscriptionStatus = {
  installed: boolean;
  /** Resolved whisper binary path, when present. */
  binaryPath: string | null;
  /** Resolved ggml model path, when present. */
  modelPath: string | null;
};

export type TranscriptionErrorCode =
  | "model_not_installed"
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

export type TranscriptionService = {
  transcribe: (pcm: Int16Array | Float32Array, options?: { sampleRate?: number }) => Promise<TranscriptionResult>;
  getStatus: () => TranscriptionStatus;
  dispose: () => void;
};

const WHISPER_BINARY_BASENAMES = ["whisper-cli", "main", "whisper"];
const WHISPER_MODEL_BASENAME = "ggml-base.en.bin";
const TARGET_SAMPLE_RATE = 16_000;

function whisperBinaryCandidates(whisperDir: string): string[] {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  return WHISPER_BINARY_BASENAMES.map((name) => path.join(whisperDir, `${name}${exeSuffix}`));
}

function firstExisting(paths: string[]): string | null {
  for (const candidate of paths) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Resolve the directory that holds the whisper binary + model.
 *   packaged: <resourcesPath>/whisper
 *   dev:      apps/desktop/resources/whisper
 */
function resolveWhisperDir(options: { isPackaged: boolean; resourcesPath?: string | null }): string {
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
 * Extract transcript text from whisper.cpp output. whisper.cpp with
 * `--output-json` writes `<wavPath>.json` containing `{ transcription: [{ text }] }`.
 * We also accept plain stdout as a fallback when JSON is unavailable.
 */
function parseWhisperJson(jsonText: string): string | null {
  try {
    const parsed = JSON.parse(jsonText) as {
      transcription?: Array<{ text?: string }>;
      text?: string;
    };
    if (Array.isArray(parsed.transcription)) {
      const joined = parsed.transcription
        .map((segment) => (typeof segment.text === "string" ? segment.text : ""))
        .join("")
        .trim();
      if (joined) return joined;
    }
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      return parsed.text.trim();
    }
  } catch {
    // not JSON
  }
  return null;
}

/** Strip whisper.cpp stdout timestamp lines down to the spoken text. */
function parseWhisperStdout(stdout: string): string {
  // Lines look like: "[00:00:00.000 --> 00:00:02.000]   hello world"
  const lines = stdout.split(/\r?\n/);
  const texts: string[] = [];
  for (const line of lines) {
    const match = line.match(/\]\s*(.*)$/);
    if (match && match[1]) {
      texts.push(match[1]);
    } else if (line.trim() && !line.includes("[") && !line.startsWith("whisper_")) {
      texts.push(line.trim());
    }
  }
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Build the whisper.cpp CLI arguments. Exported as a standalone function so the
 * flag set is unit-tested — notably that JSON output uses `-oj`. This whisper.cpp
 * build has NO `-otj` flag; passing it makes whisper write no JSON sidecar and
 * transcribe nothing (the original dictation "catches nothing" bug).
 */
export function buildWhisperArgs(modelPath: string, wavPath: string): string[] {
  return [
    "-m",
    modelPath,
    "-f",
    wavPath,
    "-l",
    "en",
    "-oj", // output transcript JSON sidecar (<wavPath>.json) — NOT -otj
    "-np", // no prints (suppress progress/system info on stdout)
  ];
}

export function createTranscriptionService({
  logger,
  isPackaged,
  resourcesPath,
  glossary,
}: {
  logger: Logger;
  isPackaged: boolean;
  resourcesPath?: string | null;
  /** Optional pre-loaded glossary (mainly for tests). */
  glossary?: PreparedGlossary;
}): TranscriptionService {
  const whisperDir = resolveWhisperDir({ isPackaged, resourcesPath });
  const tmpDir = path.join(os.tmpdir(), "ade-voice");
  const activeChildren = new Set<ReturnType<typeof spawn>>();
  const pendingTempFiles = new Set<string>();
  let disposed = false;

  // Single-flight queue: chain transcriptions so only one whisper process runs
  // at a time, like the per-lane refresh serialization in jobEngine.
  let queueTail: Promise<unknown> = Promise.resolve();

  const resolveBinary = (): string | null => firstExisting(whisperBinaryCandidates(whisperDir));
  const resolveModel = (): string | null => {
    const modelPath = path.join(whisperDir, WHISPER_MODEL_BASENAME);
    return firstExisting([modelPath]);
  };

  const getStatus = (): TranscriptionStatus => {
    const binaryPath = resolveBinary();
    const modelPath = resolveModel();
    return {
      installed: Boolean(binaryPath && modelPath),
      binaryPath,
      modelPath,
    };
  };

  const cleanupTempFile = (filePath: string) => {
    pendingTempFiles.delete(filePath);
    fs.rm(filePath, { force: true }, () => {});
    fs.rm(`${filePath}.json`, { force: true }, () => {});
  };

  const runWhisper = async (
    binaryPath: string,
    modelPath: string,
    wavPath: string,
  ): Promise<string> => {
    return await new Promise<string>((resolve, reject) => {
      const args = buildWhisperArgs(modelPath, wavPath);
      const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      activeChildren.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        activeChildren.delete(child);
        reject(new TranscriptionError("transcribe_failed", error.message));
      });
      child.on("close", (exitCode) => {
        activeChildren.delete(child);
        if (exitCode !== 0) {
          reject(
            new TranscriptionError(
              "transcribe_failed",
              `whisper exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
            ),
          );
          return;
        }
        // Prefer the JSON sidecar; fall back to stdout parsing.
        let text: string | null = null;
        try {
          const jsonText = fs.readFileSync(`${wavPath}.json`, "utf8");
          text = parseWhisperJson(jsonText);
        } catch {
          // sidecar missing; use stdout
        }
        if (text == null) {
          text = parseWhisperStdout(stdout);
        }
        resolve(text ?? "");
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
      logger.warn("transcription.model_not_installed", { whisperDir });
      throw new TranscriptionError(
        "model_not_installed",
        "Voice model not installed",
      );
    }

    const sampleRate = options?.sampleRate ?? TARGET_SAMPLE_RATE;
    fs.mkdirSync(tmpDir, { recursive: true });
    const wavPath = path.join(tmpDir, `${randomUUID()}.wav`);
    pendingTempFiles.add(wavPath);

    try {
      fs.writeFileSync(wavPath, pcmToWavBuffer(pcm, sampleRate));
      const startedAt = Date.now();
      const raw = (await runWhisper(status.binaryPath, status.modelPath, wavPath)).trim();
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

  const transcribe = (
    pcm: Int16Array | Float32Array,
    options?: { sampleRate?: number },
  ): Promise<TranscriptionResult> => {
    // Serialize: append to the queue tail so only one whisper runs at a time.
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
