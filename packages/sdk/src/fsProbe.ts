/**
 * "Does this path exist, and is it the kind of thing I expect?"
 *
 * One copy, because `binary.ts` and `bundledRuntime.ts` both ask it on every
 * resolution and had grown a byte-identical pair each. Missing, unreadable and
 * wrong-kind are all simply "no": a resolution step that cannot see a candidate
 * falls through to the next one rather than throwing at a caller who has other
 * routes left to try.
 */

import fs from "node:fs";
import path from "node:path";

export function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The runtime's command names, preferred first. The CLI is `daex` since the
 * Daex rename and installs `ade` beside it as a permanent alias; a runtime
 * built before the rename has only `ade`. Every lookup tries `daex` first and
 * falls back to `ade`, so either install works.
 */
export const RUNTIME_COMMANDS = ["daex", "ade"] as const;

/**
 * The first runtime binary that exists in `dir` (`daex`, then `ade`; with
 * `.exe` on Windows). When neither exists it returns the `ade` path, so a
 * caller's "no binary at <path>" message names the file older packages carry.
 */
export function runtimeBinaryIn(
  dir: string,
  platform: NodeJS.Platform,
  fileExists: (candidate: string) => boolean = isFile,
): { binaryPath: string; found: boolean } {
  const extension = platform === "win32" ? ".exe" : "";
  for (const command of RUNTIME_COMMANDS) {
    const candidate = path.join(dir, `${command}${extension}`);
    if (fileExists(candidate)) return { binaryPath: candidate, found: true };
  }
  return { binaryPath: path.join(dir, `ade${extension}`), found: false };
}
