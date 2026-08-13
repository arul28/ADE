"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  MAX_GLOSSARY_TERMS,
  STDERR_KEEP,
  VOICE_ERROR_CODES,
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
  modelPreparingError,
  normalizeGlossary,
  normalizeLanguage,
  parseWhisperJson,
  parseWhisperStdout,
  promptFromGlossary,
  resolveModelDir,
  unsupportedPlatformError,
} = require("../engine");

describe("platform selection", () => {
  it("ships one macOS engine and names it for both architectures", () => {
    assert.equal(binaryFileNameFor("darwin"), "whisper-cli-darwin-universal");
    assert.equal(binaryPathFor("/plugins/ade-voice", "darwin"), path.join("/plugins/ade-voice", "bin", "whisper-cli-darwin-universal"));
  });

  it("has nothing for the platforms it does not ship", () => {
    for (const platform of ["linux", "win32", "freebsd"]) {
      assert.equal(binaryFileNameFor(platform), null, platform);
      assert.equal(binaryPathFor("/plugins/ade-voice", platform), null, platform);
    }
  });

  it("says which platform it has nothing for, in plain words", () => {
    const error = unsupportedPlatformError("win32");
    assert.equal(error.code, "voice_unsupported_platform");
    assert.match(error.message, /Windows/);
    assert.match(error.message, /macOS only/);
    // No identifiers in a sentence the composer shows a person.
    assert.doesNotMatch(error.message, /win32|whisper|arm64/);
  });
});

describe("model directory", () => {
  it("uses the app's own whisper folder on macOS, so an existing model is reused", () => {
    assert.equal(
      resolveModelDir({ env: {}, platform: "darwin", homedir: "/Users/x" }),
      "/Users/x/Library/Application Support/ADE/whisper",
    );
  });

  it("follows the platform convention elsewhere", () => {
    assert.equal(
      resolveModelDir({ env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, platform: "win32", homedir: "C:\\Users\\x" }),
      path.join("C:\\Users\\x\\AppData\\Roaming", "ADE", "whisper"),
    );
    assert.equal(
      resolveModelDir({ env: { XDG_DATA_HOME: "/home/x/.local/share" }, platform: "linux", homedir: "/home/x" }),
      "/home/x/.local/share/ADE/whisper",
    );
    assert.equal(
      resolveModelDir({ env: {}, platform: "linux", homedir: "/home/x" }),
      "/home/x/.local/share/ADE/whisper",
    );
  });

  it("is never the install directory, which an update replaces", () => {
    const dir = resolveModelDir({ env: {}, platform: "darwin", homedir: "/Users/x" });
    assert.ok(!dir.includes("/plugins/"), dir);
  });

  it("takes an explicit override", () => {
    assert.equal(
      resolveModelDir({ env: { ADE_VOICE_MODEL_DIR: " /tmp/models " }, platform: "darwin", homedir: "/Users/x" }),
      "/tmp/models",
    );
  });
});

describe("language", () => {
  it("defaults to English and narrows a regional tag to its language", () => {
    assert.equal(normalizeLanguage(undefined), "en");
    assert.equal(normalizeLanguage(""), "en");
    assert.equal(normalizeLanguage("en-US"), "en");
    assert.equal(normalizeLanguage("PT_BR"), "pt");
    assert.equal(normalizeLanguage("auto"), "auto");
  });

  it("refuses anything that is not a language rather than passing it to a subprocess", () => {
    for (const bad of ["--translate", "en; rm -rf /", "1", {}]) {
      assert.throws(() => normalizeLanguage(bad), (error) => error.code === "voice_bad_request", String(bad));
    }
  });
});

describe("glossary", () => {
  it("keeps the caller's spelling, drops blanks and duplicates", () => {
    assert.deepEqual(
      normalizeGlossary(["SwiftUI", " cr-sqlite ", "swiftui", "", null, 7]),
      ["SwiftUI", "cr-sqlite"],
    );
  });

  it("is bounded, because whisper caps the prompt", () => {
    const many = Array.from({ length: MAX_GLOSSARY_TERMS + 20 }, (_, i) => `term${i}`);
    assert.equal(normalizeGlossary(many).length, MAX_GLOSSARY_TERMS);
    assert.ok(promptFromGlossary(normalizeGlossary(many)).length <= 701);
  });

  it("refuses a glossary that is not a list", () => {
    assert.throws(() => normalizeGlossary("SwiftUI"), (error) => error.code === "voice_bad_request");
  });

  it("has no prompt when there is nothing to bias with", () => {
    assert.equal(promptFromGlossary([]), null);
    assert.equal(promptFromGlossary(normalizeGlossary(["  "])), null);
  });
});

describe("whisper arguments", () => {
  const base = { modelPath: "/m/ggml-base.en.bin", audioPath: "/tmp/a.wav", outputBase: "/tmp/out" };

  it("asks for the JSON sidecar with -oj and never -otj", () => {
    const args = buildWhisperArgs(base);
    assert.ok(args.includes("-oj"));
    // -otj does not exist in this build: passing it writes no sidecar and
    // transcribes nothing, which was the original "dictation catches nothing".
    assert.ok(!args.includes("-otj"));
  });

  it("names the model, the recording, the language and its own output base", () => {
    const args = buildWhisperArgs(base);
    assert.deepEqual(args.slice(0, 6), ["-m", "/m/ggml-base.en.bin", "-f", "/tmp/a.wav", "-l", "en"]);
    assert.ok(args.includes("-np"));
    assert.equal(args[args.indexOf("-of") + 1], "/tmp/out");
  });

  it("omits the output base when there is none", () => {
    assert.ok(!buildWhisperArgs({ ...base, outputBase: null }).includes("-of"));
  });

  it("passes the glossary as the initial prompt, and only when there is one", () => {
    assert.ok(!buildWhisperArgs(base).includes("--prompt"));
    const args = buildWhisperArgs({ ...base, glossary: ["SwiftUI", "cr-sqlite"] });
    assert.equal(args[args.indexOf("--prompt") + 1], "SwiftUI, cr-sqlite.");
  });

  it("carries the caller's language through", () => {
    const args = buildWhisperArgs({ ...base, language: "es-ES" });
    assert.equal(args[args.indexOf("-l") + 1], "es");
  });
});

describe("reading whisper's output", () => {
  it("prefers the sidecar's segments", () => {
    assert.equal(
      parseWhisperJson('{"transcription":[{"text":" hello"},{"text":" world"}]}'),
      "hello world",
    );
    assert.equal(parseWhisperJson('{"text":"  hi  "}'), "hi");
  });

  it("returns null rather than guessing when the sidecar is unusable", () => {
    assert.equal(parseWhisperJson("not json"), null);
    assert.equal(parseWhisperJson('{"transcription":[]}'), null);
    assert.equal(parseWhisperJson('{"transcription":[{"text":"   "}]}'), null);
  });

  it("falls back to stdout with its timestamps stripped", () => {
    const stdout = [
      "[00:00:00.000 --> 00:00:02.000]   hello there",
      "[00:00:02.000 --> 00:00:04.000]   general kenobi",
      "",
    ].join("\n");
    assert.equal(parseWhisperStdout(stdout), "hello there general kenobi");
  });
});

// The packaged glossary has its own file of tests; these use the empty one, so
// what is asserted here is the pass every transcript gets regardless of it.
describe("the transcript that comes back", () => {
  it("drops the sound-event markers whisper emits for silence", () => {
    assert.equal(finishTranscript("[BLANK_AUDIO] ship it [BLANK_AUDIO]", []), "Ship it");
    // Only whisper's shouted markers, never bracketed words someone dictated.
    assert.equal(finishTranscript("call it [the good one]", []), "Call it [the good one]");
  });

  it("tidies spacing and capitalizes sentences without touching the words", () => {
    assert.equal(finishTranscript("  rebase   the lane , then push .  ", []), "Rebase the lane, then push.");
    assert.equal(finishTranscript("OpenAI and SwiftUI", []), "OpenAI and SwiftUI");
  });

  it("restores the caller's spelling of its own vocabulary", () => {
    assert.equal(
      finishTranscript("open swiftui and check cr-sqlite", ["SwiftUI", "cr-sqlite"]),
      "Open SwiftUI and check cr-sqlite",
    );
  });

  it("prefers the longest matching term, so a phrase beats its own prefix", () => {
    assert.equal(
      finishTranscript("the work tree is dirty", ["Work Tree", "Work"]),
      "The Work Tree is dirty",
    );
  });

  it("matches on whole words only", () => {
    assert.equal(finishTranscript("workspace matters", ["work"]), "Workspace matters");
  });

  it("is empty for an empty transcript rather than throwing", () => {
    assert.equal(finishTranscript("", ["SwiftUI"]), "");
    assert.equal(finishTranscript("   [BLANK_AUDIO]  ", []), "");
  });
});

describe("the recording itself", () => {
  it("passes a real recording through", () => {
    assert.equal(audioProblem({ isFile: true, size: 138_908 }), null);
  });

  it("keeps the three ways a recording can be unusable apart", () => {
    assert.equal(audioProblem(null).code, "voice_audio_missing");
    assert.match(audioProblem(null).message, /could not be found/);
    // A directory or a device: it is there, it is just not a recording.
    assert.equal(audioProblem({ isFile: false, size: 0 }).code, "voice_audio_missing");
    assert.match(audioProblem({ isFile: false, size: 0 }).message, /not a recording/);
    assert.equal(audioProblem({ isFile: true, size: 0 }).code, "voice_audio_empty");
    assert.match(audioProblem({ isFile: true, size: 0 }).message, /empty/);
  });
});

describe("a recording that could not be made", () => {
  it("names the microphone conflict, because that one has a fix", () => {
    const busy = captureFailure({ code: "audio_capture_busy", message: "capture in progress" });
    assert.equal(busy.code, "voice_capture_busy");
    assert.match(busy.message, /already using the microphone/);
    assert.doesNotMatch(busy.message, /audio_capture_busy/);
  });

  it("carries an unrecognised host failure's own words rather than swallowing them", () => {
    const failed = captureFailure({ code: "internal_error", message: "no input device" });
    assert.equal(failed.code, "voice_engine_failed");
    assert.match(failed.message, /no input device/);
  });

  it("tells someone on an older ADE what would fix it", () => {
    assert.equal(captureUnavailableError().code, "voice_capture_unavailable");
    assert.match(captureUnavailableError().message, /Updating ADE/);
  });

  it("treats silence as an outcome, not a fault", () => {
    assert.equal(noSpeechError().code, "voice_no_speech");
    assert.match(noSpeechError().message, /No words were picked up/);
    // No blame, no jargon: the user did nothing wrong by not speaking.
    assert.doesNotMatch(noSpeechError().message, /error|failed|invalid/i);
  });
});

describe("failure", () => {
  it("treats a model that will not load as a file to throw away", () => {
    const error = classifyWhisperFailure(1, "whisper_init_from_file_with_params_no_state: failed to load model\n");
    assert.equal(error.code, "voice_model_damaged");
    assert.match(error.message, /damaged/);
    assert.match(error.message, /downloaded fresh/);
  });

  it("keeps other failures separate, and bounded", () => {
    const error = classifyWhisperFailure(3, "x".repeat(50_000));
    assert.equal(error.code, "voice_engine_failed");
    assert.ok(error.message.length < STDERR_KEEP + 200, `message was ${error.message.length} chars`);
  });

  it("names the exit code when whisper said nothing", () => {
    assert.match(classifyWhisperFailure(9, "").message, /exit code 9/);
  });

  it("reports download progress as a percentage, and never as 100 before it lands", () => {
    assert.equal(formatProgress(50, 100), "50%");
    assert.equal(formatProgress(100, 100), "99%");
    assert.equal(formatProgress(10, 0), null);
    assert.equal(formatProgress(10, null), null);
  });

  it("says the model is still coming, with the number when it has one", () => {
    assert.match(modelPreparingError("42%").message, /42% downloaded/);
    assert.match(modelPreparingError(null).message, /141 MB/);
    assert.equal(modelPreparingError(null).code, "voice_model_preparing");
  });

  it("enumerates its own taxonomy", () => {
    // The list is the contract the README describes; a new code has to be
    // added here deliberately rather than appearing in a message by accident.
    assert.deepEqual(new Set(VOICE_ERROR_CODES).size, VOICE_ERROR_CODES.length);
    for (const code of ["voice_unsupported_platform", "voice_model_preparing", "voice_timeout"]) {
      assert.ok(VOICE_ERROR_CODES.includes(code), code);
    }
  });
});
