import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
if (process.env.ADE_SKIP_CAPTURE_HELPER_BUILD === "1") {
  console.log("[now-playing-win] Skipping local native helper build (ADE_SKIP_CAPTURE_HELPER_BUILD=1).");
  process.exit(0);
}
let compilerEnv = process.env;
if (spawnSync("cl.exe", [], { stdio: "ignore", windowsHide: true }).error) {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", windowsHide: true }).trim();
  const devCommand = path.join(installation, "Common7", "Tools", "VsDevCmd.bat");
  if (!installation || !fs.existsSync(devCommand) || /["\r\n%]/.test(devCommand)) {
    throw new Error("The Now Playing helper requires MSVC Build Tools and the Windows SDK.");
  }
  const environment = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"call "${devCommand}" -arch=x64 -host_arch=x64 >nul && set"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  compilerEnv = { ...process.env };
  for (const line of environment.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals > 0) compilerEnv[line.slice(0, equals)] = line.slice(equals + 1);
  }
}
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
    // The SDK's C++/WinRT predates standard coroutines; /await enables the ones it uses.
    "/nologo", "/std:c++17", "/await", "/EHsc", "/O2", "/MT", "/utf-8", "/W3", "/bigobj",
    "/DUNICODE", "/D_UNICODE", "/D_WIN32_WINNT=0x0A00", "/DWINVER=0x0A00", "/DNOMINMAX",
    `/I${cppwinrt}`,
    source, `/Fe:${temporary}`,
    "/link", "/SUBSYSTEM:CONSOLE", "windowsapp.lib", "crypt32.lib", "ole32.lib",
  ], { cwd: scratch, stdio: "inherit", windowsHide: true, env: compilerEnv });
  const output = path.join(outputRoot, "ade-now-playing.exe");
  fs.copyFileSync(temporary, `${output}.tmp`);
  fs.renameSync(`${output}.tmp`, output);
  console.log(`[now-playing-win] Built ${path.relative(desktopRoot, output)}.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
