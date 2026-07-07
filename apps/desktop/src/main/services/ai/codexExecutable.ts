import type { DetectedAuth } from "./authDetector";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";

export type CodexExecutableResolution = {
  path: string;
  source: "bundled" | "auth" | "path" | "common-dir" | "fallback-command";
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

function pathExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      return process.platform === "win32";
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
      if (pathExists(candidate)) return candidate;
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

  return { path: "codex", source: "fallback-command" };
}
