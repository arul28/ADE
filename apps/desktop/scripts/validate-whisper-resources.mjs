import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const whisperRoot = path.join(desktopRoot, "resources", "whisper");
const voiceRoot = path.join(desktopRoot, "resources", "voice");

const MODEL_BASENAME = "ggml-base.en.bin";
const MIN_MODEL_BYTES = 50 * 1024 * 1024; // base.en is ~142 MB; guard against a truncated download.
const GLOSSARY_BASENAME = "voice-glossary.json";
const MAX_CONTEXTUAL_TERMS = 100;

// Candidate whisper binary names accepted at runtime (transcriptionService).
function whisperBinaryNamesForHost() {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  return [`whisper-cli${exeSuffix}`, `main${exeSuffix}`, `whisper${exeSuffix}`];
}

function fail(message) {
  throw new Error(`[whisper-resources] ${message}`);
}

async function statFile(filePath, label) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    fail(`Missing ${label}: ${filePath}`);
  }
  if (!stat.isFile()) fail(`Expected ${label} to be a file: ${filePath}`);
  if (stat.size <= 0) fail(`Expected ${label} to be non-empty: ${filePath}`);
  return stat;
}

async function firstExistingBinary() {
  for (const name of whisperBinaryNamesForHost()) {
    const candidate = path.join(whisperRoot, name);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return { candidate, stat };
    } catch {
      // keep looking
    }
  }
  return null;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function validateVoiceGlossary(glossaryPath) {
  const raw = await fs.readFile(glossaryPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Voice glossary is not valid JSON: ${glossaryPath} (${error instanceof Error ? error.message : String(error)})`);
  }

  if (!isPlainObject(parsed)) fail(`Voice glossary must be a JSON object: ${glossaryPath}`);
  if (!Number.isFinite(parsed.version)) fail("Voice glossary must include a numeric `version`.");
  if (!Array.isArray(parsed.contextualTerms)) fail("Voice glossary must include `contextualTerms` as an array.");
  if (parsed.contextualTerms.length > MAX_CONTEXTUAL_TERMS) {
    fail(`Voice glossary has ${parsed.contextualTerms.length} contextual terms; keep it at or below ${MAX_CONTEXTUAL_TERMS}.`);
  }
  for (const term of parsed.contextualTerms) {
    if (typeof term !== "string" || term.trim().length === 0) {
      fail("Voice glossary `contextualTerms` must contain only non-empty strings.");
    }
  }

  if (!isPlainObject(parsed.corrections)) fail("Voice glossary must include `corrections` as an object.");
  for (const [from, to] of Object.entries(parsed.corrections)) {
    if (from.trim().length === 0 || typeof to !== "string" || to.trim().length === 0) {
      fail("Voice glossary `corrections` must map non-empty strings to non-empty strings.");
    }
  }

  if (!Array.isArray(parsed.fillers)) fail("Voice glossary must include `fillers` as an array.");
  for (const filler of parsed.fillers) {
    if (typeof filler !== "string" || filler.trim().length === 0) {
      fail("Voice glossary `fillers` must contain only non-empty strings.");
    }
  }
}

async function main() {
  // Glossary is committed and always required.
  const glossaryPath = path.join(voiceRoot, GLOSSARY_BASENAME);
  await statFile(glossaryPath, "voice glossary");
  await validateVoiceGlossary(glossaryPath);

  // Model must be present and look like the real (large) base.en weights.
  const modelStat = await statFile(path.join(whisperRoot, MODEL_BASENAME), "whisper base.en model");
  if (modelStat.size < MIN_MODEL_BYTES) {
    fail(
      `Whisper model looks truncated (${modelStat.size} bytes, expected >= ${MIN_MODEL_BYTES}): ` +
        path.join(whisperRoot, MODEL_BASENAME),
    );
  }

  // A whisper.cpp CLI binary for the host platform must be present + executable.
  const binary = await firstExistingBinary();
  if (!binary) {
    fail(
      `No whisper.cpp CLI binary found in ${whisperRoot} (looked for ${whisperBinaryNamesForHost().join(", ")}).`,
    );
  }
  if (process.platform !== "win32" && (binary.stat.mode & 0o111) === 0) {
    fail(`Expected whisper.cpp CLI binary to be executable: ${binary.candidate}`);
  }

  console.log(
    `[whisper-resources] Validated voice glossary, base.en model (${Math.round(modelStat.size / 1024 / 1024)} MB), ` +
      `and host CLI binary (${path.basename(binary.candidate)}).`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    "[whisper-resources] Populate apps/desktop/resources/whisper with `ggml-base.en.bin` and a per-platform " +
      "whisper.cpp CLI binary (whisper-cli). Run `npm --prefix apps/desktop run materialize:whisper-resources` " +
      "with ADE_WHISPER_MODEL_URL / ADE_WHISPER_CLI_URL configured, or drop prebuilt files in manually. " +
      "These large binaries are gitignored and delivered to existing users by the auto-updater on update.",
  );
  process.exit(1);
});
