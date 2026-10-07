import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const whisperRoot = path.join(desktopRoot, "resources", "whisper");
const maxDownloadRedirects = 10;
const configuredDownloadTimeoutMs = Number.parseInt(process.env.ADE_WHISPER_DOWNLOAD_TIMEOUT_MS ?? "", 10);
const downloadTimeoutMs =
  Number.isFinite(configuredDownloadTimeoutMs) && configuredDownloadTimeoutMs > 0
    ? configuredDownloadTimeoutMs
    : 120_000;
const configuredDownloadAttempts = Number.parseInt(process.env.ADE_WHISPER_DOWNLOAD_RETRIES ?? "", 10);
// Large model + binary fetches over CDNs (HuggingFace xet-bridge, GitHub) hit
// transient stalls; a single ETIMEDOUT must NOT sink a 20-minute release run.
const maxDownloadAttempts =
  Number.isFinite(configuredDownloadAttempts) && configuredDownloadAttempts > 0
    ? configuredDownloadAttempts
    : 4;
const universalDarwinArchs = ["arm64", "x86_64"];

// ───────────────────────────────────────────────────────────────────────────
// Speech-to-text resources we materialize into resources/whisper/ for packaging:
//   - transcribe-cli (per-platform transcribe.cpp binary, built from a pinned
//     commit unless a prebuilt URL is configured)
//   - parakeet-ultra-Q4_K_M.gguf (~464 MB) ONLY when ADE_SPEECH_BUNDLE_MODEL=1;
//     normally the app downloads it at runtime (see whisperModelStore.ts)
//
// These MUST NOT be committed. They land under the packaged app's
// resources/whisper/ via extraResources. The directory keeps its historical
// `whisper` name so packaging paths and existing installs stay stable.
// ───────────────────────────────────────────────────────────────────────────

const MODEL_BASENAME = "parakeet-ultra-Q4_K_M.gguf";
// Commit-pinned Hugging Face URL, so the bytes can never change under the
// pinned digest. Keep in sync with whisperModelStore.ts.
const DEFAULT_MODEL_URL =
  "https://huggingface.co/handy-computer/parakeet-ultra-gguf/resolve/39eeb55181f0d354fd934f06e92fd8d5037fed8e/parakeet-ultra-Q4_K_M.gguf";
// Matches the Git LFS oid Hugging Face reports for that file.
const DEFAULT_MODEL_SHA256 =
  "c69b7a5f9071a7afd8a1818ef7ae542c386c4b01ed0cac380c19a99947646bf9";
const MODEL_URL = process.env.ADE_SPEECH_MODEL_URL?.trim() || DEFAULT_MODEL_URL;
// When MODEL_URL is overridden (e.g. a release mirror), the pinned hash no
// longer applies automatically; the override must bring its own expected hash
// via ADE_SPEECH_MODEL_SHA256 or the script refuses to download.
const MODEL_SHA256 =
  process.env.ADE_SPEECH_MODEL_SHA256?.trim().toLowerCase() ||
  (MODEL_URL === DEFAULT_MODEL_URL ? DEFAULT_MODEL_SHA256 : null);

// Files earlier ADE versions materialized here. A stale copy would be packaged
// alongside the new engine, so they are removed on every run.
const LEGACY_FILE_BASENAMES = [
  "whisper-cli",
  "whisper-cli.exe",
  "main",
  "main.exe",
  "whisper",
  "whisper.exe",
  "ggml-base.en.bin",
];

// Optional prebuilt transcribe-cli per target. A URL must come with its SHA-256.
function transcribeBinarySpecForHost() {
  const platform = process.platform;
  const arch = process.arch;
  const target = isUniversalDarwinBuild()
    ? "darwin-universal"
    : `${platform}-${arch}`;
  const exeSuffix = platform === "win32" ? ".exe" : "";
  const targetKey = target.replace(/-/g, "_").toUpperCase();
  const envKey = `ADE_TRANSCRIBE_CLI_URL_${targetKey}`;
  const url = process.env[envKey]?.trim() || process.env.ADE_TRANSCRIBE_CLI_URL?.trim() || null;
  const sha256 =
    process.env[`ADE_TRANSCRIBE_CLI_SHA256_${targetKey}`]?.trim().toLowerCase() ||
    process.env.ADE_TRANSCRIBE_CLI_SHA256?.trim().toLowerCase() ||
    null;
  return { target, targetKey, url, sha256, fileName: `transcribe-cli${exeSuffix}` };
}

function isUniversalDarwinBuild() {
  if (process.platform !== "darwin") return false;
  const lifecycle = process.env.npm_lifecycle_event ?? "";
  return process.env.ADE_SPEECH_REQUIRE_UNIVERSAL === "1"
    || process.env.npm_config_arch === "universal"
    || lifecycle.includes("universal");
}

function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = "redacted";
    }
    if (url.search) url.search = "?redacted";
    if (url.hash) url.hash = "#redacted";
    return url.toString();
  } catch {
    return "[redacted-url]";
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url, destinationPath, redirectsRemaining = maxDownloadRedirects) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const partialPath = `${destinationPath}.part`;
  await fs.rm(partialPath, { force: true });
  try {
    const redirectUrl = await new Promise((resolve, reject) => {
      let output = null;
      let settled = false;
      let request = null;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        output?.destroy();
        request?.destroy();
        reject(error);
      };
      const succeed = (nextUrl = null) => {
        if (settled) return;
        settled = true;
        resolve(nextUrl);
      };

      request = https.get(url, { timeout: downloadTimeoutMs }, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          if (redirectsRemaining <= 0) {
              fail(new Error(`Too many redirects while downloading ${redactUrl(url)}`));
            return;
          }
          succeed(new URL(response.headers.location, url).toString());
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          fail(new Error(`HTTP ${response.statusCode ?? "unknown"} for ${redactUrl(url)}`));
          return;
        }
        output = createWriteStream(partialPath, { mode: 0o644 });
        response.once("aborted", () => fail(new Error(`Download aborted for ${redactUrl(url)}`)));
        response.once("error", fail);
        response.pipe(output);
        output.once("finish", () => output.close(() => succeed()));
        output.once("error", fail);
      });
      request.setTimeout(downloadTimeoutMs, () => {
        fail(new Error(`Timed out after ${Math.round(downloadTimeoutMs / 1000)}s while downloading ${redactUrl(url)}`));
      });
      request.once("error", fail);
    });

    if (redirectUrl) {
      await fs.rm(partialPath, { force: true });
      await downloadFile(redirectUrl, destinationPath, redirectsRemaining - 1);
      return;
    }

    await fs.rename(partialPath, destinationPath);
  } catch (error) {
    await fs.rm(partialPath, { force: true });
    throw error;
  }
}

function isRetryableDownloadError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : String(error);
  const retryableCodes = [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "ENETUNREACH",
    "ENETDOWN",
    "EHOSTUNREACH",
    "UND_ERR_SOCKET",
  ];
  if (retryableCodes.includes(code)) return true;
  // Transient HTTP statuses (429 + 5xx) and generic socket/timeout failures.
  return /ETIMEDOUT|ECONNRESET|socket hang up|aborted|Timed out|Download aborted|HTTP (?:429|5\d\d)/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256OfFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

// Verify-or-die: these artifacts ship inside the packaged (notarized) app, so
// a downloaded file that does not match its expected SHA-256 must never be
// kept. Deletes the file and throws on mismatch.
async function assertFileSha256(filePath, expectedSha256, label) {
  const expected = expectedSha256.toLowerCase();
  const actual = await sha256OfFile(filePath);
  if (actual !== expected) {
    await fs.rm(filePath, { force: true });
    throw new Error(
      `SHA-256 mismatch for ${label}: expected ${expected}, got ${actual}. ` +
        "Refusing to package the unverified download.",
    );
  }
  console.log(`[whisper-resources] Verified SHA-256 for ${label}: ${actual}`);
}

// Retry the whole download (redirects included) on transient network failures.
// Non-retryable errors (e.g. HTTP 404) throw immediately.
async function downloadWithRetry(url, destinationPath) {
  let lastError;
  for (let attempt = 1; attempt <= maxDownloadAttempts; attempt += 1) {
    try {
      await downloadFile(url, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryableDownloadError(error) || attempt === maxDownloadAttempts) {
        throw error;
      }
      const backoffMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      console.warn(
        `[whisper-resources] Download attempt ${attempt}/${maxDownloadAttempts} failed (${message}); ` +
          `retrying in ${Math.round(backoffMs / 1000)}s`,
      );
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

async function materializeModel() {
  const modelPath = path.join(whisperRoot, MODEL_BASENAME);
  if (await pathExists(modelPath)) {
    console.log(`[whisper-resources] Model already present: ${modelPath}`);
    return;
  }
  if (!MODEL_SHA256) {
    throw new Error(
      "ADE_SPEECH_MODEL_URL overrides the default model URL, so the pinned checksum does not apply. " +
        `Set ADE_SPEECH_MODEL_SHA256 to the expected SHA-256 of ${MODEL_BASENAME} at that URL.`,
    );
  }
  console.log(`[whisper-resources] Downloading ${MODEL_BASENAME} from ${redactUrl(MODEL_URL)}`);
  await downloadWithRetry(MODEL_URL, modelPath);
  await assertFileSha256(modelPath, MODEL_SHA256, MODEL_BASENAME);
  console.log(`[whisper-resources] Downloaded model -> ${modelPath}`);
}

// transcribe.cpp source used when no prebuilt binary URL is configured. Pinned
// to a commit, not a tag: Parakeet Ultra support landed after v0.3.1.
// Overridable so release CI can pin a vetted ref / mirror.
const TRANSCRIBE_SRC_REPO =
  process.env.ADE_TRANSCRIBE_SRC_REPO?.trim() || "https://github.com/handy-computer/transcribe.cpp.git";
const TRANSCRIBE_SRC_REF =
  process.env.ADE_TRANSCRIBE_SRC_REF?.trim() || "135d744cbb87dcac8a04dbc9bab1bb25ada5d701";

async function hasTool(tool) {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [tool]);
    return true;
  } catch {
    return false;
  }
}

function spawnStep(cmd, args, options = {}) {
  console.log(`[whisper-resources] $ ${cmd} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
    );
  });
}

// CMake flags for one target architecture. Release binaries run on users'
// machines, so never build for the CI runner's own CPU (GGML_NATIVE).
function cmakeArchArgs(arch) {
  if (arch === "x86_64") {
    // x86-64-v3 (AVX2/FMA/F16C/BMI2): every x86 CPU since ~2015. Measured as
    // fast as a -march=native build on a Ryzen 9 7950X3D.
    return [
      "-DTRANSCRIBE_X86_CONSERVATIVE=ON",
      "-DGGML_AVX=ON",
      "-DGGML_AVX2=ON",
      "-DGGML_FMA=ON",
      "-DGGML_F16C=ON",
      "-DGGML_BMI2=ON",
    ];
  }
  return ["-DGGML_NATIVE=OFF"];
}

async function cloneTranscribeSource(srcDir) {
  for (let attempt = 1; attempt <= maxDownloadAttempts; attempt += 1) {
    try {
      // Fetch the exact ref (a commit SHA works; `clone --branch` would not).
      await spawnStep("git", ["init", "-q", srcDir]);
      await spawnStep("git", ["-C", srcDir, "fetch", "-q", "--depth", "1", TRANSCRIBE_SRC_REPO, TRANSCRIBE_SRC_REF]);
      await spawnStep("git", ["-C", srcDir, "checkout", "-q", "FETCH_HEAD"]);
      return;
    } catch (error) {
      await fs.rm(srcDir, { recursive: true, force: true });
      if (attempt === maxDownloadAttempts) throw error;
      const backoffMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[whisper-resources] transcribe.cpp fetch attempt ${attempt}/${maxDownloadAttempts} failed (${message}); ` +
          `retrying in ${Math.round(backoffMs / 1000)}s`,
      );
      await sleep(backoffMs);
    }
  }
}

// Configure + build transcribe-cli for one architecture; returns the binary path.
async function buildTranscribeCli(srcDir, buildDir, arch) {
  const configureArgs = [
    "-S",
    srcDir,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DTRANSCRIBE_BUILD_SHARED=OFF",
    "-DTRANSCRIBE_BUILD_TESTS=OFF",
    "-DTRANSCRIBE_INSTALL=OFF",
    "-DTRANSCRIBE_USE_SYSTEM_BLAS=OFF",
    ...cmakeArchArgs(arch),
  ];
  if (process.platform === "darwin") {
    configureArgs.push(`-DCMAKE_OSX_ARCHITECTURES=${arch}`);
    // Metal on Apple Silicon only, with the shader library embedded in the
    // binary so there is no separate .metallib to ship.
    const metal = arch === "arm64" ? "ON" : "OFF";
    configureArgs.push(`-DTRANSCRIBE_METAL=${metal}`, `-DGGML_METAL_EMBED_LIBRARY=${metal}`);
  }
  await spawnStep("cmake", configureArgs);
  await spawnStep("cmake", [
    "--build",
    buildDir,
    "--config",
    "Release",
    "--target",
    "transcribe-cli",
    "-j",
    String(os.cpus().length || 4),
  ]);

  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  for (const candidate of [
    path.join(buildDir, "bin", `transcribe-cli${exeSuffix}`),
    path.join(buildDir, "bin", "Release", `transcribe-cli${exeSuffix}`),
  ]) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error(`transcribe.cpp build for ${arch} did not produce a transcribe-cli binary`);
}

// Build a self-contained (static) transcribe-cli from source: the reproducible
// release path, since transcribe.cpp publishes no prebuilt CLI binaries.
async function buildBinaryFromSource(binaryPath, target) {
  if (!(await hasTool("git")) || !(await hasTool("cmake"))) {
    console.warn(
      `[whisper-resources] No transcribe-cli URL configured for ${target} and cannot build from source ` +
        "(requires `git` and `cmake` on PATH). Install them, set ADE_TRANSCRIBE_CLI_URL to a prebuilt binary, " +
        "or drop a transcribe-cli into resources/whisper/ manually. Skipping binary for this host.",
    );
    return;
  }
  // Build under a short temp path: MSBuild's intermediate paths overflow
  // Windows' 260-character limit from a deep checkout (e.g. a lane worktree).
  const buildRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ade-tcpp-"));
  const srcDir = path.join(buildRoot, "src");

  try {
    console.log(`[whisper-resources] Building transcribe.cpp ${TRANSCRIBE_SRC_REF} for ${target} (static)`);
    await cloneTranscribeSource(srcDir);

    if (target === "darwin-universal") {
      // ggml picks SIMD flags per target arch, so each slice gets its own build
      // and lipo merges them.
      const slices = [];
      for (const arch of universalDarwinArchs) {
        slices.push(await buildTranscribeCli(srcDir, path.join(buildRoot, `build-${arch}`), arch));
      }
      await spawnStep("lipo", ["-create", ...slices, "-output", binaryPath]);
    } else {
      const arch = process.arch === "x64" ? "x86_64" : process.arch;
      const built = await buildTranscribeCli(srcDir, path.join(buildRoot, "build"), arch);
      await fs.copyFile(built, binaryPath);
    }
    if (process.platform !== "win32") {
      await fs.chmod(binaryPath, 0o755);
    }
  } finally {
    await fs.rm(buildRoot, { recursive: true, force: true });
  }
  console.log(`[whisper-resources] Built + installed self-contained binary -> ${binaryPath}`);
}

async function assertDarwinUniversalBinary(binaryPath, target) {
  if (process.platform !== "darwin" || target !== "darwin-universal") return;
  if (!(await hasTool("lipo"))) {
    throw new Error("Cannot validate universal transcribe-cli: `lipo` is not available on PATH.");
  }
  const { stdout } = await execFileAsync("lipo", ["-archs", binaryPath]);
  const actualArchs = stdout.trim().split(/\s+/).filter(Boolean);
  const missing = universalDarwinArchs.filter((arch) => !actualArchs.includes(arch));
  if (missing.length > 0) {
    throw new Error(
      `transcribe-cli for ${target} is missing architecture(s): ${missing.join(", ")} ` +
        `(found: ${actualArchs.join(", ") || "none"})`,
    );
  }
}

async function materializeBinary() {
  const spec = transcribeBinarySpecForHost();
  const binaryPath = path.join(whisperRoot, spec.fileName);
  if (await pathExists(binaryPath)) {
    console.log(`[whisper-resources] Binary already present: ${binaryPath}`);
    await assertDarwinUniversalBinary(binaryPath, spec.target);
    return;
  }
  if (spec.url) {
    if (!spec.sha256) {
      throw new Error(
        `A transcribe-cli download URL is configured for ${spec.target}, but no expected checksum was provided. ` +
          `Set ADE_TRANSCRIBE_CLI_SHA256_${spec.targetKey} (or ADE_TRANSCRIBE_CLI_SHA256) ` +
          "to the SHA-256 of that binary.",
      );
    }
    console.log(`[whisper-resources] Downloading transcribe-cli for ${spec.target} from ${redactUrl(spec.url)}`);
    await downloadWithRetry(spec.url, binaryPath);
    await assertFileSha256(binaryPath, spec.sha256, spec.fileName);
    if (process.platform !== "win32") {
      await fs.chmod(binaryPath, 0o755);
    }
    await assertDarwinUniversalBinary(binaryPath, spec.target);
    console.log(`[whisper-resources] Downloaded binary -> ${binaryPath}`);
    return;
  }
  await buildBinaryFromSource(binaryPath, spec.target);
  await assertDarwinUniversalBinary(binaryPath, spec.target);
}

async function removeLegacyFiles() {
  for (const basename of LEGACY_FILE_BASENAMES) {
    const legacyPath = path.join(whisperRoot, basename);
    if (await pathExists(legacyPath)) {
      await fs.rm(legacyPath, { force: true });
      console.log(`[whisper-resources] Removed legacy ${basename}`);
    }
  }
}

async function main() {
  await fs.mkdir(whisperRoot, { recursive: true });
  await removeLegacyFiles();
  // The speech model is NOT bundled: the app downloads it at runtime
  // (whisperModelStore) so it never bloats the auto-update zip. Only the small
  // transcribe-cli binary is materialized for packaging. Set
  // ADE_SPEECH_BUNDLE_MODEL=1 to also fetch the model (e.g. an offline build).
  if (process.env.ADE_SPEECH_BUNDLE_MODEL === "1") {
    await materializeModel();
  } else {
    console.log(
      "[whisper-resources] Skipping model bundling (runtime-downloaded). " +
        `Set ADE_SPEECH_BUNDLE_MODEL=1 to bundle ${MODEL_BASENAME}.`,
    );
  }
  await materializeBinary();
  console.log("[whisper-resources] Done.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
