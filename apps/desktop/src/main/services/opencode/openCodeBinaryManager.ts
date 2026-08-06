// OpenCode binary resolution with bundled fallback
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cachedToolEntryPath } from "../../../../../ade-cli/src/services/tools/cacheLookup";
import {
  augmentProcessPathWithShellAndKnownCliDirs,
  resolveExecutableFromKnownLocations,
  setPathEnvValue,
} from "../ai/cliExecutableResolver";

export type OpenCodeBinarySource = "user-installed" | "tools-cache" | "bundled" | "missing";

export type OpenCodeBinaryInfo = {
  path: string | null;
  source: OpenCodeBinarySource;
};

let cachedInfo: OpenCodeBinaryInfo | null = null;

const moduleDir =
  typeof __dirname === "string"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

const OPENCODE_PLATFORM_PACKAGES: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>> = {
  darwin: {
    arm64: "opencode-darwin-arm64",
    x64: "opencode-darwin-x64",
  },
  linux: {
    arm64: "opencode-linux-arm64",
    x64: "opencode-linux-x64",
  },
  win32: {
    arm64: "opencode-windows-arm64",
    // Windows x64 ships the `-baseline` build only. `opencode-windows-x64`
    // requires AVX2 and dies with an illegal instruction on older/VM x64 CPUs,
    // while `-baseline` targets the lower instruction set and therefore runs
    // everywhere. The two binaries are byte-for-byte the same size, and the
    // baseline build shows no measurable throughput cost for how ADE drives
    // OpenCode (a local HTTP server), so shipping baseline alone replaces the
    // AVX2 build rather than adding to the installer. Keep this in sync with
    // `asarUnpack` in apps/desktop/package.json.
    x64: "opencode-windows-x64-baseline",
  },
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function executableFileNames(platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
    : ["opencode", "opencode.exe"];
}

function collectBundledNodeModulesRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  const explicitRoot = env.ADE_OPENCODE_BUNDLE_ROOT?.trim();
  if (explicitRoot) {
    // Treat the explicit root as an override. This keeps development/test
    // runtimes hermetic and prevents a stale checkout-local package from
    // winning over the requested bundle.
    return [explicitRoot.endsWith("node_modules") ? explicitRoot : join(explicitRoot, "node_modules")];
  }

  const processWithResources = process as NodeJS.Process & { resourcesPath?: string };
  if (processWithResources.resourcesPath) {
    const resourcesPath = processWithResources.resourcesPath;
    roots.push(
      join(resourcesPath, "app.asar.unpacked", "node_modules"),
      join(resourcesPath, `app-${process.arch}.asar.unpacked`, "node_modules"),
      join(resourcesPath, "app", "node_modules"),
    );
  }

  for (const entry of env.NODE_PATH?.split(delimiter) ?? []) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    roots.push(trimmed.endsWith("node_modules") ? trimmed : join(trimmed, "node_modules"));
  }

  roots.push(join(process.cwd(), "node_modules"));
  roots.push(join(process.cwd(), "apps", "desktop", "node_modules"));

  let current = moduleDir;
  for (;;) {
    roots.push(join(current, "node_modules"));
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }

  return unique(roots);
}

function bundledBinaryCandidatePaths(args?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}): string[] {
  const env = args?.env ?? process.env;
  const platform = args?.platform ?? process.platform;
  const arch = args?.arch ?? process.arch;
  const fileNames = platform === "win32"
    ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
    : ["opencode"];
  const candidates: string[] = [];

  // Legacy packaged fallback for builds that copied the binary directly into
  // Resources/. New builds resolve the pinned npm runtime package below.
  const resourcesPath = (process as any).resourcesPath;
  if (resourcesPath && !env.ADE_OPENCODE_BUNDLE_ROOT?.trim()) {
    candidates.push(...fileNames.map((fileName) => join(resourcesPath, fileName)));
  }

  const executableNames = executableFileNames(platform);
  const platformPackage = OPENCODE_PLATFORM_PACKAGES[platform]?.[arch];
  for (const nodeModulesRoot of collectBundledNodeModulesRoots(env)) {
    if (platformPackage) {
      candidates.push(...executableNames.map((fileName) => (
        join(nodeModulesRoot, platformPackage, "bin", fileName)
      )));
    }
    candidates.push(...executableNames.map((fileName) => join(nodeModulesRoot, "opencode-ai", "bin", fileName)));
    candidates.push(...executableNames.map((fileName) => join(nodeModulesRoot, ".bin", fileName)));
  }

  return unique(candidates);
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

  // 1. Prefer ADE's pinned runtime, matching the Claude/Codex resolver policy.
  // Developers can opt out to exercise a local install.
  if (process.env.ADE_DISABLE_BUNDLED_OPENCODE !== "1") {
    // The machine tools cache first: in a packaged build the platform package
    // is fetched there rather than bundled. The manifest already encodes the
    // win32-x64 -> opencode-windows-x64-baseline substitution, so the AVX2
    // avoidance documented on OPENCODE_PLATFORM_PACKAGES holds here too.
    const cachedPath = cachedToolEntryPath("opencode");
    if (cachedPath && canRunBinaryCandidate(cachedPath)) {
      cachedInfo = { path: cachedPath, source: "tools-cache" };
      return cachedInfo;
    }

    const bundled = bundledBinaryCandidatePaths().find((candidate) => canRunBinaryCandidate(candidate));
    if (bundled) {
      cachedInfo = { path: bundled, source: "bundled" };
      return cachedInfo;
    }
  }

  // 2. Fall back to user-installed binary (PATH, ~/.opencode/bin, etc.)
  const userInstalled = resolveExecutableFromKnownLocations("opencode");
  if (userInstalled?.path) {
    cachedInfo = { path: userInstalled.path, source: "user-installed" };
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

export type OpenCodeBinaryQuarantineState = "quarantined" | "clean" | "unknown";

/**
 * Best-effort probe for the macOS `com.apple.quarantine` extended attribute on
 * the OpenCode binary. Used by launch diagnostics to distinguish a Gatekeeper
 * quarantine (fixable via `xattr -d`) from a genuine bad signature. Returns
 * `"unknown"` off darwin, without a path, or when `xattr` is unavailable / times
 * out; `"clean"` when the attribute is absent; `"quarantined"` when present.
 */
export function probeOpenCodeBinaryQuarantine(binaryPath: string | null | undefined): OpenCodeBinaryQuarantineState {
  if (process.platform !== "darwin") return "unknown";
  const trimmed = binaryPath?.trim();
  if (!trimmed) return "unknown";
  try {
    execFileSync("xattr", ["-p", "com.apple.quarantine", trimmed], {
      encoding: "utf8",
      timeout: 1_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "quarantined";
  } catch (error) {
    // A non-zero exit can also mean permission/I/O failures, so only the
    // platform's explicit missing-attribute diagnostic proves the binary is
    // clean. All other failures remain inconclusive.
    const record = error && typeof error === "object"
      ? error as { code?: unknown; message?: unknown; stderr?: unknown }
      : null;
    const stderr = typeof record?.stderr === "string"
      ? record.stderr
      : Buffer.isBuffer(record?.stderr) ? record.stderr.toString("utf8") : "";
    const detail = `${typeof record?.message === "string" ? record.message : ""}\n${stderr}`;
    if (
      record?.code === "ENOATTR"
      || /no such (?:xattr|extended attribute)|attribute not found/i.test(detail)
    ) {
      return "clean";
    }
    return "unknown";
  }
}
