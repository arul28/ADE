import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUniversalSwiftProduct, exitIfCachedHelper } from "./native-helper-cache.mjs";

/**
 * Build the macOS Apple Music host (`resources/native/ade-music-host/`).
 *
 * The host is a Swift WKWebView program (`native/ADEMusicHostMac`) that runs
 * the same player page as the Windows host, so the page is copied from
 * `native/ADEMusicHostWin/page`. Output, shipped by the mac `extraResources`
 * entry and signed by electron-builder's pass over Contents/Resources:
 *   ade-music-host/ade-music-host          (universal)
 *   ade-music-host/page/index.html, player.js, ade-icon.png
 *   ade-music-host/page-spotify/index.html, player.js     (Spotify)
 *
 * The page is copied before the release cache check: the cache holds only the
 * binary. The Windows half is `build-music-host-win.mjs`.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageRoot = path.join(desktopRoot, "native", "ADEMusicHostMac");
const pageSource = path.join(desktopRoot, "native", "ADEMusicHostWin", "page");
// Spotify's Web Playback SDK page, run by the same host with its own profile.
const spotifyPageSource = path.join(desktopRoot, "native", "ADEMusicHostWin", "page-spotify");
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
fs.rmSync(path.join(outputDir, "page-spotify"), { recursive: true, force: true });
fs.cpSync(spotifyPageSource, path.join(outputDir, "page-spotify"), { recursive: true });

exitIfCachedHelper(outputPath);

// macOS 12, below ADE's own minimum (13): the host must launch wherever ADE does to say that Apple
// Music needs macOS 14 (it reports `unsupported_os`). Keep this in step with
// `platforms:` in native/ADEMusicHostMac/Package.swift.
buildUniversalSwiftProduct({
  packageRoot,
  product: "ade-music-host",
  outputPath,
  archsEnv: "ADE_MUSIC_HOST_ARCHS",
  tag: "music-host-mac",
  macosVersion: "12.0",
});
