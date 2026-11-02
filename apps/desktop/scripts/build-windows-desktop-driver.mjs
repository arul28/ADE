import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { msvcCompilerEnv } from "./msvcEnv.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") {
  console.log("[windows-desktop-driver] Skipping outside Windows.");
  process.exit(0);
}
if (process.env.ADE_SKIP_CAPTURE_HELPER_BUILD === "1") {
  console.log("[windows-desktop-driver] Skipping local native helper build (ADE_SKIP_CAPTURE_HELPER_BUILD=1).");
  process.exit(0);
}
// UI Automation and Media Foundation require MSVC and the Windows SDK.
// Import the installed Build Tools environment when npm runs from an ordinary
// shell (including the release runner), rather than requiring a manual prompt.
const compilerEnv = msvcCompilerEnv("Windows Desktop requires MSVC Build Tools and the Windows SDK.");
const sourceRoot = path.join(desktopRoot, "native", "ADEDesktopDriverWin", "src");
const outputRoot = path.join(desktopRoot, "resources", "native");
const scratchRoot = path.join(desktopRoot, ".ade-native-build");
fs.mkdirSync(outputRoot, { recursive: true });
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "windows-screen-"));
try {
  const temporary = path.join(scratch, "ade-desktop-driver.exe");
  const sources = fs.readdirSync(sourceRoot).filter((file) => file.endsWith(".cpp")).sort();
  execFileSync("cl.exe", [
    "/nologo", "/std:c++17", "/EHsc", "/O2", "/MT", "/utf-8", "/W4",
    "/DUNICODE", "/D_UNICODE", "/D_WIN32_WINNT=0x0A00", "/DWINVER=0x0A00",
    ...sources.map((file) => path.join(sourceRoot, file)), `/Fe:${temporary}`,
    "/link", "/SUBSYSTEM:CONSOLE",
    "user32.lib", "gdi32.lib", "dwmapi.lib", "shell32.lib", "ole32.lib",
    "oleaut32.lib", "advapi32.lib", "credui.lib", "secur32.lib", "wtsapi32.lib", "windowscodecs.lib",
    "uiautomationcore.lib", "mfplat.lib", "mfreadwrite.lib", "mfuuid.lib",
    "wmcodecdspuuid.lib", "strmiids.lib", "ws2_32.lib", "uuid.lib", "version.lib",
  ], { cwd: scratch, stdio: "inherit", windowsHide: true, env: compilerEnv });
  const output = path.join(outputRoot, "ade-desktop-driver.exe");
  fs.copyFileSync(temporary, `${output}.tmp`);
  fs.renameSync(`${output}.tmp`, output);
  console.log(`[windows-desktop-driver] Built ${path.relative(desktopRoot, output)}.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
