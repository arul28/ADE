import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `ade-media`, the macOS demo-video engine (analyze + render), built the way
// the Mac Desktop driver is: a universal binary in resources/native,
// materialized before electron-builder runs and shipped by the same
// `resources/native` extraResources entry. There is no Windows half: the
// chromium engine renders demos off macOS.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(desktopRoot, "native", "ADEMedia");
const outputRoot = path.join(desktopRoot, "resources", "native");
const outputPath = path.join(outputRoot, "ade-media");

if (process.platform !== "darwin") {
  console.log("[ade-media] Skipping the demo engine build outside macOS.");
  process.exit(0);
}

if (process.env.ADE_SKIP_ADE_MEDIA_BUILD === "1") {
  console.log("[ade-media] Skipping the demo engine build (ADE_SKIP_ADE_MEDIA_BUILD=1).");
  process.exit(0);
}

const requestedArchs = String(process.env.ADE_MEDIA_ARCHS || "arm64,x86_64")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value === "arm64" || value === "x86_64");

if (requestedArchs.length === 0) {
  throw new Error("ADE_MEDIA_ARCHS must include arm64 and/or x86_64");
}

fs.mkdirSync(outputRoot, { recursive: true });
const builtBinaries = [];

for (const arch of requestedArchs) {
  const triple = `${arch}-apple-macosx13.0`;
  const scratchPath = path.join(packageRoot, `.build-${arch}`);
  const baseArgs = [
    "build",
    "--package-path", packageRoot,
    "--scratch-path", scratchPath,
    "--configuration", "release",
    "--triple", triple,
    "--product", "ade-media",
  ];
  console.log(`[ade-media] Building ${arch} engine.`);
  execFileSync("swift", baseArgs, { stdio: "inherit" });
  const binPath = execFileSync("swift", [...baseArgs, "--show-bin-path"], {
    encoding: "utf8",
  }).trim();
  const binaryPath = path.join(binPath, "ade-media");
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Swift build did not produce ${binaryPath}`);
  }
  builtBinaries.push(binaryPath);
}

const temporaryOutput = path.join(
  outputRoot,
  `.ade-media.${process.pid}.${Date.now()}`,
);

try {
  if (builtBinaries.length === 1) {
    fs.copyFileSync(builtBinaries[0], temporaryOutput);
  } else {
    execFileSync("lipo", ["-create", ...builtBinaries, "-output", temporaryOutput], {
      stdio: "inherit",
    });
  }
  fs.chmodSync(temporaryOutput, 0o755);
  fs.renameSync(temporaryOutput, outputPath);
} finally {
  fs.rmSync(temporaryOutput, { force: true });
}

const architectures = execFileSync("lipo", ["-archs", outputPath], {
  encoding: "utf8",
}).trim();
console.log(
  `[ade-media] Materialized ${path.relative(desktopRoot, outputPath)} (${architectures}, ${os.platform()}).`,
);
