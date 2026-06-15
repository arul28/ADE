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
  const target = `${platform}-${arch}`;
  const exeSuffix = platform === "win32" ? ".exe" : "";
  const envKey = `ADE_WHISPER_CLI_URL_${target.replace(/-/g, "_").toUpperCase()}`;
  const url = process.env[envKey]?.trim() || process.env.ADE_WHISPER_CLI_URL?.trim() || null;
  return { target, url, fileName: `whisper-cli${exeSuffix}` };
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
  await new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        downloadFile(
          new URL(response.headers.location, url).toString(),
          destinationPath,
          redirectsRemaining - 1,
        ).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode ?? "unknown"} for ${url}`));
        return;
      }
      const output = createWriteStream(destinationPath, { mode: 0o644 });
      response.pipe(output);
      output.once("finish", () => output.close(resolve));
      output.once("error", reject);
    });
    request.once("error", reject);
  });
}

async function materializeModel() {
  const modelPath = path.join(whisperRoot, MODEL_BASENAME);
  if (await pathExists(modelPath)) {
    console.log(`[whisper-resources] Model already present: ${modelPath}`);
    return;
  }
  console.log(`[whisper-resources] Downloading ${MODEL_BASENAME} from ${MODEL_URL}`);
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
  try {
    await spawnStep("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      WHISPER_SRC_REF,
      WHISPER_SRC_REPO,
      srcDir,
    ]);
  } catch {
    console.warn(
      `[whisper-resources] Could not clone ref ${WHISPER_SRC_REF}; falling back to the default branch.`,
    );
    await fs.rm(srcDir, { recursive: true, force: true });
    await spawnStep("git", ["clone", "--depth", "1", WHISPER_SRC_REPO, srcDir]);
  }

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

async function materializeBinary() {
  const spec = whisperBinarySpecForHost();
  const binaryPath = path.join(whisperRoot, spec.fileName);
  if (await pathExists(binaryPath)) {
    console.log(`[whisper-resources] Binary already present: ${binaryPath}`);
    return;
  }
  if (spec.url) {
    console.log(`[whisper-resources] Downloading whisper.cpp CLI for ${spec.target} from ${spec.url}`);
    await downloadFile(spec.url, binaryPath);
    if (process.platform !== "win32") {
      await fs.chmod(binaryPath, 0o755);
    }
    console.log(`[whisper-resources] Downloaded binary -> ${binaryPath}`);
    return;
  }
  await buildBinaryFromSource(binaryPath, spec.target);
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
