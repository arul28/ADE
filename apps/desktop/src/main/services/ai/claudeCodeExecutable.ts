import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { captureError } from "../../../shared/sentry/capture";
import type { DetectedAuth } from "./authDetector";
import { cachedToolEntryPath, previousCachedToolEntryPath } from "../../../../../ade-cli/src/services/tools/cacheLookup";
import { resolveActiveToolVersionOverride } from "../../../../../ade-cli/src/services/tools/overrides";
import {
  getClaudeNativeBinaryFileName,
  getClaudeNativeBinaryPackageName,
} from "../../packagedRuntimeSmokeShared";

/**
 * Where ADE's Claude Code binary is. `fallback-command` means ADE has no copy
 * on this machine (`path` is empty): the caller downloads it or reports why,
 * and never spawns a `claude` from the PATH. `auth`, `path` and `common-dir`
 * are no longer produced; they stay in the union for callers that name them.
 */
export type ClaudeCodeExecutableResolution = {
  path: string;
  source: "env" | "tools-cache" | "bundled" | "auth" | "path" | "common-dir" | "fallback-command";
  /**
   * Set when this is the newer, untested build ADE moved to because Anthropic
   * refused the pin as too old (`claudeFallForward.ts`). Still ADE's own,
   * verified copy in the tools cache (`source` is `tools-cache`).
   */
  fallForward?: {
    pinnedVersion: string;
    overrideVersion: string;
    claudeCodeVersion: string | null;
    rejectedClaudeCodeVersion: string | null;
  };
};

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

/**
 * ADE's own Claude Code: the dev/test override, the newer build ADE moved to
 * after Anthropic refused the current pin as too old (only while that pin is
 * still the manifest's and the build's install is complete, so an ADE update
 * that moves the pin ends it), the current pin in the tools cache, the copy
 * ADE's lockfile put in `node_modules` (a source checkout, or an older build
 * that shipped it), then the previous pin while a new one downloads. Never
 * the user's `claude`: that can be any version, and ADE delivers its plugins
 * only to its own copies.
 *
 * `auth` is accepted for call-site compatibility and ignored.
 */
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

  const cacheContext = { env, platform: args?.platform, arch: args?.arch };
  const forced = resolveActiveToolVersionOverride("claude-code", cacheContext);
  if (forced && isExecutablePath(forced.resolution.entryPath)) {
    return {
      path: forced.resolution.entryPath,
      source: "tools-cache",
      fallForward: {
        pinnedVersion: forced.override.pinnedVersion,
        overrideVersion: forced.override.overrideVersion,
        claudeCodeVersion: forced.override.overrideToolVersion,
        rejectedClaudeCodeVersion: forced.override.rejectedToolVersion,
      },
    };
  }

  const cachedPath = cachedToolEntryPath("claude-code", cacheContext);
  if (cachedPath && isExecutablePath(cachedPath)) {
    return { path: cachedPath, source: "tools-cache" };
  }

  const bundledPath = resolvePackagedClaudeBinary(args) ?? resolveOwnInstallClaudeBinary(args);
  if (bundledPath) {
    return { path: bundledPath, source: "bundled" };
  }

  // Just after an ADE update the new pin can still be downloading; the cache
  // keeps ADE's previous copy for exactly this.
  const previousPath = previousCachedToolEntryPath("claude-code", cacheContext);
  if (previousPath && isExecutablePath(previousPath)) {
    return { path: previousPath, source: "tools-cache" };
  }

  return { path: "", source: "fallback-command" };
}
