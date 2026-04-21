// OpenCode binary resolution with bundled fallback
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { augmentProcessPathWithShellAndKnownCliDirs, resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";

export type OpenCodeBinarySource = "user-installed" | "bundled" | "missing";

export type OpenCodeBinaryInfo = {
  path: string | null;
  source: OpenCodeBinarySource;
};

let cachedInfo: OpenCodeBinaryInfo | null = null;

function bundledBinaryPath(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  // In packaged app, process.resourcesPath points to Resources/
  // In dev, fall back to node_modules/.bin
  const resourcesPath = (process as any).resourcesPath;
  if (resourcesPath) {
    return join(resourcesPath, `opencode${ext}`);
  }
  // Dev fallback: check node_modules
  if (typeof __dirname !== "string") {
    return join(process.cwd(), "apps", "desktop", "node_modules", ".bin", `opencode${ext}`);
  }
  return join(__dirname, "..", "..", "..", "..", "node_modules", ".bin", `opencode${ext}`);
}

export function resolveOpenCodeBinary(): OpenCodeBinaryInfo {
  if (cachedInfo) return cachedInfo;

  // Ensure PATH includes shell paths and known CLI dirs before searching
  process.env.PATH = augmentProcessPathWithShellAndKnownCliDirs({ env: process.env });

  // 1. Check user-installed binary first (PATH, ~/.opencode/bin, etc.)
  const userInstalled = resolveExecutableFromKnownLocations("opencode");
  if (userInstalled?.path) {
    cachedInfo = { path: userInstalled.path, source: "user-installed" };
    return cachedInfo;
  }

  // 2. Fall back to bundled binary
  const bundled = bundledBinaryPath();
  try {
    accessSync(bundled, constants.X_OK);
    cachedInfo = { path: bundled, source: "bundled" };
    return cachedInfo;
  } catch {
    // Bundled binary not found or not executable
  }

  cachedInfo = { path: null, source: "missing" };
  return cachedInfo;
}

export function resolveOpenCodeBinaryPath(): string | null {
  return resolveOpenCodeBinary().path;
}

export function clearOpenCodeBinaryCache(): void {
  cachedInfo = null;
}
