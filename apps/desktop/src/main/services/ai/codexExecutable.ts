import type { DetectedAuth } from "./authDetector";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cachedToolEntryPath, previousCachedToolEntryPath } from "../../../../../ade-cli/src/services/tools/cacheLookup";
import { resolveActiveToolVersionOverride } from "../../../../../ade-cli/src/services/tools/overrides";

/** `auth`, `path` (also the env override's label), and `common-dir` stay for callers that name them. */
export type CodexExecutableResolution = {
  path: string;
  source: "tools-cache" | "bundled" | "auth" | "path" | "common-dir" | "fallback-command";
  /**
   * Set when this is the newer, untested build ADE moved to because OpenAI
   * refused the pin for a model (`codexFallForward.ts`). Still ADE's own,
   * verified copy in the tools cache (`source` is `tools-cache`).
   */
  fallForward?: {
    pinnedVersion: string;
    overrideVersion: string;
    codexVersion: string | null;
    rejectedCodexVersion: string | null;
    model: string | null;
  };
};

const CODEX_PLATFORM_PACKAGES: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>> = {
  darwin: {
    arm64: "codex-darwin-arm64",
    x64: "codex-darwin-x64",
  },
  linux: {
    arm64: "codex-linux-arm64",
    x64: "codex-linux-x64",
  },
  win32: {
    arm64: "codex-win32-arm64",
    x64: "codex-win32-x64",
  },
};
const moduleDir =
  typeof __dirname === "string"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

function pathExists(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      // Windows has no execute bit; presence is the only signal available.
      return platform === "win32";
    } catch {
      return false;
    }
  }
}

function listDirectories(rootPath: string): string[] {
  try {
    return fs.readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootPath, entry.name));
  } catch {
    return [];
  }
}

function findVendorCodexBinary(packageRoot: string, platform: NodeJS.Platform): string | null {
  const binaryName = platform === "win32" ? "codex.exe" : "codex";
  for (const vendorRoot of listDirectories(path.join(packageRoot, "vendor"))) {
    for (const candidate of [
      path.join(vendorRoot, "bin", binaryName),
      path.join(vendorRoot, "codex", binaryName),
    ]) {
      if (pathExists(candidate, platform)) return candidate;
    }
  }
  return null;
}

function collectBundledCodexRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const explicitRoot = env.ADE_CODEX_BUNDLE_ROOT?.trim();
  if (explicitRoot) roots.push(explicitRoot);

  const processWithResources = process as NodeJS.Process & { resourcesPath?: string };
  if (processWithResources.resourcesPath) {
    roots.push(
      path.join(processWithResources.resourcesPath, "app.asar.unpacked", "node_modules", "@openai"),
      path.join(processWithResources.resourcesPath, "app", "node_modules", "@openai"),
    );
  }

  // ADE's own `node_modules`, found from this module. Never the working
  // directory: that can be any project, with a Codex of its own.
  let current = moduleDir;
  for (;;) {
    roots.push(path.join(current, "node_modules", "@openai"));
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }

  return [...new Set(roots)];
}

function findBundledCodexExecutable(args: {
  env: NodeJS.ProcessEnv;
  bundledRoots?: string[];
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}): string | null {
  const platform = args.platform ?? process.platform;
  const arch = args.arch ?? process.arch;
  const packageName = CODEX_PLATFORM_PACKAGES[platform]?.[arch];
  if (!packageName) return null;

  const roots = args.bundledRoots ?? collectBundledCodexRoots(args.env);
  for (const root of roots) {
    const packageRoot = path.join(root, packageName);
    const executable = findVendorCodexBinary(packageRoot, platform);
    if (executable) return executable;
  }
  return null;
}

/**
 * ADE's own Codex: the dev/test override (`CODEX_EXECUTABLE`), the newer build
 * ADE moved to after OpenAI refused the current pin for a model (only while
 * that pin is still the manifest's and the build's install is complete, so an
 * ADE update that moves the pin ends it), the current pin in the tools cache, the copy ADE's lockfile put in `node_modules` (a source
 * checkout; `ADE_CODEX_BUNDLE_ROOT` points a test at one), then the previous
 * pin while a new one downloads. Never a Codex the user installed.
 *
 * `fallback-command` means ADE has no copy on this machine; `path` is empty.
 * `auth` is accepted for call-site compatibility and ignored.
 */
export function resolveCodexExecutable(args?: {
  auth?: DetectedAuth[];
  env?: NodeJS.ProcessEnv;
  bundledRoots?: string[];
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}): CodexExecutableResolution {
  const env = args?.env ?? process.env;
  const envPath = env.CODEX_EXECUTABLE?.trim() || env.CODEX_EXECUTABLE_PATH?.trim();
  if (envPath) {
    return { path: envPath, source: "path" };
  }

  // Codex is the one tool that cannot be reached by seeding a module search
  // path: its binary lives at `vendor/<triple>/bin/codex` and is found by the
  // probe below, never by NODE_PATH. The cache therefore has to hand over the
  // resolved entry path explicitly.
  const cacheContext = { env, platform: args?.platform, arch: args?.arch };
  const forced = resolveActiveToolVersionOverride("codex", cacheContext);
  if (forced && pathExists(forced.resolution.entryPath, args?.platform)) {
    return {
      path: forced.resolution.entryPath,
      source: "tools-cache",
      fallForward: {
        pinnedVersion: forced.override.pinnedVersion,
        overrideVersion: forced.override.overrideVersion,
        codexVersion: forced.override.overrideToolVersion,
        rejectedCodexVersion: forced.override.rejectedToolVersion,
        model: forced.override.scope ?? null,
      },
    };
  }
  const cachedPath = cachedToolEntryPath("codex", cacheContext);
  if (cachedPath && pathExists(cachedPath, args?.platform)) {
    return { path: cachedPath, source: "tools-cache" };
  }

  const bundledPath = findBundledCodexExecutable({
    env,
    bundledRoots: args?.bundledRoots,
    platform: args?.platform,
    arch: args?.arch,
  });
  if (bundledPath) {
    return { path: bundledPath, source: "bundled" };
  }

  const previousPath = previousCachedToolEntryPath("codex", cacheContext);
  if (previousPath && pathExists(previousPath, args?.platform)) {
    return { path: previousPath, source: "tools-cache" };
  }

  return { path: "", source: "fallback-command" };
}
