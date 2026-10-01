import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") {
  console.log("[windows-desktop-driver] Skipping outside Windows.");
  process.exit(0);
}
// UI Automation and Media Foundation require MSVC and the Windows SDK.
// Import the installed Build Tools environment when npm runs from an ordinary
// shell (including the release runner), rather than requiring a manual prompt.
let compilerEnv = process.env;
if (spawnSync("cl.exe", [], { stdio: "ignore", windowsHide: true }).error) {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", windowsHide: true }).trim();
  const devCommand = path.join(installation, "Common7", "Tools", "VsDevCmd.bat");
  if (!installation || !fs.existsSync(devCommand) || /["\r\n%]/.test(devCommand)) {
    throw new Error("Windows Desktop requires MSVC Build Tools and the Windows SDK.");
  }
  const environment = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"call "${devCommand}" -arch=x64 -host_arch=x64 >nul && set"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  compilerEnv = { ...process.env };
  for (const line of environment.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals > 0) compilerEnv[line.slice(0, equals)] = line.slice(equals + 1);
  }
}
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
