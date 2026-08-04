import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolError } from "./errors";

export const TOOL_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
] as const;

export type ToolTarget = (typeof TOOL_TARGETS)[number];

/**
 * Written into the version directory as the last step of an install, so a
 * directory that exists but lacks the sentinel is never treated as usable.
 * The rename into place is already atomic; the sentinel is the second belt for
 * any future path that populates the directory without one (a copy, a restore
 * from backup, a half-finished manual fix).
 */
export const TOOL_INSTALL_SENTINEL = ".install-complete";

const STAGING_DIR_NAME = ".staging";
const LOCK_DIR_NAME = ".locks";

export function isToolTarget(value: string): value is ToolTarget {
  return (TOOL_TARGETS as readonly string[]).includes(value);
}

export function normalizeToolArch(arch: string): "arm64" | "x64" | null {
  const normalized = arch.trim().toLowerCase();
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  if (normalized === "x64" || normalized === "x86_64" || normalized === "amd64") return "x64";
  return null;
}

/**
 * The manifest target for the current host. Mirrors `detectRuntimeTarget` in
 * `commands/brainUpdate.ts` — the tools cache is only ever populated for a
 * target the ADE runtime itself ships for.
 */
export function detectToolTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = os.arch(),
): ToolTarget {
  const normalizedArch = normalizeToolArch(arch);
  const normalizedPlatform = platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : null;
  const candidate = normalizedPlatform && normalizedArch ? `${normalizedPlatform}-${normalizedArch}` : null;
  if (!candidate || !isToolTarget(candidate)) {
    throw new ToolError(
      `ADE agent tools are published for macOS/Linux arm64/x64 and Windows x64; got ${platform}/${arch}.`,
      { kind: "unsupported-target", target: `${platform}-${arch}` },
    );
  }
  return candidate;
}

function homeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const fromEnv = platform === "win32" ? env.USERPROFILE?.trim() : env.HOME?.trim();
  return fromEnv || os.homedir();
}

/**
 * The machine-level, cross-channel tools cache.
 *
 * Deliberately NOT derived from `ADE_HOME`. `ADE_HOME` is channel-scoped
 * (`~/.ade`, `~/.ade-beta`, `~/.ade-alpha` — see `machineLayout.ts`), and the
 * whole point of this cache is that stable, beta, and the brain runtime share
 * one copy of a ~300 MB pinned binary. Contents are addressed by exact package
 * name + exact version, so sharing across channels can never mix builds: two
 * channels either pin the same version and reuse the directory, or pin
 * different versions and get different directories.
 *
 * `ADE_TOOLS_ROOT` relocates it wholesale (large disks, tests, CI).
 * On Windows this lands under `%LOCALAPPDATA%`, matching where the rest of ADE
 * keeps machine-local caches (`services/cli/adeCliService.ts`), rather than the
 * roaming profile — 650 MB must never roam.
 */
export function resolveMachineToolsRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = env.ADE_TOOLS_ROOT?.trim();
  if (explicit) return path.resolve(explicit);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || path.win32.join(homeDir(env, platform), "AppData", "Local");
    return path.win32.join(localAppData, "ADE", "tools");
  }
  return path.join(homeDir(env, platform), ".ade", "tools");
}

/** npm package names, including one optional scope segment. */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** Semver plus the platform suffixes npm-published binary packages use. */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Both values become path segments under the tools root, so they are validated
 * as a traversal guard before they are ever joined — a manifest is a data file
 * and must not be able to reach outside the cache.
 */
export function assertSafePackageCoordinates(packageName: string, version: string): void {
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new ToolError(`Invalid tools manifest package name: ${JSON.stringify(packageName)}.`, {
      kind: "manifest",
      packageName,
    });
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new ToolError(`Invalid tools manifest version for ${packageName}: ${JSON.stringify(version)}.`, {
      kind: "manifest",
      packageName,
      version,
    });
  }
}

export function toolPackageDir(toolsRoot: string, packageName: string): string {
  return path.join(toolsRoot, ...packageName.split("/"));
}

export function toolVersionDir(toolsRoot: string, packageName: string, version: string): string {
  return path.join(toolPackageDir(toolsRoot, packageName), version);
}

export function toolSentinelPath(versionDir: string): string {
  return path.join(versionDir, TOOL_INSTALL_SENTINEL);
}

export function toolsStagingRoot(toolsRoot: string): string {
  return path.join(toolsRoot, STAGING_DIR_NAME);
}

export function toolsLockRoot(toolsRoot: string): string {
  return path.join(toolsRoot, LOCK_DIR_NAME);
}

/** `@openai/codex-darwin-arm64@0.144.5-darwin-arm64` -> a single safe filename. */
export function toolSlug(packageName: string, version: string): string {
  return `${packageName.replace(/[@/]/g, "_")}@${version}`.replace(/[^A-Za-z0-9._@-]/g, "_");
}

export function toolLockPath(toolsRoot: string, packageName: string, version: string): string {
  return path.join(toolsLockRoot(toolsRoot), `${toolSlug(packageName, version)}.lock`);
}

export function isToolInstalled(versionDir: string): boolean {
  return fs.existsSync(toolSentinelPath(versionDir));
}
