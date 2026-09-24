import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Mac Desktop native helper, built exactly the way the attention notch
// helper is: a universal binary in resources/native, materialized before
// electron-builder runs, so the packaged app carries one file per helper and
// both are signed by the same pass over Contents/Resources/native.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(desktopRoot, "native", "ADEDesktopDriver");
const outputRoot = path.join(desktopRoot, "resources", "native");
const outputPath = path.join(outputRoot, "ade-desktop-driver");

if (process.platform !== "darwin") {
  console.log("[desktop-driver] Skipping native helper build outside macOS.");
  process.exit(0);
}

if (process.env.ADE_SKIP_DESKTOP_DRIVER_BUILD === "1") {
  console.log("[desktop-driver] Skipping native helper build (ADE_SKIP_DESKTOP_DRIVER_BUILD=1).");
  process.exit(0);
}

const requestedArchs = String(process.env.ADE_DESKTOP_DRIVER_ARCHS || "arm64,x86_64")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value === "arm64" || value === "x86_64");

if (requestedArchs.length === 0) {
  throw new Error("ADE_DESKTOP_DRIVER_ARCHS must include arm64 and/or x86_64");
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
    "--product", "ade-desktop-driver",
  ];
  console.log(`[desktop-driver] Building ${arch} helper.`);
  execFileSync("swift", baseArgs, { stdio: "inherit" });
  const binPath = execFileSync("swift", [...baseArgs, "--show-bin-path"], {
    encoding: "utf8",
  }).trim();
  const binaryPath = path.join(binPath, "ade-desktop-driver");
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Swift build did not produce ${binaryPath}`);
  }
  builtBinaries.push(binaryPath);
}

const temporaryOutput = path.join(
  outputRoot,
  `.ade-desktop-driver.${process.pid}.${Date.now()}`,
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
  `[desktop-driver] Materialized ${path.relative(desktopRoot, outputPath)} (${architectures}, ${os.platform()}).`,
);
