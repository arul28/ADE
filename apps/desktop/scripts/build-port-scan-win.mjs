import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build `ade-port-scan.exe` (native/ADEPortScanWin/src/main.cpp): the
 * listener and process scan behind dev-server discovery on Windows, so a scan
 * no longer starts a PowerShell (see devServers/windowsPortScan.ts).
 *
 * Plain Win32 C++, no WinRT: MSVC from the installed Build Tools (imported
 * with VsDevCmd when `cl.exe` is not on PATH), output in `resources/native`,
 * shipped by the Windows `extraResources` native entry and signed with the
 * rest of the app.
 */

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") {
  console.log("[port-scan-win] Skipping outside Windows.");
  process.exit(0);
}
if (process.env.ADE_SKIP_PORT_SCAN_BUILD === "1") {
  console.log("[port-scan-win] Skipping (ADE_SKIP_PORT_SCAN_BUILD=1).");
  process.exit(0);
}
let compilerEnv = process.env;
if (spawnSync("cl.exe", [], { stdio: "ignore", windowsHide: true }).error) {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", windowsHide: true }).trim();
  const devCommand = path.join(installation, "Common7", "Tools", "VsDevCmd.bat");
  if (!installation || !fs.existsSync(devCommand) || /["\r\n%]/.test(devCommand)) {
    throw new Error("The port scan helper requires MSVC Build Tools and the Windows SDK.");
  }
  const environment = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"call "${devCommand}" -arch=x64 -host_arch=x64 >nul && set"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  compilerEnv = { ...process.env };
  for (const line of environment.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals > 0) compilerEnv[line.slice(0, equals)] = line.slice(equals + 1);
  }
}
const source = path.join(desktopRoot, "native", "ADEPortScanWin", "src", "main.cpp");
const outputRoot = path.join(desktopRoot, "resources", "native");
const scratchRoot = path.join(desktopRoot, ".ade-native-build");
fs.mkdirSync(outputRoot, { recursive: true });
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "port-scan-"));
try {
  const temporary = path.join(scratch, "ade-port-scan.exe");
  execFileSync("cl.exe", [
    "/nologo", "/std:c++17", "/EHsc", "/O2", "/MT", "/utf-8", "/W3",
    "/DUNICODE", "/D_UNICODE", "/D_WIN32_WINNT=0x0A00", "/DWINVER=0x0A00", "/DNOMINMAX",
    source, `/Fe:${temporary}`,
    "/link", "/SUBSYSTEM:CONSOLE", "kernel32.lib", "iphlpapi.lib", "ws2_32.lib",
  ], { cwd: scratch, stdio: "inherit", windowsHide: true, env: compilerEnv });
  const output = path.join(outputRoot, "ade-port-scan.exe");
  fs.copyFileSync(temporary, `${output}.tmp`);
  fs.renameSync(`${output}.tmp`, output);
  console.log(`[port-scan-win] Built ${path.relative(desktopRoot, output)}.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
