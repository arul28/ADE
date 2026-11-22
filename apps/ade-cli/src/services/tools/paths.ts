import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUNTIME_TARGETS,
  type RuntimeTarget,
  detectRuntimeTargetResult,
  isRuntimeTarget,
  normalizeRuntimeArch,
} from "../../lib/releaseAssets";
import { ToolError } from "./errors";
import { toolsLoggerInstalled, warnTools } from "./toolsLog";

/**
 * The tools cache is only ever populated for a target the ADE runtime itself
 * ships for, so the list, the arch normalization and the host detection are all
 * the release-asset module's (`lib/releaseAssets.ts`). These stay exported under
 * the tools-domain names their callers already use.
 */
export const TOOL_TARGETS = RUNTIME_TARGETS;

export type ToolTarget = RuntimeTarget;

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
  return isRuntimeTarget(value);
}

export function normalizeToolArch(arch: string): "arm64" | "x64" | null {
  return normalizeRuntimeArch(arch);
}

/** The manifest target for the current host, as a `ToolError` on failure. */
export function detectToolTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = os.arch(),
): ToolTarget {
  const detected = detectRuntimeTargetResult(platform, arch);
  if (!detected.ok) {
    throw new ToolError(
      `ADE agent tools are published for macOS/Linux arm64/x64 and Windows x64; got ${platform}/${arch}.`,
      { kind: "unsupported-target", target: `${platform}-${arch}` },
    );
  }
  return detected.target;
}

function homeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const fromEnv = platform === "win32" ? env.USERPROFILE?.trim() : env.HOME?.trim();
  return fromEnv || os.homedir();
}

/**
 * The machine-level, cross-channel tools cache.
 *
 * Deliberately NOT derived from `ADE_HOME`. `ADE_HOME` is channel-scoped
 * (`~/.ade`, `~/.ade-alpha` — see `machineLayout.ts`), and the
 * whole point of this cache is that stable, beta, and the brain runtime share
 * one copy of a ~300 MB pinned binary. Contents are addressed by exact package
 * name + exact version, so sharing across channels can never mix builds: two
 * channels either pin the same version and reuse the directory, or pin
 * different versions and get different directories.
 *
 * `ADE_TOOLS_ROOT` relocates it wholesale (large disks, tests, CI), and a
 * machine image can move it off the person's disk (`resolveToolsRootLayout`).
 * On Windows this lands under `%LOCALAPPDATA%`, matching where the rest of ADE
 * keeps machine-local caches (`services/cli/adeCliService.ts`), rather than the
 * roaming profile — 650 MB must never roam.
 */
export function resolveMachineToolsRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveToolsRootLayout(env, platform).primary;
}

/** The per-user tools cache: `~/.ade/tools`, or `%LOCALAPPDATA%\ADE\tools` on Windows. */
function homeToolsRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || path.win32.join(homeDir(env, platform), "AppData", "Local");
    return path.win32.join(localAppData, "ADE", "tools");
  }
  return path.join(homeDir(env, platform), ".ade", "tools");
}

/**
 * Where the tools cache lives on this machine. Every field comes from the
 * machine's own environment, so a machine image says where its rebuildable
 * caches go; ADE has no code path per provider or OS for it.
 *
 *   - `ADE_TOOLS_ROOT` relocates the whole cache (tests, CI, large disks).
 *   - `ADE_SYSTEM_CACHE_ROOT` names a folder for caches ADE can rebuild that
 *     is not the person's own disk (an ADE Cloud computer's system layer).
 *     Tools then install under `<root>/tools`. Each time a tool installs
 *     there, the folder is brought within `ADE_SYSTEM_CACHE_BUDGET_BYTES`
 *     (default about 7 GB) and within the free space of its filesystem
 *     (`systemCache.ts`); between installs nothing checks it. A tool that
 *     still does not fit goes to the per-user cache instead.
 *   - `ADE_TOOLS_BAKED_ROOTS` lists read-only caches in the same layout that a
 *     machine image ships (separated like PATH). A pinned version found there
 *     is used before any download.
 */
export type ToolsRootLayout = {
  /** Installs, locks, the ledgers and overrides. */
  primary: string;
  /** Where an install goes when the primary cannot take it. Null: nowhere else. */
  fallback: string | null;
  /** Read-only roots holding finished installs (a machine image's). */
  baked: string[];
  /** The folder the primary sits in and its byte budget, when it has one. */
  budget: { root: string; bytes: number } | null;
};

/** "About 7 GB" of the 10 GB system layer, leaving room for the system itself. */
export const DEFAULT_SYSTEM_CACHE_BUDGET_BYTES = 7 * 1000 ** 3;
export const SYSTEM_CACHE_TOOLS_DIR = "tools";

/** A writable verdict holds for the process; a refusal is checked again after this long (the image may fix it). */
const UNWRITABLE_RECHECK_MS = 5 * 60_000;
const writableDirCache = new Map<string, { writable: boolean; at: number }>();
const warnedUnwritable = new Set<string>();

/**
 * True when this process may write `dir`, or, before the first install made
 * it, the nearest folder above it that exists. Never creates anything: the
 * image makes the folder, and the first install under it makes the rest.
 */
function writableDir(dir: string): boolean {
  const cached = writableDirCache.get(dir);
  if (cached && (cached.writable || Date.now() - cached.at < UNWRITABLE_RECHECK_MS)) return cached.writable;
  let writable = false;
  let reason = "";
  let cursor = dir;
  for (;;) {
    try {
      fs.accessSync(cursor, fs.constants.W_OK);
      writable = true;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      const parent = path.dirname(cursor);
      if (code !== "ENOENT" || parent === cursor) {
        reason = code;
        break;
      }
      cursor = parent;
    }
  }
  writableDirCache.set(dir, { writable, at: Date.now() });
  if (!writable && !warnedUnwritable.has(dir) && toolsLoggerInstalled()) {
    warnedUnwritable.add(dir);
    // The image names the folder but this process can't write it: tools stay on the per-user cache.
    warnTools("tools.system_cache_unwritable", { dir, code: reason, fallback: "home" });
  }
  return writable;
}

function parseBudgetBytes(raw: string | undefined): number {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SYSTEM_CACHE_BUDGET_BYTES;
}

/**
 * Where the record of tool use lives: the per-user root, which survives what a
 * system cache does not (an image update resets it), so a machine still knows
 * which agents it uses after one.
 */
export function toolUsageRoot(layout: ToolsRootLayout): string {
  return layout.fallback ?? layout.primary;
}

/** Roots that can hold the current pin, in the order it is taken: a baked copy first. */
export function currentPinRoots(layout: ToolsRootLayout): string[] {
  return [...layout.baked, layout.primary, ...(layout.fallback ? [layout.fallback] : [])];
}

/** Roots ADE writes and collects (never an image's baked root). */
export function writableRoots(layout: ToolsRootLayout): string[] {
  return [layout.primary, ...(layout.fallback ? [layout.fallback] : [])];
}

/**
 * The finished `<package>/<version>` install under one of `roots` that holds
 * `target`, or null when `target` is outside them or the install is unfinished.
 */
export function installDirContaining(target: string, roots: readonly string[]): string | null {
  const resolved = path.resolve(target);
  for (const root of roots) {
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const segments = relative.split(path.sep);
    const depth = segments[0]?.startsWith("@") ? 3 : 2;
    if (segments.length < depth) continue;
    const dir = path.join(root, ...segments.slice(0, depth));
    if (isToolInstalled(dir)) return dir;
  }
  return null;
}

export function resolveToolsRootLayout(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ToolsRootLayout {
  const explicit = env.ADE_TOOLS_ROOT?.trim();
  const home = homeToolsRoot(env, platform);
  let primary = explicit ? path.resolve(explicit) : home;
  let fallback: string | null = null;
  let budget: ToolsRootLayout["budget"] = null;
  const systemRoot = env.ADE_SYSTEM_CACHE_ROOT?.trim();
  if (!explicit && systemRoot && path.isAbsolute(systemRoot)) {
    const root = path.resolve(systemRoot);
    const tools = path.join(root, SYSTEM_CACHE_TOOLS_DIR);
    // A machine whose image names the folder but lets this process write
    // neither it nor the folder it would be made in keeps the per-user cache
    // rather than failing every install.
    if (writableDir(tools)) {
      primary = tools;
      fallback = home;
      budget = { root, bytes: parseBudgetBytes(env.ADE_SYSTEM_CACHE_BUDGET_BYTES) };
    }
  }
  const delimiter = platform === "win32" ? ";" : ":";
  const baked = [...new Set(
    (env.ADE_TOOLS_BAKED_ROOTS ?? "")
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry && path.isAbsolute(entry))
      .map((entry) => path.resolve(entry)),
  )].filter((entry) => entry !== primary && entry !== fallback);
  return { primary, fallback, baked, budget };
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

/** `@openai/codex-darwin-arm64@0.167.0-darwin-arm64` -> a single safe filename. */
export function toolSlug(packageName: string, version: string): string {
  return `${packageName.replace(/[@/]/g, "_")}@${version}`.replace(/[^A-Za-z0-9._@-]/g, "_");
}

export function toolLockPath(toolsRoot: string, packageName: string, version: string): string {
  return path.join(toolsLockRoot(toolsRoot), `${toolSlug(packageName, version)}.lock`);
}

export function isToolInstalled(versionDir: string): boolean {
  return fs.existsSync(toolSentinelPath(versionDir));
}
