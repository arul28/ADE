import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { msvcCompilerEnv } from "./msvcEnv.mjs";

/**
 * Build `ade-now-playing.exe`, the Windows Now Playing helper: a small
 * C++/WinRT program that reads the Global System Media Transport Controls
 * and streams NDJSON (see native/ADENowPlayingWin/src/main.cpp).
 *
 * Same toolchain and placement as the Windows Desktop driver: MSVC from the
 * installed Build Tools (imported with VsDevCmd when `cl.exe` is not on
 * PATH), C++/WinRT headers from the Windows SDK, output in
 * `resources/native`, shipped by the same `extraResources` entry.
 */

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") {
  console.log("[now-playing-win] Skipping outside Windows.");
  process.exit(0);
}
if (process.env.ADE_SKIP_NOW_PLAYING_BUILD === "1") {
  console.log("[now-playing-win] Skipping (ADE_SKIP_NOW_PLAYING_BUILD=1).");
  process.exit(0);
}
const compilerEnv = msvcCompilerEnv("The Now Playing helper requires MSVC Build Tools and the Windows SDK.");
// C++/WinRT's projection headers live beside the SDK's other include folders.
const sdkDir = compilerEnv.WindowsSdkDir;
const sdkVersion = (compilerEnv.WindowsSDKVersion ?? compilerEnv.WindowsSDKLibVersion ?? "").replace(/\$/, "");
const cppwinrt = sdkDir && sdkVersion ? path.join(sdkDir, "Include", sdkVersion, "cppwinrt") : null;
if (!cppwinrt || !fs.existsSync(path.join(cppwinrt, "winrt", "Windows.Media.Control.h"))) {
  throw new Error(`C++/WinRT headers not found in the Windows SDK (${cppwinrt ?? "no SDK"}).`);
}
const source = path.join(desktopRoot, "native", "ADENowPlayingWin", "src", "main.cpp");
const outputRoot = path.join(desktopRoot, "resources", "native");
const scratchRoot = path.join(desktopRoot, ".ade-native-build");
fs.mkdirSync(outputRoot, { recursive: true });
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "now-playing-"));
try {
  const temporary = path.join(scratch, "ade-now-playing.exe");
  execFileSync("cl.exe", [
    // C++20 gives C++/WinRT standard coroutines; MSVC 14.51+ rejects the old /await ones.
    "/nologo", "/std:c++20", "/EHsc", "/O2", "/MT", "/utf-8", "/W3", "/bigobj",
    "/DUNICODE", "/D_UNICODE", "/D_WIN32_WINNT=0x0A00", "/DWINVER=0x0A00", "/DNOMINMAX",
    `/I${cppwinrt}`,
    source, `/Fe:${temporary}`,
    "/link", "/SUBSYSTEM:CONSOLE", "windowsapp.lib", "crypt32.lib", "ole32.lib", "shell32.lib", "windowscodecs.lib", "gdi32.lib",
  ], { cwd: scratch, stdio: "inherit", windowsHide: true, env: compilerEnv });
  const output = path.join(outputRoot, "ade-now-playing.exe");
  fs.copyFileSync(temporary, `${output}.tmp`);
  fs.renameSync(`${output}.tmp`, output);
  console.log(`[now-playing-win] Built ${path.relative(desktopRoot, output)}.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
