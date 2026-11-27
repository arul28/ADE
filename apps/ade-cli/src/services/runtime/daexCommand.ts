import fs from "node:fs";
import path from "node:path";

/**
 * `daex` is the command's name and `ade` its permanent alias.
 *
 * The standalone runtime binary stays `ade` (`ade.exe`): released `ade brain
 * update`s, services and scripts replace and run it by that name. `daex` sits
 * beside it and runs it:
 *
 * - macOS/Linux: a relative symlink `daex -> ade`, so every later update of
 *   `ade` is also `daex`'s.
 * - Windows: `daex.cmd` for cmd and PowerShell and an extensionless `daex` for
 *   Git Bash (which never tries `.cmd` and keeps a multi-line argument whole),
 *   both naming `ade.exe` by their own folder. The same two files
 *   install-runtime.ps1 writes.
 *
 * A `daex` that is not one of these (someone else's file, or a symlink to
 * something other than an `ade`) is left alone.
 * Best effort: returns the paths it wrote or confirmed, and never throws, since
 * `ade` works either way.
 */
export function ensureDaexCommandBesideBinary(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const dir = path.dirname(binaryPath);
  const base = path.basename(binaryPath);
  const written: string[] = [];
  try {
    if (platform === "win32") {
      if (base.toLowerCase() !== "ade.exe") return written;
      const cmdPath = path.join(dir, "daex.cmd");
      const cmdBody = [
        "@echo off",
        "setlocal",
        "rem cmd.exe ends a command at its first line feed; the CLI reads this marker to warn.",
        'set "ADE_CLI_VIA_CMD=1"',
        '"%~dp0ade.exe" %*',
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n");
      if (writeOwned(cmdPath, cmdBody)) written.push(cmdPath);
      const shPath = path.join(dir, "daex");
      const shBody = '#!/bin/sh\nexec "$(dirname -- "$0")/ade.exe" "$@"\n';
      if (writeOwned(shPath, shBody)) written.push(shPath);
      return written;
    }
    if (base !== "ade") return written;
    const linkPath = path.join(dir, "daex");
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(linkPath);
    } catch {
      existing = null;
    }
    if (existing && !existing.isSymbolicLink()) return written;
    if (existing) {
      const target = fs.readlinkSync(linkPath);
      if (target === "ade") return [linkPath];
      // Only a link to some `ade` (or an empty one) is ours to repoint.
      if (target !== "" && path.posix.basename(target) !== "ade") return written;
      fs.rmSync(linkPath, { force: true });
    }
    fs.symlinkSync("ade", linkPath);
    written.push(linkPath);
  } catch {
    // Best effort: `ade` still works.
  }
  return written;
}

/** Write `body` unless a different file that never names ade.exe is there. */
function writeOwned(filePath: string, body: string): boolean {
  let current: string | null = null;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch {
    current = null;
  }
  if (current === body) return true;
  if (current != null && !/ade\.exe/i.test(current)) return false;
  fs.writeFileSync(filePath, body, "utf8");
  return true;
}
