import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exitIfCachedHelper } from "./native-helper-cache.mjs";

/**
 * Build the macOS Apple Music host (`resources/native/ade-music-host/`).
 *
 * The host is a Swift WKWebView program (`native/ADEMusicHostMac`) that runs
 * the same player page as the Windows host, so the page is copied from
 * `native/ADEMusicHostWin/page`. Output, shipped by the mac `extraResources`
 * entry and signed by electron-builder's pass over Contents/Resources:
 *   ade-music-host/ade-music-host          (universal)
 *   ade-music-host/page/index.html, player.js, ade-icon.png
 *
 * The page is copied before the release cache check: the cache holds only the
 * binary. The Windows half is `build-music-host-win.mjs`.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(desktopRoot, "native", "ADEMusicHostMac");
const pageSource = path.join(desktopRoot, "native", "ADEMusicHostWin", "page");
const outputDir = path.join(desktopRoot, "resources", "native", "ade-music-host");
const outputPath = path.join(outputDir, "ade-music-host");

if (process.platform !== "darwin") {
  console.log("[music-host-mac] Skipping outside macOS.");
  process.exit(0);
}
if (process.env.ADE_SKIP_MUSIC_HOST_BUILD === "1") {
  console.log("[music-host-mac] Skipping (ADE_SKIP_MUSIC_HOST_BUILD=1).");
  process.exit(0);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(path.join(outputDir, "page"), { recursive: true, force: true });
fs.cpSync(pageSource, path.join(outputDir, "page"), { recursive: true });

exitIfCachedHelper(outputPath);

const requestedArchs = String(process.env.ADE_MUSIC_HOST_ARCHS || "arm64,x86_64")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value === "arm64" || value === "x86_64");

if (requestedArchs.length === 0) {
  throw new Error("ADE_MUSIC_HOST_ARCHS must include arm64 and/or x86_64");
}

const builtBinaries = [];
for (const arch of requestedArchs) {
  const baseArgs = [
    "build",
    "--package-path", packageRoot,
    "--scratch-path", path.join(packageRoot, `.build-${arch}`),
    "--configuration", "release",
    "--triple", `${arch}-apple-macosx13.0`,
    "--product", "ade-music-host",
  ];
  console.log(`[music-host-mac] Building ${arch} host.`);
  execFileSync("swift", baseArgs, { stdio: "inherit" });
  const binPath = execFileSync("swift", [...baseArgs, "--show-bin-path"], { encoding: "utf8" }).trim();
  const binaryPath = path.join(binPath, "ade-music-host");
  if (!fs.existsSync(binaryPath)) throw new Error(`Swift build did not produce ${binaryPath}`);
  builtBinaries.push(binaryPath);
}

// Write to a scratch name and rename into place: a half-copied binary at the
// final path is one electron-builder would happily ship.
const temporaryOutput = path.join(outputDir, `.ade-music-host.${process.pid}.${Date.now()}`);
try {
  if (builtBinaries.length === 1) {
    fs.copyFileSync(builtBinaries[0], temporaryOutput);
  } else {
    execFileSync("lipo", ["-create", ...builtBinaries, "-output", temporaryOutput], { stdio: "inherit" });
  }
  fs.chmodSync(temporaryOutput, 0o755);
  fs.renameSync(temporaryOutput, outputPath);
} finally {
  fs.rmSync(temporaryOutput, { force: true });
}

const architectures = execFileSync("lipo", ["-archs", outputPath], { encoding: "utf8" }).trim();
console.log(`[music-host-mac] Materialized ${path.relative(desktopRoot, outputDir)} (${architectures}).`);
