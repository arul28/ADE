// OpenCode binary resolution with bundled fallback
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import {
  augmentProcessPathWithShellAndKnownCliDirs,
  resolveExecutableFromKnownLocations,
  setPathEnvValue,
} from "../ai/cliExecutableResolver";

export type OpenCodeBinarySource = "user-installed" | "bundled" | "missing";

export type OpenCodeBinaryInfo = {
  path: string | null;
  source: OpenCodeBinarySource;
};

let cachedInfo: OpenCodeBinaryInfo | null = null;

function bundledBinaryCandidatePaths(): string[] {
  const fileNames = process.platform === "win32"
    ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
    : ["opencode"];
  // In packaged app, process.resourcesPath points to Resources/
  // In dev, fall back to node_modules/.bin
  const resourcesPath = (process as any).resourcesPath;
  if (resourcesPath) {
    return fileNames.map((fileName) => join(resourcesPath, fileName));
  }
  // Dev fallback: check node_modules
  if (typeof __dirname !== "string") {
    return fileNames.map((fileName) => join(process.cwd(), "apps", "desktop", "node_modules", ".bin", fileName));
  }
  return fileNames.map((fileName) => join(__dirname, "..", "..", "..", "..", "node_modules", ".bin", fileName));
}

function canRunBinaryCandidate(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveOpenCodeBinary(): OpenCodeBinaryInfo {
  if (cachedInfo?.path && canRunBinaryCandidate(cachedInfo.path)) {
    return cachedInfo;
  }
  cachedInfo = null;

  // Ensure PATH includes shell paths and known CLI dirs before searching.
  // On Windows, `process.env.PATH = …` can create a duplicate `PATH` key
  // while the inherited `Path` key remains unchanged, so later readers see
  // the stale value. setPathEnvValue collapses case-variant duplicates.
  setPathEnvValue(process.env, augmentProcessPathWithShellAndKnownCliDirs({ env: process.env }));

  // 1. Check user-installed binary first (PATH, ~/.opencode/bin, etc.)
  const userInstalled = resolveExecutableFromKnownLocations("opencode");
  if (userInstalled?.path) {
    cachedInfo = { path: userInstalled.path, source: "user-installed" };
    return cachedInfo;
  }

  // 2. Fall back to bundled binary
  const bundled = bundledBinaryCandidatePaths().find((candidate) => canRunBinaryCandidate(candidate));
  if (bundled) {
    cachedInfo = { path: bundled, source: "bundled" };
    return cachedInfo;
  }

  // Do not cache misses. Users can install OpenCode or fix PATH while ADE is
  // running, and the picker/settings cheap probe should pick that up without
  // requiring a main-process restart.
  return { path: null, source: "missing" };
}

export function resolveOpenCodeBinaryPath(): string | null {
  return resolveOpenCodeBinary().path;
}

export function clearOpenCodeBinaryCache(): void {
  cachedInfo = null;
}
