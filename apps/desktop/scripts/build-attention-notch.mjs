import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(desktopRoot, "native", "ADEAttentionNotch");
const outputRoot = path.join(desktopRoot, "resources", "native");
const outputPath = path.join(outputRoot, "ade-attention-notch");
const resourceBundleName = "ADEAttentionNotch_ADEAttentionNotch.bundle";
const outputResourceBundlePath = path.join(outputRoot, resourceBundleName);

if (process.platform !== "darwin") {
  console.log("[attention-notch] Skipping native helper build outside macOS.");
  process.exit(0);
}

if (process.env.ADE_SKIP_ATTENTION_NOTCH_BUILD === "1") {
  console.log("[attention-notch] Skipping native helper build (ADE_SKIP_ATTENTION_NOTCH_BUILD=1).");
  process.exit(0);
}

const requestedArchs = String(process.env.ADE_ATTENTION_NOTCH_ARCHS || "arm64,x86_64")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value === "arm64" || value === "x86_64");

if (requestedArchs.length === 0) {
  throw new Error("ADE_ATTENTION_NOTCH_ARCHS must include arm64 and/or x86_64");
}

fs.mkdirSync(outputRoot, { recursive: true });
const builtBinaries = [];
const builtResourceBundles = [];

for (const arch of requestedArchs) {
  const triple = `${arch}-apple-macosx13.0`;
  const scratchPath = path.join(packageRoot, `.build-${arch}`);
  const baseArgs = [
    "build",
    "--package-path", packageRoot,
    "--scratch-path", scratchPath,
    "--configuration", "release",
    "--triple", triple,
    "--product", "ade-attention-notch",
  ];
  console.log(`[attention-notch] Building ${arch} helper.`);
  execFileSync("swift", baseArgs, { stdio: "inherit" });
  const binPath = execFileSync("swift", [...baseArgs, "--show-bin-path"], {
    encoding: "utf8",
  }).trim();
  const binaryPath = path.join(binPath, "ade-attention-notch");
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Swift build did not produce ${binaryPath}`);
  }
  const resourceBundlePath = path.join(binPath, resourceBundleName);
  if (!fs.existsSync(resourceBundlePath)) {
    throw new Error(`Swift build did not produce ${resourceBundlePath}`);
  }
  builtBinaries.push(binaryPath);
  builtResourceBundles.push(resourceBundlePath);
}

const temporaryOutput = path.join(
  outputRoot,
  `.ade-attention-notch.${process.pid}.${Date.now()}`,
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
  fs.rmSync(outputResourceBundlePath, { force: true, recursive: true });
  fs.cpSync(builtResourceBundles[0], outputResourceBundlePath, { recursive: true });
} finally {
  fs.rmSync(temporaryOutput, { force: true });
}

const architectures = execFileSync("lipo", ["-archs", outputPath], {
  encoding: "utf8",
}).trim();
console.log(
  `[attention-notch] Materialized ${path.relative(desktopRoot, outputPath)} and ${resourceBundleName} (${architectures}, ${os.platform()}).`,
);
