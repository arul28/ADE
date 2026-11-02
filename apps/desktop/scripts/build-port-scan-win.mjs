import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { msvcCompilerEnv } from "./msvcEnv.mjs";

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
const compilerEnv = msvcCompilerEnv("The port scan helper requires MSVC Build Tools and the Windows SDK.");
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
