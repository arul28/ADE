import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the macOS half of the global capture helper.
 *
 * Modelled on `build-attention-notch.mjs` down to the arch list, the scratch
 * paths and the `lipo` fold — including the skip-off-platform guard, which is
 * what lets `dist:win` run this script on a Windows box without failing. The
 * Windows half is `build-capture-helper-win.mjs`; neither can cross-compile the
 * other, so both are wired into their own platform's dist script.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(desktopRoot, "native", "ADECaptureHelper");
const outputRoot = path.join(desktopRoot, "resources", "native");
const outputPath = path.join(outputRoot, "ade-capture-helper");

if (process.platform !== "darwin") {
  console.log("[capture-helper] Skipping macOS capture helper build outside macOS.");
  process.exit(0);
}

if (process.env.ADE_SKIP_CAPTURE_HELPER_BUILD === "1") {
  console.log("[capture-helper] Skipping macOS capture helper build (ADE_SKIP_CAPTURE_HELPER_BUILD=1).");
  process.exit(0);
}

const requestedArchs = String(process.env.ADE_CAPTURE_HELPER_ARCHS || "arm64,x86_64")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value === "arm64" || value === "x86_64");

if (requestedArchs.length === 0) {
  throw new Error("ADE_CAPTURE_HELPER_ARCHS must include arm64 and/or x86_64");
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
    "--product", "ade-capture-helper",
  ];
  console.log(`[capture-helper] Building ${arch} helper.`);
  execFileSync("swift", baseArgs, { stdio: "inherit" });
  const binPath = execFileSync("swift", [...baseArgs, "--show-bin-path"], {
    encoding: "utf8",
  }).trim();
  const binaryPath = path.join(binPath, "ade-capture-helper");
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Swift build did not produce ${binaryPath}`);
  }
  builtBinaries.push(binaryPath);
}

// Write to a scratch name and rename into place: a half-copied binary at the
// final path is one electron-builder would happily ship.
const temporaryOutput = path.join(
  outputRoot,
  `.ade-capture-helper.${process.pid}.${Date.now()}`,
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
  `[capture-helper] Materialized ${path.relative(desktopRoot, outputPath)} (${architectures}, ${os.platform()}).`,
);
