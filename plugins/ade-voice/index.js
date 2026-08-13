// ade-voice — dictation in the composer, built out of public parts only.
//
// This package is what it looks like when voice is not special. The microphone
// in the composer is a `composer-action` socket contribution any plugin may
// declare; the recording comes from `ade.audio.captureClip`, the same SDK call
// any plugin may make; the words go back through the `{composer:{insertText}}`
// response verb any action may return. There is no builtin surface binding, no
// official-only capability, and nothing here a community author could not
// write. That is the point of it as much as the dictation is.
//
// What the package owns is the engine: the whisper.cpp binary in `bin/`, the
// 141 MB model it downloads on first use, the subprocess, and the glossary that
// turns a raw transcript into the sentence the user meant.
//
// Four shapes worth knowing before reading further:
//
//   1. Readiness is checked BEFORE the microphone opens. A first-run machine is
//      told to wait while it still has its silence, rather than after it has
//      spoken a paragraph into a plugin that cannot transcribe it.
//   2. No action ever waits for the model download. The model is 141 MB and a
//      host round-trip is minutes at most, so `dictate` and `transcribe` start
//      the download and say so; `status` is the machine-readable view a
//      progress UI polls.
//   3. Two process budgets, because the host gives two: 55s under `transcribe`'s
//      60s invoke cap, and 4 minutes under the composer socket's 15.
//   4. Nothing is written to a synced collection. The model is a file, the
//      state is a panel, and neither belongs on the wire.

"use strict";

const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  VoiceError,
  audioProblem,
  binaryPathFor,
  buildWhisperArgs,
  captureFailure,
  captureUnavailableError,
  classifyWhisperFailure,
  noSpeechError,
  finishTranscript,
  formatProgress,
  modelPathIn,
  modelPreparingError,
  parseWhisperJson,
  parseWhisperStdout,
  resolveModelDir,
  unsupportedPlatformError,
} = require("./engine");
const { loadBundledGlossary } = require("./glossary");
const {
  defaultModelSource,
  downloadModel,
  isModelInstalled,
  partialBytes,
} = require("./modelStore");
const { buildPanelSchema } = require("./panel");
const { runDictate } = require("./dictateFlow");

/**
 * Two process budgets, because the host gives this plugin two.
 *
 * A plain `invoke` of `transcribe` is capped at 60s, so whisper is killed at
 * 55s and the kill is ours rather than a promise the host abandoned. A
 * `composer-action` gets 15 minutes (the socket shows the user it is working,
 * so the platform lets it run), and `dictate` spends that budget deliberately:
 * at most 10 minutes recording plus 4 minutes transcribing leaves a minute of
 * headroom, and neither half can eat the other's share.
 */
const DEFAULT_PROCESS_TIMEOUT_MS = 55_000;
const DICTATE_PROCESS_TIMEOUT_MS = 4 * 60_000;
const MAX_CLIP_MS = 10 * 60_000;
/** Grace between SIGTERM and SIGKILL for a whisper that will not leave. */
const KILL_GRACE_MS = 1_000;
/** Attempts to publish the panel before giving up until the next restart. */
const PUBLISH_ATTEMPTS = 5;
const PUBLISH_RETRY_MS = 3_000;
/** How often a download logs a progress line. Once per 10 MB, not per chunk. */
const PROGRESS_LOG_BYTES = 10 * 1024 * 1024;

const pluginRoot = process.env.ADE_PLUGIN_ROOT?.trim() || __dirname;
const modelDir = resolveModelDir({
  env: process.env,
  platform: process.platform,
  homedir: os.homedir(),
});
const tmpDir = path.join(os.tmpdir(), "ade-voice-plugin");

let sdk = null;
let disposed = false;

/** Live whisper processes, so `deactivate` can take every one of them with it. */
const activeChildren = new Set();
/** Temp sidecars in flight, cleaned on the way out even if a call threw. */
const pendingTempFiles = new Set();

/** Single-flight: one whisper at a time, and one download at a time. */
let queueTail = Promise.resolve();
let downloadPromise = null;
let downloadController = null;
let downloadState = { receivedBytes: 0, totalBytes: null, failure: null };

function log(level, message, fields) {
  sdk?.log(level, message, fields);
}

function processTimeoutMs(fallback = DEFAULT_PROCESS_TIMEOUT_MS) {
  const configured = Number.parseInt(process.env.ADE_VOICE_PROCESS_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Everything the plugin knows about its own readiness, in one object.
 *
 * Cheap on purpose — two stats and no hashing — because `transcribe`, `status`
 * and the panel all ask for it and none of them should pay for the answer.
 */
function currentStatus() {
  const binaryPath = binaryPathFor(pluginRoot, process.platform);
  const platformSupported = binaryPath != null;
  let engineInstalled = false;
  if (binaryPath) {
    try {
      engineInstalled = fs.statSync(binaryPath).isFile();
    } catch {
      engineInstalled = false;
    }
  }
  const modelInstalled = isModelInstalled(modelDir);
  const downloading = downloadPromise != null;
  const progress = downloading
    ? formatProgress(downloadState.receivedBytes, downloadState.totalBytes ?? defaultModelSource().expectedBytes)
    : null;
  return {
    ready: platformSupported && engineInstalled && modelInstalled,
    platformSupported,
    engineInstalled,
    modelInstalled,
    downloading,
    progress,
    receivedBytes: downloadState.receivedBytes,
    totalBytes: downloadState.totalBytes,
    lastDownloadError: downloadState.failure,
    platform: process.platform,
    modelDir,
    modelPath: modelInstalled ? modelPathIn(modelDir) : null,
    binaryPath: engineInstalled ? binaryPath : null,
  };
}

/**
 * Publish the state panel, retrying while no project is attached.
 *
 * Panel writes are project-scoped and the plugin host is machine-scoped, so at
 * cold start this can run before any project is open. Letting it throw out of
 * `activate` would read as a crash and start the restart backoff.
 */
async function publishPanel(attempt = 1) {
  if (!sdk || disposed) return;
  try {
    await sdk.panels.update("main", buildPanelSchema(currentStatus()));
  } catch (error) {
    if (attempt >= PUBLISH_ATTEMPTS) {
      log("warn", `Could not publish the voice panel: ${error?.message ?? error}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_RETRY_MS));
    await publishPanel(attempt + 1);
  }
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * Start the download, or join the one already running.
 *
 * Returns the promise so `prepare` can choose not to await it. Callers that do
 * await it are accepting a wait measured in minutes, which is why no action
 * does.
 */
function startModelDownload() {
  if (downloadPromise) return downloadPromise;
  if (isModelInstalled(modelDir)) return Promise.resolve();

  const source = defaultModelSource();
  downloadController = new AbortController();
  downloadState = { receivedBytes: partialBytes(modelDir), totalBytes: source.expectedBytes, failure: null };
  let loggedAt = 0;
  const startedAt = Date.now();
  log("info", "Downloading the speech model (141 MB, one time).", { modelDir });

  downloadPromise = downloadModel({
    modelDir,
    source,
    signal: downloadController.signal,
    log,
    onProgress: ({ receivedBytes, totalBytes }) => {
      downloadState.receivedBytes = receivedBytes;
      if (totalBytes) downloadState.totalBytes = totalBytes;
      if (receivedBytes - loggedAt >= PROGRESS_LOG_BYTES) {
        loggedAt = receivedBytes;
        log("info", `Speech model ${formatProgress(receivedBytes, downloadState.totalBytes) ?? "downloading"}.`);
      }
    },
  })
    .then((result) => {
      log("info", "The speech model is ready.", {
        durationMs: Date.now() - startedAt,
        downloaded: result.downloaded,
      });
      downloadState.failure = null;
    })
    .catch((error) => {
      downloadState.failure = error?.message ?? String(error);
      log("warn", `The speech model could not be downloaded: ${downloadState.failure}`);
      throw error;
    })
    .finally(() => {
      downloadPromise = null;
      downloadController = null;
      void publishPanel();
    });

  // The rejection is delivered to whoever awaits the returned promise; nobody
  // has to, so absorb it here to keep an unhandled rejection from killing the
  // child (the bootstrap treats one as fatal).
  downloadPromise.catch(() => {});
  void publishPanel();
  return downloadPromise;
}

/**
 * The model, or the reason there isn't one — as a throw, never a wait.
 *
 * A missing model starts the download and reports it. A download that failed
 * on its last attempt says that instead, so "no internet" never masquerades as
 * "still downloading" forever.
 */
function requireModel() {
  if (isModelInstalled(modelDir)) return modelPathIn(modelDir);
  const failure = downloadState.failure;
  startModelDownload();
  if (failure) {
    throw new VoiceError(
      "voice_model_download_failed",
      `The speech model could not be downloaded (${failure}) Check the internet connection and try again.`,
    );
  }
  throw modelPreparingError(
    formatProgress(downloadState.receivedBytes, downloadState.totalBytes ?? defaultModelSource().expectedBytes),
  );
}

/** The engine binary, or the reason this machine has none. */
function requireBinary() {
  const binaryPath = binaryPathFor(pluginRoot, process.platform);
  if (!binaryPath) throw unsupportedPlatformError(process.platform);
  try {
    if (!fs.statSync(binaryPath).isFile()) throw new Error("not a file");
  } catch {
    throw new VoiceError(
      "voice_engine_missing",
      "The speech engine is missing from this plugin. Reinstalling Voice from the Marketplace will put it back.",
    );
  }
  return binaryPath;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function cleanupTemp(outputBase) {
  pendingTempFiles.delete(outputBase);
  fs.rm(`${outputBase}.json`, { force: true }, () => {});
}

/**
 * Run whisper once and return its raw transcript.
 *
 * Every exit path removes the child from `activeChildren` and clears the timer,
 * so a failed run leaves nothing behind to kill later.
 */
function runWhisper({ binaryPath, args, outputBase, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(new VoiceError("voice_engine_failed", `The speech engine could not start (${error?.message ?? error}).`));
      return;
    }
    activeChildren.add(child);

    const budgetMs = timeoutMs ?? processTimeoutMs();
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      fn(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      const hard = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // best effort
        }
      }, KILL_GRACE_MS);
      hard.unref?.();
      finish(reject, new VoiceError(
        "voice_timeout",
        `That recording took longer than ${Math.round(budgetMs / 1000)} seconds to transcribe, so it was stopped. A shorter recording will work.`,
      ));
    }, budgetMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(reject, new VoiceError("voice_engine_failed", `The speech engine could not start (${error.message}).`));
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      if (exitCode !== 0) {
        const failure = classifyWhisperFailure(exitCode, stderr);
        // A model that will not load is a file to throw away, not a state to
        // sit in: dropping it here is what makes the next attempt re-download.
        if (failure.code === "voice_model_damaged") {
          fs.rm(modelPathIn(modelDir), { force: true }, () => {});
        }
        finish(reject, failure);
        return;
      }
      let text = null;
      try {
        text = parseWhisperJson(fs.readFileSync(`${outputBase}.json`, "utf8"));
      } catch {
        // sidecar missing — fall back to stdout
      }
      finish(resolve, text ?? parseWhisperStdout(stdout));
    });
  });
}

async function transcribeNow({ audioPath, language, glossary, timeoutMs }) {
  if (disposed) {
    throw new VoiceError("voice_engine_failed", "Voice dictation was switched off while that recording was waiting.");
  }
  if (typeof audioPath !== "string" || !audioPath.trim()) {
    throw new VoiceError("voice_bad_request", "There was no recording to transcribe.");
  }
  const resolvedAudio = path.resolve(audioPath.trim());

  const binaryPath = requireBinary();

  let audioStat = null;
  try {
    const stat = fs.statSync(resolvedAudio);
    audioStat = { isFile: stat.isFile(), size: stat.size };
  } catch {
    audioStat = null;
  }
  const audioFailure = audioProblem(audioStat);
  if (audioFailure) throw audioFailure;

  const modelPath = requireModel();

  await fsp.mkdir(tmpDir, { recursive: true });
  const outputBase = path.join(tmpDir, randomUUID());
  pendingTempFiles.add(outputBase);
  const startedAt = Date.now();
  const bundled = loadBundledGlossary(pluginRoot);
  try {
    const raw = await runWhisper({
      binaryPath,
      outputBase,
      timeoutMs,
      args: buildWhisperArgs({ modelPath, audioPath: resolvedAudio, outputBase, language, glossary, bundled }),
    });
    const text = finishTranscript(raw, glossary, bundled);
    log("info", "Transcribed a recording.", { durationMs: Date.now() - startedAt, characters: text.length });
    return { text };
  } finally {
    cleanupTemp(outputBase);
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record a clip through the host, and translate its refusals into sentences.
 *
 * `ade.audio.captureClip` is newer than `PLUGIN_SDK_VERSION` 0, and the SDK is
 * additive rather than versioned per method — so the honest check is whether
 * the method is there, not what number the host announced. An older ADE gets a
 * sentence naming the fix instead of `undefined is not a function`.
 *
 * Returns null when the user cancelled: that is not a failure, and the caller
 * turns it into a silent no-op rather than an error the composer would show.
 */
async function captureClip(maxDurationMs) {
  if (typeof sdk?.audio?.captureClip !== "function") throw captureUnavailableError();
  try {
    return await sdk.audio.captureClip({ maxDurationMs });
  } catch (error) {
    if (error?.code === "audio_capture_cancelled") return null;
    throw captureFailure(error);
  }
}

/**
 * Delete a clip the plugin has finished with.
 *
 * Only inside the system temp directory: the host made the file and owns where
 * it lives, but this package told the user their voice is deleted after it is
 * transcribed, and keeping that promise for the ordinary case is worth more
 * than the tidiness of never touching a file it did not create. A clip
 * somewhere else is left alone and said so in the log.
 *
 * The prefix compare folds case on Windows and macOS, whose filesystems resolve
 * paths case-insensitively: a future engine handing back `C:\TEMP\...` where
 * `os.tmpdir()` reports `C:\Temp` would otherwise fall through to the
 * "outside the temporary directory" branch and silently keep the recording.
 */
async function discardClip(clipPath) {
  if (typeof clipPath !== "string" || !clipPath) return;
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const fold = (value) => (caseInsensitive ? value.toLowerCase() : value);
  const resolved = path.resolve(clipPath);
  if (!fold(resolved).startsWith(fold(`${path.resolve(os.tmpdir())}${path.sep}`))) {
    log("debug", "Left the recording in place: it is outside the temporary directory.");
    return;
  }
  // Awaited rather than fired and forgotten: the action resolving is what the
  // user sees as "done with my voice", and a promise that outlives it would
  // make the package's own privacy sentence true only eventually.
  await fsp.rm(resolved, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

exports.activate = async (ade) => {
  sdk = ade;
  disposed = false;
  const status = currentStatus();
  if (!status.platformSupported) {
    log("warn", `This package ships no speech engine for ${process.platform}; transcription will refuse here.`);
  } else if (!status.modelInstalled) {
    // Deliberately NOT downloaded here. 141 MB the moment a plugin is installed
    // is someone else's connection spent on a feature they have not used yet;
    // the first dictation starts it, and the panel offers the button.
    log("info", "The speech model is not downloaded yet; the first dictation will fetch it.", { modelDir });
  }
  await publishPanel();
};

exports.deactivate = async () => {
  disposed = true;
  try {
    downloadController?.abort();
  } catch {
    // best effort
  }
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // best effort
    }
  }
  activeChildren.clear();
  for (const outputBase of [...pendingTempFiles]) cleanupTemp(outputBase);
  sdk = null;
};

exports.actions = {
  /**
   * The composer's microphone: record, transcribe, hand the words back.
   *
   * Order matters more than it looks. Readiness is checked BEFORE the
   * microphone opens, so a machine with no model never records something it
   * cannot transcribe and throws the recording away — the user is told to wait
   * while nothing of theirs is lost. After that the shape is linear: capture,
   * transcribe, return the composer verb.
   *
   * Three endings are deliberately not errors. A cancelled recording returns
   * quietly, because the user cancelling is the user getting what they asked
   * for. A clip with no words in it says so, because silence and failure feel
   * identical otherwise. And the text is INSERTED at the caret rather than
   * replacing the draft — dictating into half a sentence is the normal case.
   */
  async dictate(args) {
    return runDictate({
      ensureReady: () => {
        requireBinary();
        requireModel();
      },
      capture: () => captureClip(MAX_CLIP_MS),
      transcribe: (audioPath) => {
        const request = {
          audioPath,
          language: args?.language,
          glossary: args?.glossary,
          timeoutMs: processTimeoutMs(DICTATE_PROCESS_TIMEOUT_MS),
        };
        // Serialized behind the same queue as `transcribe`: whisper is
        // CPU-bound, and the tail is kept resolved so one failure cannot
        // poison the calls behind it.
        const run = queueTail.then(() => transcribeNow(request), () => transcribeNow(request));
        queueTail = run.then(() => undefined, () => undefined);
        return run;
      },
      discard: (audioPath) => discardClip(audioPath),
      onCancelled: () => log("debug", "The recording was cancelled."),
    });
  },

  /**
   * Turn a recording into text.
   *
   * `{audioPath, language?, glossary?}` in, `{text}` out. Serialized behind a
   * single-flight queue: whisper is CPU-bound and two at once is slower than
   * two in a row. The queue tail is kept resolved so a failed call cannot
   * poison the calls behind it.
   */
  async transcribe(args) {
    const request = {
      audioPath: args?.audioPath,
      language: args?.language,
      glossary: args?.glossary,
    };
    const run = queueTail.then(() => transcribeNow(request), () => transcribeNow(request));
    queueTail = run.then(() => undefined, () => undefined);
    return run;
  },

  /** Machine-readable readiness — what a progress UI should poll. */
  async status() {
    return currentStatus();
  },

  /** Redraw the panel. What the panel's own "Check again" button dispatches. */
  async refresh() {
    await publishPanel();
    return currentStatus();
  },

  /**
   * Start the model download without waiting for it.
   *
   * Returns immediately by design: the host fails an invoke at 60s and this
   * takes minutes. Poll `status` for the rest.
   */
  async prepare() {
    const status = currentStatus();
    if (!status.platformSupported) throw unsupportedPlatformError(process.platform);
    if (status.modelInstalled) return { ready: true, downloading: false };
    startModelDownload();
    return { ready: false, downloading: true };
  },
};
