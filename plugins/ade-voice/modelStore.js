// ade-voice — getting the speech model onto the machine, once.
//
// `ggml-base.en.bin` is 141 MB and is not shipped in the package: a plugin tree
// is cloned and checksummed by the installer, and putting a 141 MB blob in it
// would make every install pay for something most of the tree does not need.
// So it is fetched on first use, from the canonical whisper.cpp weights on
// Hugging Face, and the three properties that make that safe are all here:
//
//   * the body is STREAMED to `<model>.part` — never held in memory, which is
//     the exact failure that took out ADE's own updater when the model was
//     bundled instead;
//   * an interrupted download RESUMES with a Range request, and a server that
//     ignores Range simply starts the file over;
//   * the file only becomes `ggml-base.en.bin` after its sha256 matches, by
//     rename — so a partial or corrupted download can never present as a model.
//
// The digest below is Hugging Face's own `x-linked-etag` for this file, which
// is the sha256 of the LFS object, and it is the same digest ADE pinned when
// the desktop app owned this download.

"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");

const { MODEL_BASENAME, modelPathIn } = require("./engine");

const DEFAULT_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const DEFAULT_MODEL_SHA256 =
  "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
const DEFAULT_MODEL_BYTES = 147_964_211;

/** base.en is ~141 MB; anything under this is a truncation, not a model. */
const MIN_PLAUSIBLE_MODEL_BYTES = 50 * 1024 * 1024;

const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Where the model comes from, and what it must hash to.
 *
 * `ADE_VOICE_MODEL_URL` still has to name a host this plugin's manifest
 * declares under `network.hosts`. A mirror on some other host is refused by the
 * platform's network guard with a message that names the host, which is the
 * intended behaviour: the manifest is what the user approved at install.
 */
function defaultModelSource(env = process.env) {
  const url = typeof env.ADE_VOICE_MODEL_URL === "string" && env.ADE_VOICE_MODEL_URL.trim()
    ? env.ADE_VOICE_MODEL_URL.trim()
    : DEFAULT_MODEL_URL;
  const sha256 = typeof env.ADE_VOICE_MODEL_SHA256 === "string" && env.ADE_VOICE_MODEL_SHA256.trim()
    ? env.ADE_VOICE_MODEL_SHA256.trim()
    : DEFAULT_MODEL_SHA256;
  return { url, sha256, expectedBytes: DEFAULT_MODEL_BYTES };
}

/** Present and not truncated. A stat, never a hash — this runs on every call. */
function isModelInstalled(modelDir, minBytes = MIN_PLAUSIBLE_MODEL_BYTES) {
  try {
    const stat = fs.statSync(modelPathIn(modelDir));
    return stat.isFile() && stat.size >= minBytes;
  } catch {
    return false;
  }
}

function partialPathFor(modelDir) {
  return `${modelPathIn(modelDir)}.part`;
}

/** Size of the partial download on disk, or 0 when there is none. */
function partialBytes(modelDir) {
  try {
    return fs.statSync(partialPathFor(modelDir)).size;
  } catch {
    return 0;
  }
}

async function sha256OfFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/**
 * One GET, streamed to `destinationPath`, following redirects.
 *
 * `startAt > 0` asks the server to continue from there. A 206 appends; a 200
 * means the server ignored the range, so the file is rewritten from the start.
 * Resolves with the number of bytes now on disk.
 */
function streamDownload({ url, destinationPath, startAt, onProgress, redirectsRemaining, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = null;
    let request = null;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      output?.destroy();
      request?.destroy();
      const plain = new Error(plainNetworkMessage(error));
      if (error?.code) plain.code = error.code;
      reject(plain);
    };
    const onAbort = () => fail(new Error("The download was cancelled."));
    if (signal) {
      if (signal.aborted) {
        reject(new Error("The download was cancelled."));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const transport = url.startsWith("http://") ? http : https;
    const headers = startAt > 0 ? { Range: `bytes=${startAt}-` } : {};
    request = transport.get(url, { timeout: REQUEST_TIMEOUT_MS, headers }, (response) => {
      const status = response.statusCode ?? 0;

      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          fail(new Error("The download kept being redirected."));
          return;
        }
        streamDownload({
          url: new URL(response.headers.location, url).toString(),
          destinationPath,
          startAt,
          onProgress,
          redirectsRemaining: redirectsRemaining - 1,
          signal,
        }).then(resolve, fail);
        return;
      }

      if (status !== 200 && status !== 206) {
        response.resume();
        fail(new Error(`The download server answered ${status || "nothing"}.`));
        return;
      }

      // A 200 to a ranged request means the server does not do ranges: whatever
      // is on disk is not a prefix of what is arriving, so start the file over.
      const resuming = status === 206 && startAt > 0;
      const from = resuming ? startAt : 0;
      const bodyBytes = Number.parseInt(response.headers["content-length"] ?? "", 10);
      const totalBytes = Number.isFinite(bodyBytes) ? from + bodyBytes : null;

      let received = from;
      output = fs.createWriteStream(destinationPath, {
        mode: 0o644,
        flags: resuming ? "r+" : "w",
        start: resuming ? startAt : 0,
      });
      response.on("data", (chunk) => {
        received += chunk.length;
        onProgress?.({ receivedBytes: received, totalBytes });
      });
      response.once("error", fail);
      response.pipe(output);
      output.once("error", fail);
      output.once("finish", () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(received);
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => fail(new Error("The download timed out.")));
    request.once("error", fail);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Say what went wrong on the network in words.
 *
 * These messages end up inside the sentence the composer shows when the model
 * cannot be fetched, so "Error: aborted" or "getaddrinfo EAI_AGAIN" is not an
 * acceptable tail. Anything unrecognised keeps its own text — an unfamiliar
 * failure is better read than hidden.
 */
function plainNetworkMessage(error) {
  const code = error?.code ?? "";
  const text = error?.message ?? String(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "The download server could not be reached.";
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED") return "The download server did not answer.";
  if (code === "ECONNRESET" || /aborted|socket hang up|premature close/i.test(text)) {
    return "The connection dropped part-way through.";
  }
  return text;
}

/**
 * Ensure `<modelDir>/ggml-base.en.bin` exists and is the model we expect.
 *
 * Already installed is a no-op. Otherwise: resume or start the `.part`, verify
 * its digest and size, rename into place. A digest that disagrees discards the
 * partial rather than resuming it again — a corrupted prefix would otherwise
 * fail forever, one retry at a time.
 */
async function downloadModel({
  modelDir,
  source,
  onProgress,
  signal,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  minBytes = MIN_PLAUSIBLE_MODEL_BYTES,
  retryDelayMs = 2_000,
  log,
} = {}) {
  const from = source ?? defaultModelSource();
  const modelPath = modelPathIn(modelDir);
  if (isModelInstalled(modelDir, minBytes)) return { modelPath, downloaded: false };

  await fsp.mkdir(modelDir, { recursive: true });
  const partialPath = partialPathFor(modelDir);
  const attempts = maxAttempts > 0 ? maxAttempts : 1;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw new Error("The download was cancelled.");
    try {
      let startAt = 0;
      try {
        const partial = await fsp.stat(partialPath);
        // A partial at or past the expected size is not a prefix of anything.
        startAt = from.expectedBytes && partial.size >= from.expectedBytes ? 0 : partial.size;
      } catch {
        startAt = 0;
      }
      if (startAt === 0) await fsp.rm(partialPath, { force: true });

      const bytes = await streamDownload({
        url: from.url,
        destinationPath: partialPath,
        startAt,
        onProgress,
        redirectsRemaining: MAX_REDIRECTS,
        signal,
      });

      if (bytes < minBytes) {
        throw new Error(`The download stopped early (${bytes} bytes of ${from.expectedBytes ?? "?"}).`);
      }
      if (from.sha256) {
        const digest = await sha256OfFile(partialPath);
        if (digest.toLowerCase() !== from.sha256.toLowerCase()) {
          // Not resumable: the bytes on disk are wrong, not incomplete.
          await fsp.rm(partialPath, { force: true });
          throw new Error("The downloaded model did not match its checksum.");
        }
      }
      await fsp.rename(partialPath, modelPath);
      return { modelPath, downloaded: true };
    } catch (error) {
      lastError = error;
      log?.("warn", `Model download attempt ${attempt} failed: ${error?.message ?? error}`);
      if (signal?.aborted) break;
      if (attempt === attempts) break;
      await sleep(Math.min(30_000, retryDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MODEL_BYTES,
  DEFAULT_MODEL_SHA256,
  DEFAULT_MODEL_URL,
  MIN_PLAUSIBLE_MODEL_BYTES,
  MODEL_BASENAME,
  defaultModelSource,
  downloadModel,
  isModelInstalled,
  partialBytes,
  partialPathFor,
  sha256OfFile,
};
