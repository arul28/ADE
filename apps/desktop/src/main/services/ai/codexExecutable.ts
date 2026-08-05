import type { DetectedAuth } from "./authDetector";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cachedToolEntryPath } from "../../../../../ade-cli/src/services/tools/cacheLookup";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";

export type CodexExecutableResolution = {
  path: string;
  source: "tools-cache" | "bundled" | "auth" | "path" | "common-dir" | "fallback-command";
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

function findCodexAuthPath(auth?: DetectedAuth[]): string | null {
  for (const entry of auth ?? []) {
    if (entry.type !== "cli-subscription" || entry.cli !== "codex") continue;
    const candidate = entry.path.trim();
    if (candidate) return candidate;
  }
  return null;
}

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

function homeDirFromEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const profile = env.USERPROFILE?.trim();
  const home = env.HOME?.trim();
  if (platform === "win32") return profile || home || os.homedir() || null;
  return home || os.homedir() || null;
}

/**
 * Directories used by Codex's own standalone installer
 * (`https://chatgpt.com/codex/install.ps1` / `install.sh`).
 *
 * The installer drops the release under `$CODEX_HOME/packages/standalone/current`
 * and exposes it through a "visible bin" directory that it prepends to the
 * *persisted* user PATH:
 *   - Windows: `%CODEX_INSTALL_DIR%` else `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`
 *   - macOS/Linux: `$CODEX_INSTALL_DIR` else `$HOME/.local/bin`
 *
 * A persisted PATH edit is not visible to an already-running login session, so
 * ADE must be able to find a standalone install without it. macOS already gets
 * this for free because `~/.local/bin` is in the shared known-bin-dir list; the
 * Windows equivalent is not, which left standalone Windows installs
 * indistinguishable from "Codex is not installed".
 */
function standaloneCodexInstallDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const dirs: string[] = [];
  const installDir = env.CODEX_INSTALL_DIR?.trim();
  if (installDir) dirs.push(installDir);

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) dirs.push(path.join(localAppData, "Programs", "OpenAI", "Codex", "bin"));
  } else {
    const home = homeDirFromEnv(env, platform);
    if (home) dirs.push(path.join(home, ".local", "bin"));
  }

  const configuredHome = env.CODEX_HOME?.trim();
  const home = homeDirFromEnv(env, platform);
  const codexHome = configuredHome || (home ? path.join(home, ".codex") : "");
  if (codexHome) {
    const current = path.join(codexHome, "packages", "standalone", "current");
    dirs.push(path.join(current, "bin"), current);
  }

  return [...new Set(dirs)];
}

function findStandaloneCodexExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const binaryName = platform === "win32" ? "codex.exe" : "codex";
  for (const dir of standaloneCodexInstallDirs(env, platform)) {
    const candidate = path.join(dir, binaryName);
    if (pathExists(candidate, platform)) return candidate;
  }
  return null;
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

  roots.push(path.join(process.cwd(), "node_modules", "@openai"));

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
  if (args.env.ADE_DISABLE_BUNDLED_CODEX === "1") return null;

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
  // resolved entry path explicitly. `ADE_DISABLE_BUNDLED_CODEX` means "use my
  // own Codex, not ADE's", so it opts out of the cache for the same reason it
  // opts out of the bundled copy.
  if (env.ADE_DISABLE_BUNDLED_CODEX !== "1") {
    const cachedPath = cachedToolEntryPath("codex", {
      env,
      platform: args?.platform,
      arch: args?.arch,
    });
    if (cachedPath && pathExists(cachedPath)) {
      return { path: cachedPath, source: "tools-cache" };
    }
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

  const authPath = findCodexAuthPath(args?.auth);
  if (authPath) {
    return { path: authPath, source: "auth" };
  }

  const resolved = resolveExecutableFromKnownLocations("codex", env);
  if (resolved) {
    return {
      path: resolved.path,
      source: resolved.source === "path" ? "path" : "common-dir",
    };
  }

  const standalone = findStandaloneCodexExecutable(env, args?.platform ?? process.platform);
  if (standalone) {
    return { path: standalone, source: "common-dir" };
  }

  return { path: "codex", source: "fallback-command" };
}
