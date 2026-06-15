import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

/**
 * Runtime store for the whisper.cpp speech model (`ggml-base.en.bin`).
 *
 * The ~141 MB model is NO LONGER bundled in the app (it inflated the macOS
 * auto-update zip past what Squirrel.Mac's in-memory download path tolerates and
 * crashed the updater). Instead it is hosted on a dedicated GitHub release asset
 * and downloaded once, on first dictation, into a writable runtime directory
 * (`<userData>/whisper/`). The tiny `whisper-cli` binary stays bundled.
 *
 * The download STREAMS to disk (never buffers the whole file in memory — that is
 * exactly the failure mode we are moving away from), verifies sha256 against a
 * pinned digest, and installs atomically via rename so a partial/aborted download
 * can never present as a valid model.
 */

export const WHISPER_MODEL_BASENAME = "ggml-base.en.bin";

/** Pinned model asset. Overridable via env for tests / mirrors. */
export const DEFAULT_WHISPER_MODEL_URL =
  "https://github.com/arul28/ADE/releases/download/whisper-models-v1/ggml-base.en.bin";
export const DEFAULT_WHISPER_MODEL_SHA256 =
  "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
export const DEFAULT_WHISPER_MODEL_BYTES = 147_964_211;
const MIN_PLAUSIBLE_MODEL_BYTES = 50 * 1024 * 1024; // base.en is ~141 MB; guard truncation.

const maxDownloadRedirects = 10;
const downloadTimeoutMs = 120_000;

export type WhisperModelSource = {
  url: string;
  sha256: string;
  /** Expected byte size, used only for progress reporting (best effort). */
  expectedBytes?: number;
};

export function defaultWhisperModelSource(): WhisperModelSource {
  return {
    url: process.env.ADE_WHISPER_MODEL_URL?.trim() || DEFAULT_WHISPER_MODEL_URL,
    sha256: process.env.ADE_WHISPER_MODEL_SHA256?.trim() || DEFAULT_WHISPER_MODEL_SHA256,
    expectedBytes: DEFAULT_WHISPER_MODEL_BYTES,
  };
}

export function whisperModelPath(modelDir: string): string {
  return path.join(modelDir, WHISPER_MODEL_BASENAME);
}

/** Present + non-truncated on disk (cheap stat check, no hashing). */
export function isWhisperModelInstalled(modelDir: string, minBytes = MIN_PLAUSIBLE_MODEL_BYTES): boolean {
  try {
    const stat = fs.statSync(whisperModelPath(modelDir));
    return stat.isFile() && stat.size >= minBytes;
  } catch {
    return false;
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

export type DownloadProgress = {
  receivedBytes: number;
  totalBytes: number | null;
};

/**
 * Stream `url` to `destinationPath` (single attempt; follows redirects). The
 * response body is piped straight to a file — it is never accumulated in memory.
 */
function streamDownload(
  url: string,
  destinationPath: string,
  onProgress: ((p: DownloadProgress) => void) | undefined,
  redirectsRemaining: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let output: fs.WriteStream | null = null;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      output?.destroy();
      reject(error);
    };

    const transport = url.startsWith("http://") ? http : https;
    const request = transport.get(url, { timeout: downloadTimeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          fail(new Error("Too many redirects downloading whisper model"));
          return;
        }
        const next = new URL(response.headers.location, url).toString();
        streamDownload(next, destinationPath, onProgress, redirectsRemaining - 1).then(resolve, fail);
        return;
      }
      if (status !== 200) {
        response.resume();
        fail(new Error(`HTTP ${status || "unknown"} downloading whisper model`));
        return;
      }

      const totalBytes = Number.parseInt(response.headers["content-length"] ?? "", 10);
      let received = 0;
      output = createWriteStream(destinationPath, { mode: 0o644 });
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        onProgress?.({ receivedBytes: received, totalBytes: Number.isFinite(totalBytes) ? totalBytes : null });
      });
      response.once("error", fail);
      response.pipe(output);
      output.once("error", fail);
      output.once("finish", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
    request.setTimeout(downloadTimeoutMs, () => {
      fail(new Error("Timed out downloading whisper model"));
    });
    request.once("error", fail);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type DownloadWhisperModelResult = { modelPath: string };

/**
 * Ensure the model is installed at `<modelDir>/ggml-base.en.bin`. If already
 * present (and non-truncated) this is a no-op. Otherwise download with bounded
 * retry, verify sha256, and install atomically. Concurrent callers are NOT
 * deduped here — the caller (transcription service) serializes via a single
 * in-flight promise.
 */
export async function downloadWhisperModel(args: {
  modelDir: string;
  source?: WhisperModelSource;
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  maxAttempts?: number;
  /** Minimum plausible model size (truncation guard); overridable for tests. */
  minBytes?: number;
}): Promise<DownloadWhisperModelResult> {
  const source = args.source ?? defaultWhisperModelSource();
  const minBytes = args.minBytes ?? MIN_PLAUSIBLE_MODEL_BYTES;
  const modelPath = whisperModelPath(args.modelDir);
  if (isWhisperModelInstalled(args.modelDir, minBytes)) {
    return { modelPath };
  }

  await fsp.mkdir(args.modelDir, { recursive: true });
  const maxAttempts = args.maxAttempts && args.maxAttempts > 0 ? args.maxAttempts : 4;
  const partialPath = `${modelPath}.part`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (args.signal?.aborted) throw new Error("Whisper model download cancelled");
    await fsp.rm(partialPath, { force: true });
    try {
      await streamDownload(source.url, partialPath, args.onProgress, maxDownloadRedirects);
      const digest = await sha256OfFile(partialPath);
      if (source.sha256 && digest.toLowerCase() !== source.sha256.toLowerCase()) {
        throw new Error(`Whisper model checksum mismatch (got ${digest})`);
      }
      const stat = await fsp.stat(partialPath);
      if (stat.size < minBytes) {
        throw new Error(`Whisper model looks truncated (${stat.size} bytes)`);
      }
      await fsp.rename(partialPath, modelPath);
      return { modelPath };
    } catch (error) {
      lastError = error;
      await fsp.rm(partialPath, { force: true });
      if (attempt === maxAttempts) break;
      await sleep(Math.min(30_000, 2_000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
