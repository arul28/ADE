import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
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
const universalDarwinArchs = ["arm64", "x86_64"];

// ───────────────────────────────────────────────────────────────────────────
// Whisper resources we materialize into resources/whisper/ for packaging:
//   - whisper-cli (per-platform whisper.cpp binary)
//   - ggml-base.en.bin (~142 MB English base model, shared across platforms)
//
// These are large (~140 MB model + binaries) and MUST NOT be committed. They
// land under the packaged app's resources/whisper/ via extraResources and are
// delivered to existing users by the auto-updater (the full app is shipped on
// update, so the new resources arrive with it).
//
// IMPORTANT: This script downloads the model + binaries. Set the source URLs
// below (or override via env) before running. We deliberately DO NOT pin live
// upstream URLs here that could rot; configure them at release time.
// ───────────────────────────────────────────────────────────────────────────

const MODEL_BASENAME = "ggml-base.en.bin";
// HuggingFace-hosted ggml model (whisper.cpp official). Overridable via env so
// release CI can repoint to a mirror without code changes.
const MODEL_URL =
  process.env.ADE_WHISPER_MODEL_URL?.trim() ||
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

// Per-platform whisper.cpp CLI binary download URLs. These are intentionally
// left as env-overridable placeholders: whisper.cpp does not publish a single
// canonical cross-platform binary release, so release engineering supplies the
// built binaries (CI artifact or a pinned mirror) at packaging time.
function whisperBinarySpecForHost() {
  const platform = process.platform;
  const arch = process.arch;
  const target = isUniversalDarwinBuild()
    ? "darwin-universal"
    : `${platform}-${arch}`;
  const exeSuffix = platform === "win32" ? ".exe" : "";
  const envKey = `ADE_WHISPER_CLI_URL_${target.replace(/-/g, "_").toUpperCase()}`;
  const url = process.env[envKey]?.trim() || process.env.ADE_WHISPER_CLI_URL?.trim() || null;
  return { target, url, fileName: `whisper-cli${exeSuffix}` };
}

function isUniversalDarwinBuild() {
  if (process.platform !== "darwin") return false;
  const lifecycle = process.env.npm_lifecycle_event ?? "";
  return process.env.ADE_WHISPER_REQUIRE_UNIVERSAL === "1"
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

async function materializeModel() {
  const modelPath = path.join(whisperRoot, MODEL_BASENAME);
  if (await pathExists(modelPath)) {
    console.log(`[whisper-resources] Model already present: ${modelPath}`);
    return;
  }
  console.log(`[whisper-resources] Downloading ${MODEL_BASENAME} from ${redactUrl(MODEL_URL)}`);
  await downloadFile(MODEL_URL, modelPath);
  console.log(`[whisper-resources] Downloaded model -> ${modelPath}`);
}

// whisper.cpp source used when no prebuilt binary URL is configured. Overridable
// so release CI can pin a vetted ref / mirror.
const WHISPER_SRC_REPO =
  process.env.ADE_WHISPER_SRC_REPO?.trim() || "https://github.com/ggerganov/whisper.cpp.git";
const WHISPER_SRC_REF = process.env.ADE_WHISPER_SRC_REF?.trim() || "v1.7.5";

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

// Build a self-contained whisper.cpp CLI from source (static libs, no Metal so
// there is no external .metallib dependency) — the reproducible release path,
// since whisper.cpp publishes no canonical cross-platform binary. base.en runs
// fast on CPU via Accelerate/NEON.
async function buildBinaryFromSource(binaryPath, target) {
  if (!(await hasTool("git")) || !(await hasTool("cmake"))) {
    console.warn(
      `[whisper-resources] No whisper.cpp CLI URL configured for ${target} and cannot build from source ` +
        "(requires `git` and `cmake` on PATH). Install them, set ADE_WHISPER_CLI_URL to a prebuilt binary, " +
        "or drop a whisper-cli into resources/whisper/ manually. Skipping binary for this host.",
    );
    return;
  }
  const buildRoot = path.join(whisperRoot, ".build");
  const srcDir = path.join(buildRoot, "whisper.cpp");
  const cmakeBuildDir = path.join(srcDir, "build");
  await fs.rm(buildRoot, { recursive: true, force: true });
  await fs.mkdir(buildRoot, { recursive: true });

  console.log(
    `[whisper-resources] Building self-contained whisper.cpp ${WHISPER_SRC_REF} for ${target} (static, CPU)`,
  );
  await spawnStep("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    WHISPER_SRC_REF,
    WHISPER_SRC_REPO,
    srcDir,
  ]);

  const cmakeConfigureArgs = [
    "-S",
    srcDir,
    "-B",
    cmakeBuildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DWHISPER_BUILD_TESTS=OFF",
    "-DWHISPER_BUILD_SERVER=OFF",
    "-DGGML_METAL=OFF",
  ];
  if (process.platform === "darwin") {
    // ADE ships a UNIVERSAL macOS app (arm64 + x86_64), so the bundled binary
    // must be universal too or it breaks on Intel Macs / the universal merge.
    cmakeConfigureArgs.push("-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64");
  }
  await spawnStep("cmake", cmakeConfigureArgs);
  await spawnStep("cmake", [
    "--build",
    cmakeBuildDir,
    "--config",
    "Release",
    "-j",
    String(os.cpus().length || 4),
  ]);

  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const builtCandidates = [
    path.join(cmakeBuildDir, "bin", `whisper-cli${exeSuffix}`),
    path.join(cmakeBuildDir, "bin", "Release", `whisper-cli${exeSuffix}`),
    path.join(cmakeBuildDir, "bin", `main${exeSuffix}`),
  ];
  let built = null;
  for (const candidate of builtCandidates) {
    if (await pathExists(candidate)) {
      built = candidate;
      break;
    }
  }
  if (!built) {
    throw new Error("whisper.cpp build did not produce a whisper-cli binary");
  }
  await fs.copyFile(built, binaryPath);
  if (process.platform !== "win32") {
    await fs.chmod(binaryPath, 0o755);
  }
  await fs.rm(buildRoot, { recursive: true, force: true });
  console.log(`[whisper-resources] Built + installed self-contained binary -> ${binaryPath}`);
}

async function assertDarwinUniversalBinary(binaryPath, target) {
  if (process.platform !== "darwin" || target !== "darwin-universal") return;
  if (!(await hasTool("lipo"))) {
    throw new Error("Cannot validate universal whisper-cli: `lipo` is not available on PATH.");
  }
  const { stdout } = await execFileAsync("lipo", ["-archs", binaryPath]);
  const actualArchs = stdout.trim().split(/\s+/).filter(Boolean);
  const missing = universalDarwinArchs.filter((arch) => !actualArchs.includes(arch));
  if (missing.length > 0) {
    throw new Error(
      `whisper-cli for ${target} is missing architecture(s): ${missing.join(", ")} ` +
        `(found: ${actualArchs.join(", ") || "none"})`,
    );
  }
}

async function materializeBinary() {
  const spec = whisperBinarySpecForHost();
  const binaryPath = path.join(whisperRoot, spec.fileName);
  if (await pathExists(binaryPath)) {
    console.log(`[whisper-resources] Binary already present: ${binaryPath}`);
    await assertDarwinUniversalBinary(binaryPath, spec.target);
    return;
  }
  if (spec.url) {
    console.log(`[whisper-resources] Downloading whisper.cpp CLI for ${spec.target} from ${redactUrl(spec.url)}`);
    await downloadFile(spec.url, binaryPath);
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

async function main() {
  await fs.mkdir(whisperRoot, { recursive: true });
  await materializeModel();
  await materializeBinary();
  console.log("[whisper-resources] Done.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
