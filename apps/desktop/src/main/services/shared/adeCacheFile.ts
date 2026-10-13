import os from "node:os";
import path from "node:path";

type ElectronLikeApp = { app?: { getPath(name: string): string } };

/**
 * Where a machine-local cache file lives: Electron's `userData` inside the
 * desktop app, else this install's ADE home (`ADE_HOME`, so Stable and Beta
 * brains never share one file), else `~/.ade`.
 */
export function resolveAdeCacheFile(fileName: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as ElectronLikeApp;
    const userDataPath = electron.app?.getPath?.("userData");
    if (typeof userDataPath === "string" && userDataPath.trim().length > 0) {
      return path.resolve(userDataPath, fileName);
    }
  } catch {
    // Not running inside Electron (the brain, the CLI, unit tests).
  }
  const adeHome = process.env.ADE_HOME?.trim();
  if (adeHome) return path.resolve(adeHome, fileName);
  const homeDir = os.homedir().trim();
  return path.resolve(homeDir.length > 0 ? path.resolve(homeDir, ".ade") : os.tmpdir(), fileName);
}
