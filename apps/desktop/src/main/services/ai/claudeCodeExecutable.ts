import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { captureError } from "../../../shared/sentry/capture";
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

type ClaudeBinaryLookupArgs = {
  resourcesPath?: string | null;
  platform?: NodeJS.Platform;
  arch?: string;
  packageResolver?: (specifier: string) => string;
};

/** The platform package's name and binary file name for this host, or null when Claude ships none. */
function claudeNativeBinaryCoordinates(args?: ClaudeBinaryLookupArgs): { packageName: string; binaryName: string; arch: string } | null {
  const platform = args?.platform ?? process.platform;
  const arch = args?.arch ?? process.arch;
  const packageName = getClaudeNativeBinaryPackageName(platform, arch);
  return packageName ? { packageName, binaryName: getClaudeNativeBinaryFileName(platform), arch } : null;
}

/** The copy a packaged app ships unpacked next to its asar. */
function resolvePackagedClaudeBinary(args?: ClaudeBinaryLookupArgs): string | null {
  const coordinates = claudeNativeBinaryCoordinates(args);
  if (!coordinates) return null;
  const { packageName, binaryName, arch } = coordinates;
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
    if (!packagedNodeModule) return null;
    const binaryPath = path.join(path.dirname(packageJsonPath), binaryName);
    return isExecutablePath(binaryPath) ? binaryPath : null;
  } catch {
    return null;
  }
}

/**
 * ADE's own `node_modules` copy, resolved from this module rather than the
 * working directory: in a source checkout it is the version ADE's lockfile
 * pins, while a working directory can be any project, with a copy of its own.
 */
function resolveOwnInstallClaudeBinary(args?: ClaudeBinaryLookupArgs): string | null {
  const coordinates = claudeNativeBinaryCoordinates(args);
  // ESM (`tsx` running the CLI from source) has no `__filename`; the script
  // it runs is ADE's own too.
  const script = process.argv[1];
  const fromFile = typeof __filename === "string" ? __filename : script && path.isAbsolute(script) ? script : null;
  if (!coordinates || !fromFile) return null;
  try {
    const packageJsonPath = createRequire(fromFile).resolve(`${coordinates.packageName}/package.json`);
    const binaryPath = path.join(path.dirname(packageJsonPath), coordinates.binaryName);
    return isExecutablePath(binaryPath) ? binaryPath : null;
  } catch (error) {
    // Not installed (a packaged app ships no platform package) is the ordinary miss.
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
      captureError(error, {
        tags: { area: "claude-executable" },
        fingerprint: ["claude-executable", "own-install-lookup"],
      });
    }
    return null;
  }
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

  const bundledPath = resolvePackagedClaudeBinary(args) ?? resolveOwnInstallClaudeBinary(args);
  if (bundledPath) {
    return { path: bundledPath, source: "bundled" };
  }

  // Just after an ADE update the new pin can still be downloading. ADE's
  // previous copy, which the cache keeps for this, beats the machine's own
  // `claude`: that one can be any version, and ADE delivers its plugins only
  // to its own copies.
  const previousPath = previousCachedToolEntryPath("claude-code", { env, platform: args?.platform, arch: args?.arch });
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
