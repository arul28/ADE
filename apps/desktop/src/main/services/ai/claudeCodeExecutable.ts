import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DetectedAuth } from "./authDetector";
import { cachedToolEntryPath, previousCachedToolEntryPath } from "../../../../../ade-cli/src/services/tools/cacheLookup";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";
import {
  getClaudeNativeBinaryFileName,
  getClaudeNativeBinaryPackageName,
} from "../../packagedRuntimeSmokeShared";

export type ClaudeCodeExecutableResolution = {
  path: string;
  source: "env" | "tools-cache" | "bundled" | "auth" | "path" | "common-dir" | "fallback-command";
};

function findClaudeAuthPath(auth?: DetectedAuth[]): string | null {
  for (const entry of auth ?? []) {
    if (entry.type !== "cli-subscription" || entry.cli !== "claude") continue;
    const candidate = entry.path.trim();
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

export function isExecutablePath(candidatePath: string): boolean {
  try {
    const stat = fs.statSync(candidatePath);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function scopedPackagePath(packageName: string): string[] {
  return packageName.split("/").filter(Boolean);
}

function resolvePackageFromRuntimeRoots(specifier: string): string {
  const roots = new Set([
    process.cwd(),
    path.resolve(process.cwd(), "apps", "desktop"),
    path.resolve(process.cwd(), "..", "desktop"),
    path.resolve(process.cwd(), "..", "..", "apps", "desktop"),
  ]);
  let lastError: unknown = null;
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "package.json")).resolve(specifier);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Unable to resolve ${specifier}`);
}

/**
 * ADE's own `node_modules` copy, resolved from this module rather than the
 * working directory. In a source checkout it is the version ADE's lockfile
 * pins; a working directory can be any project, with a copy of its own.
 */
function resolveOwnInstallPackage(specifier: string): string | null {
  if (typeof __filename !== "string") return null;
  try {
    return createRequire(__filename).resolve(specifier);
  } catch {
    return null;
  }
}

function resolveBundledClaudeCodeExecutable(args?: {
  resourcesPath?: string | null;
  platform?: NodeJS.Platform;
  arch?: string;
  packageResolver?: (specifier: string) => string;
}): string | null {
  const platform = args?.platform ?? process.platform;
  const arch = args?.arch ?? process.arch;
  const packageName = getClaudeNativeBinaryPackageName(platform, arch);
  if (!packageName) return null;

  const binaryName = getClaudeNativeBinaryFileName(platform);
  const resourcesPath = args?.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? null;
  const packageParts = scopedPackagePath(packageName);
  const candidates: string[] = [];

  if (resourcesPath) {
    for (const unpackedName of ["app.asar.unpacked", `app-${arch}.asar.unpacked`]) {
      candidates.push(path.join(resourcesPath, unpackedName, "node_modules", ...packageParts, binaryName));
    }
  }

  for (const candidate of candidates) {
    if (isExecutablePath(candidate)) return candidate;
  }

  try {
    const resolvePackage = args?.packageResolver ?? resolvePackageFromRuntimeRoots;
    const packageJsonPath = resolvePackage(`${packageName}/package.json`);
    const normalized = path.normalize(packageJsonPath);
    const packagedNodeModule = normalized.includes(`${path.sep}app.asar.unpacked${path.sep}`)
      || normalized.includes(`${path.sep}app-${arch}.asar.unpacked${path.sep}`);
    const binaryPath = path.join(path.dirname(packageJsonPath), binaryName);
    if (packagedNodeModule && isExecutablePath(binaryPath)) return binaryPath;
  } catch {
    // Not resolvable from the working directory.
  }
  // A source checkout has no packaged copy; ADE's own install does.
  const ownPackageJsonPath = resolveOwnInstallPackage(`${packageName}/package.json`);
  if (!ownPackageJsonPath) return null;
  const ownBinaryPath = path.join(path.dirname(ownPackageJsonPath), binaryName);
  return isExecutablePath(ownBinaryPath) ? ownBinaryPath : null;
}

export function resolveClaudeCodeExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string | null;
  platform?: NodeJS.Platform;
  arch?: string;
  packageResolver?: (specifier: string) => string;
}): ClaudeCodeExecutableResolution {
  const env = args?.env ?? process.env;
  const envPath = env.CLAUDE_CODE_EXECUTABLE_PATH?.trim();
  if (envPath) {
    return { path: envPath, source: "env" };
  }

  // The pinned tools cache is the packaged app's real source for this binary:
  // the platform packages are no longer bundled, the brain fetches them on
  // first run, and both processes reach them through this one lookup. A miss
  // (dev checkout, pre-fetch, or a target the manifest does not pin) falls
  // through to the bundled copy, so a source checkout keeps working untouched.
  const cachedPath = cachedToolEntryPath("claude-code", {
    env,
    platform: args?.platform,
    arch: args?.arch,
  });
  if (cachedPath && isExecutablePath(cachedPath)) {
    return { path: cachedPath, source: "tools-cache" };
  }

  const bundledPath = resolveBundledClaudeCodeExecutable(args);
  if (bundledPath) {
    return { path: bundledPath, source: "bundled" };
  }

  // Just after an ADE update the new pin can still be downloading. ADE's
  // previous copy, which the cache keeps for this, beats the machine's own
  // `claude`: that one can be any version, and ADE delivers its plugins only
  // to its own copies.
  const previousPath = previousCachedToolEntryPath("claude-code", {
    env,
    platform: args?.platform,
    arch: args?.arch,
  });
  if (previousPath && isExecutablePath(previousPath)) {
    return { path: previousPath, source: "tools-cache" };
  }

  const authPath = findClaudeAuthPath(args?.auth);
  if (authPath) {
    return { path: authPath, source: "auth" };
  }

  const resolved = resolveExecutableFromKnownLocations("claude", env);
  if (resolved) {
    return {
      path: resolved.path,
      source: resolved.source === "path" ? "path" : "common-dir",
    };
  }

  return { path: "claude", source: "fallback-command" };
}
