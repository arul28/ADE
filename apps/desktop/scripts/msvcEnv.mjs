import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The environment `cl.exe` builds in, for the Windows native helper builds.
 * When `cl.exe` is already on PATH (a Developer prompt, CI's MSVC setup), that
 * is `process.env`. Otherwise MSVC is imported from the newest installed
 * Build Tools: `vswhere` finds the installation and `VsDevCmd.bat` prints the
 * variables it sets. `missingMessage` names the helper the error is about.
 */
export function msvcCompilerEnv(missingMessage) {
  if (!spawnSync("cl.exe", [], { stdio: "ignore", windowsHide: true }).error) return process.env;
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", windowsHide: true }).trim();
  const devCommand = path.join(installation, "Common7", "Tools", "VsDevCmd.bat");
  if (!installation || !fs.existsSync(devCommand) || /["\r\n%]/.test(devCommand)) {
    throw new Error(missingMessage);
  }
  const environment = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"call "${devCommand}" -arch=x64 -host_arch=x64 >nul && set"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  const compilerEnv = { ...process.env };
  for (const line of environment.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals > 0) compilerEnv[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return compilerEnv;
}
