// ade-voice — the parts that are decisions rather than I/O.
//
// Everything here is a pure function of its arguments: which binary this
// machine can run, where the model lives, what arguments whisper.cpp gets, how
// its output becomes a sentence, and which sentence the user reads when
// something is missing. `index.js` does the spawning and the file handling and
// calls into this; the tests call into this and never spawn anything.

"use strict";

const path = require("node:path");

const { EMPTY_GLOSSARY, cleanTranscript, wholePhraseRegExp } = require("./glossary");

/**
 * Errors the user sees.
 *
 * The wire drops the code. `toPluginStructuralError` in the host only preserves
 * `code` for its own `PluginSdkError`, which a plugin cannot construct — every
 * other thrown Error arrives at the caller as `internal_error` with the message
 * intact. So the message IS the taxonomy as far as the composer is concerned,
 * and it has to read like something a person wrote. The `code` still rides on
 * the object for the plugin's own logs and for the tests, and callers that need
 * to branch should call the `status` action instead of parsing prose.
 */
class VoiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
  }
}

/** Every code this plugin can fail with, so the taxonomy is enumerable. */
const VOICE_ERROR_CODES = [
  "voice_unsupported_platform",
  "voice_engine_missing",
  "voice_engine_failed",
  "voice_model_preparing",
  "voice_model_download_failed",
  "voice_model_damaged",
  "voice_audio_missing",
  "voice_audio_empty",
  "voice_bad_request",
  "voice_timeout",
  "voice_no_speech",
  "voice_capture_busy",
  "voice_capture_unavailable",
];

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/**
 * The speech engines this package ships, by platform.
 *
 * One entry, and the value is deliberately not spelled `-arm64`: the binary is
 * a universal Mach-O (x86_64 + arm64) linking nothing but libSystem, Accelerate
 * and libc++, so it runs on every Mac ADE runs on and the architecture never
 * enters the decision. Adding Linux or Windows later is a new file plus a line
 * here, and nothing else in the plugin changes.
 */
const BINARY_BY_PLATFORM = {
  darwin: "whisper-cli-darwin-universal",
};

/** Human name for a platform, for the sentence that says we don't have one. */
const PLATFORM_NAMES = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/** The binary filename for this machine, or null if the package ships none. */
function binaryFileNameFor(platform) {
  return BINARY_BY_PLATFORM[platform] ?? null;
}

/** Absolute path to the engine for this machine, or null. */
function binaryPathFor(pluginRoot, platform) {
  const fileName = binaryFileNameFor(platform);
  return fileName ? path.join(pluginRoot, "bin", fileName) : null;
}

function platformName(platform) {
  return PLATFORM_NAMES[platform] ?? platform;
}

function unsupportedPlatformError(platform) {
  return new VoiceError(
    "voice_unsupported_platform",
    `Voice transcription needs a speech engine built for ${platformName(platform)}, and this version ships one for macOS only.`,
  );
}

// ---------------------------------------------------------------------------
// Where the model lives
// ---------------------------------------------------------------------------

const MODEL_BASENAME = "ggml-base.en.bin";

/**
 * The writable directory this plugin keeps the speech model in.
 *
 * The child process is handed `ADE_PLUGIN_ID` and `ADE_PLUGIN_ROOT` and nothing
 * else — there is no data directory in the SDK and no `ade.paths` — so the
 * plugin picks its own. It is deliberately NOT the install directory: that is
 * replaced wholesale on update, and a 141 MB download that evaporates on every
 * version bump is a bug the user pays for on their own connection.
 *
 * On macOS this is byte-for-byte the path the desktop app used before voice was
 * extracted (`<userData>/whisper`), which is the whole point: a machine that
 * already dictated has the model, and installing this plugin downloads nothing.
 */
function resolveModelDir({ env = {}, platform = process.platform, homedir = "" } = {}) {
  const override = typeof env.ADE_VOICE_MODEL_DIR === "string" ? env.ADE_VOICE_MODEL_DIR.trim() : "";
  if (override) return override;
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "ADE", "whisper");
  }
  if (platform === "win32") {
    const appData = typeof env.APPDATA === "string" && env.APPDATA.trim()
      ? env.APPDATA.trim()
      : path.join(homedir, "AppData", "Roaming");
    return path.join(appData, "ADE", "whisper");
  }
  const dataHome = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME.trim()
    : path.join(homedir, ".local", "share");
  return path.join(dataHome, "ADE", "whisper");
}

function modelPathIn(modelDir) {
  return path.join(modelDir, MODEL_BASENAME);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** Terms past this are dropped: whisper caps the prompt at n_text_ctx/2 tokens. */
const MAX_GLOSSARY_TERMS = 48;
const MAX_PROMPT_CHARS = 700;

/**
 * Normalise a caller's language to something whisper accepts.
 *
 * `en-US` becomes `en`, `auto` passes through, anything that is not a language
 * tag is a bad request rather than a flag we hand to a subprocess unexamined.
 */
function normalizeLanguage(language) {
  if (language == null || language === "") return "en";
  if (typeof language !== "string") {
    throw new VoiceError("voice_bad_request", "That language is not one this plugin understands.");
  }
  const trimmed = language.trim().toLowerCase();
  if (trimmed === "auto") return "auto";
  const match = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*$/.exec(trimmed);
  if (!match) {
    throw new VoiceError("voice_bad_request", `"${language}" is not a language this plugin understands.`);
  }
  return match[1];
}

/** Glossary terms, cleaned: strings only, trimmed, de-duplicated, bounded. */
function normalizeGlossary(glossary) {
  if (glossary == null) return [];
  if (!Array.isArray(glossary)) {
    throw new VoiceError("voice_bad_request", "The glossary has to be a list of words.");
  }
  const seen = new Set();
  const terms = [];
  for (const raw of glossary) {
    if (typeof raw !== "string") continue;
    const term = raw.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= MAX_GLOSSARY_TERMS) break;
  }
  return terms;
}

/**
 * The terms that go to the decoder, caller's first.
 *
 * The caller knows what this particular recording is about; the packaged
 * glossary knows what ADE users say in general. Both are worth biasing toward,
 * and when the budget cannot hold both the specific list wins — which is why
 * the caller's terms lead and the packaged ones fill what is left.
 */
function promptTerms(callerGlossary, bundled = EMPTY_GLOSSARY) {
  return normalizeGlossary([...normalizeGlossary(callerGlossary), ...bundled.contextualTerms]);
}

/**
 * The initial prompt built from those terms.
 *
 * whisper.cpp has no contextual-strings API; `--prompt` is the one place a
 * decoder bias can be expressed, and a comma list of proper nouns is what it
 * responds to. Returns null when there is nothing to bias with, so the flag is
 * omitted rather than passed empty.
 */
function promptFromGlossary(terms) {
  if (!terms.length) return null;
  let prompt = "";
  for (const term of terms) {
    const next = prompt ? `${prompt}, ${term}` : term;
    if (next.length > MAX_PROMPT_CHARS) break;
    prompt = next;
  }
  return prompt ? `${prompt}.` : null;
}

/**
 * whisper.cpp's argument list.
 *
 * `-oj` and not `-otj`: this build has no `-otj`, and passing it makes whisper
 * write no JSON sidecar and transcribe nothing — the original "dictation
 * catches nothing" bug, kept alive here as a test.
 *
 * `-of` points the sidecar at our own temp base rather than letting whisper
 * write `<audioPath>.json` next to the caller's recording, so the plugin never
 * needs write permission in a directory it was only handed a file from.
 */
function buildWhisperArgs({ modelPath, audioPath, outputBase, language, glossary, bundled }) {
  const args = [
    "-m", modelPath,
    "-f", audioPath,
    "-l", normalizeLanguage(language),
    "-oj",
    "-np",
  ];
  if (outputBase) args.push("-of", outputBase);
  const prompt = promptFromGlossary(promptTerms(glossary, bundled ?? EMPTY_GLOSSARY));
  if (prompt) args.push("--prompt", prompt);
  return args;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Pull the transcript out of whisper's JSON sidecar.
 * `{ transcription: [{ text }] }` is the shape; `{ text }` is accepted too.
 */
function parseWhisperJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (parsed && Array.isArray(parsed.transcription)) {
    const joined = parsed.transcription
      .map((segment) => (segment && typeof segment.text === "string" ? segment.text : ""))
      .join("")
      .trim();
    if (joined) return joined;
  }
  if (parsed && typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.trim();
  return null;
}

/** Fallback: strip the `[00:00:00.000 --> …]` prefixes off stdout. */
function parseWhisperStdout(stdout) {
  const texts = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const match = line.match(/\]\s*(.*)$/);
    if (match && match[1]) {
      texts.push(match[1]);
    } else if (line.trim() && !line.includes("[") && !line.startsWith("whisper_")) {
      texts.push(line.trim());
    }
  }
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

/** Sound-event markers whisper emits for silence and noise. Never speech. */
const NON_SPEECH_MARKER = /\[[A-Z_ ]{2,}\]/g;

/**
 * Restore the caller's spelling of its own vocabulary.
 *
 * The glossary biases the decoder through `--prompt`, but whisper still returns
 * its own casing ("swiftui", "cr sqlite"), and the one thing a term list states
 * unambiguously is how each term is written. So every whole-word occurrence is
 * rewritten to the caller's spelling, longest term first so a multi-word phrase
 * wins over its own prefix. Word boundaries use lookarounds rather than `\b` so
 * terms with punctuation in them ("cr-sqlite") still match.
 */
function applyGlossaryCasing(text, terms) {
  let out = text;
  const ordered = [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const term of ordered) {
    out = out.replace(wholePhraseRegExp(term), (_full, lead) => `${lead}${term}`);
  }
  return out;
}

/** Whitespace and punctuation tidying. Deliberately does not touch casing. */
function tidyTranscript(text) {
  return String(text ?? "")
    .replace(NON_SPEECH_MARKER, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The whole output pass, in the order each step needs the last one's work.
 *
 *   1. whisper's own sound-event markers out — they are not words anyone said;
 *   2. the packaged glossary's deterministic cleanup (fillers, corrections,
 *      sentence case), which is the pass the desktop app ran before this plugin
 *      existed and which iOS still runs on its own transcripts;
 *   3. the caller's own vocabulary spelled the way the caller spells it, last,
 *      so a correction from step 2 cannot undo it.
 */
function finishTranscript(raw, glossary, bundled = EMPTY_GLOSSARY) {
  const terms = normalizeGlossary(glossary);
  const marked = tidyTranscript(raw);
  if (!marked) return "";
  const cleaned = cleanTranscript(marked, bundled);
  if (!cleaned) return "";
  return terms.length ? tidyTranscript(applyGlossaryCasing(cleaned, terms)) : cleaned;
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/** stderr fragments whisper.cpp prints when the model file will not load. */
const MODEL_LOAD_FAILURE = /failed to load model|invalid model|bad magic|unable to load model|model file not found/i;

/** Bytes of stderr kept in an error. Enough to name the cause, never a dump. */
const STDERR_KEEP = 400;

/**
 * Turn a non-zero exit into the sentence the user reads.
 *
 * The split that matters is "the model on disk is broken" versus "the run
 * failed", because only the first one has an action attached: the caller
 * deletes the file and the next attempt downloads it again.
 */
function classifyWhisperFailure(exitCode, stderr) {
  const tail = String(stderr ?? "").slice(-STDERR_KEEP).trim();
  if (MODEL_LOAD_FAILURE.test(tail)) {
    return new VoiceError(
      "voice_model_damaged",
      "The speech model on this computer is damaged, so it has been removed. Try dictating again and it will be downloaded fresh.",
    );
  }
  return new VoiceError(
    "voice_engine_failed",
    `The speech engine stopped before it finished${tail ? ` (${tail})` : ` (exit code ${exitCode})`}.`,
  );
}

/**
 * What is wrong with the recording, or null when nothing is.
 *
 * Takes the stat rather than the path so the three answers — no such file, not
 * a file, nothing in it — are decided in one place and can be tested without a
 * filesystem. They stay distinct because they mean different things to whoever
 * recorded: a lost temp file, a path pointing at the wrong kind of thing, and a
 * microphone that captured silence are three different conversations.
 */
function audioProblem(stat) {
  if (!stat) {
    return new VoiceError("voice_audio_missing", "That recording could not be found on this computer.");
  }
  if (!stat.isFile) {
    return new VoiceError("voice_audio_missing", "That is not a recording this plugin can read.");
  }
  if (!stat.size) {
    return new VoiceError("voice_audio_empty", "That recording is empty, so there is nothing to transcribe.");
  }
  return null;
}

/**
 * What a refused recording means, as a sentence.
 *
 * The host's codes survive this direction of the wire — an SDK call's rejection
 * is rebuilt as a structural error with its `code` intact — so unlike this
 * plugin's own failures, these can be branched on rather than read. Cancelled
 * is absent on purpose: it is not a failure, and the caller turns it into a
 * quiet no-op before ever reaching here.
 */
function captureFailure(error) {
  if (error?.code === "audio_capture_busy") {
    return new VoiceError(
      "voice_capture_busy",
      "Something else is already using the microphone. Stop that recording and press Dictate again.",
    );
  }
  return new VoiceError(
    "voice_engine_failed",
    `The microphone could not be started (${error?.message ?? error}).`,
  );
}

/** The sentence for a host too old to have lent a plugin the microphone. */
function captureUnavailableError() {
  return new VoiceError(
    "voice_capture_unavailable",
    "This version of ADE cannot record audio for a plugin. Updating ADE will enable dictation.",
  );
}

/** Whisper heard the clip and found no words in it. Not a failure of anything. */
function noSpeechError() {
  return new VoiceError(
    "voice_no_speech",
    "No words were picked up. Check that the right microphone is selected, and try again.",
  );
}

/** "12%" for the download sentence; null while the total is unknown. */
function formatProgress(receivedBytes, totalBytes) {
  if (!totalBytes || totalBytes <= 0) return null;
  const percent = Math.max(0, Math.min(99, Math.floor((receivedBytes / totalBytes) * 100)));
  return `${percent}%`;
}

/** The sentence a caller gets while the model is still coming down the wire. */
function modelPreparingError(progress) {
  return new VoiceError(
    "voice_model_preparing",
    progress
      ? `Voice dictation is getting ready — the speech model is ${progress} downloaded. Try again in a moment.`
      : "Voice dictation is getting ready — it downloads a one-time 141 MB speech model. Try again in a moment.",
  );
}

module.exports = {
  MODEL_BASENAME,
  MAX_GLOSSARY_TERMS,
  STDERR_KEEP,
  VOICE_ERROR_CODES,
  VoiceError,
  applyGlossaryCasing,
  audioProblem,
  binaryFileNameFor,
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
  normalizeGlossary,
  normalizeLanguage,
  parseWhisperJson,
  parseWhisperStdout,
  platformName,
  promptFromGlossary,
  promptTerms,
  resolveModelDir,
  tidyTranscript,
  unsupportedPlatformError,
};
