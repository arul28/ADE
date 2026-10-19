// OpenCode binary resolution: ADE's pinned copy only.
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cachedToolEntryPath, previousCachedToolEntryPath } from "../../../../../ade-cli/src/services/tools/cacheLookup";

/** `user-installed` is no longer produced; it stays for callers that name it. */
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
    arm64: "@opencode/cli-darwin-arm64",
    x64: "@opencode/cli-darwin-x64",
  },
  linux: {
    arm64: "@opencode/cli-linux-arm64",
    x64: "@opencode/cli-linux-x64",
  },
  win32: {
    arm64: "@opencode/cli-windows-arm64",
    // Windows x64 ships the `-baseline` build only. `@opencode/cli-windows-x64`
    // requires AVX2 and dies with an illegal instruction on older/VM x64 CPUs,
    // while `-baseline` targets the lower instruction set and therefore runs
    // everywhere. The two binaries are byte-for-byte the same size, and the
    // baseline build shows no measurable throughput cost for how ADE drives
    // OpenCode (a local HTTP server), so shipping baseline alone replaces the
    // AVX2 build rather than adding to the installer. Keep this in sync with
    // `asarUnpack` in apps/desktop/package.json.
    x64: "@opencode/cli-windows-x64-baseline",
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
    const rootWithoutTrailingSeparators = explicitRoot.replace(/[\\/]+$/, "") || explicitRoot;
    return [rootWithoutTrailingSeparators.endsWith("node_modules")
      ? rootWithoutTrailingSeparators
      : join(rootWithoutTrailingSeparators, "node_modules")];
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

  // ADE's own `node_modules`, found from this module. Never the working
  // directory: that can be any project, with an OpenCode of its own.
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
    // `@opencode/cli` is the launcher package: its postinstall copies the
    // platform binary to bin/opencode.exe on every OS.
    candidates.push(...executableNames.map((fileName) => join(nodeModulesRoot, "@opencode", "cli", "bin", fileName)));
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

/**
 * ADE's own OpenCode: the current pin in the tools cache, the copy ADE's
 * lockfile put in `node_modules` (a source checkout, or a legacy build that
 * shipped it; `ADE_OPENCODE_BUNDLE_ROOT` points a test at one and skips the
 * cache), then the previous pin while a new one downloads. Never an OpenCode
 * the user installed.
 */
export function resolveOpenCodeBinary(): OpenCodeBinaryInfo {
  if (cachedInfo?.path && canRunBinaryCandidate(cachedInfo.path)) {
    return cachedInfo;
  }
  cachedInfo = null;
  const explicitBundleRoot = process.env.ADE_OPENCODE_BUNDLE_ROOT?.trim();

  // The manifest already encodes the win32-x64 ->
  // @opencode/cli-windows-x64-baseline substitution, so the AVX2 avoidance
  // documented on OPENCODE_PLATFORM_PACKAGES holds for the cache too.
  if (!explicitBundleRoot) {
    const cachedPath = cachedToolEntryPath("opencode");
    if (cachedPath && canRunBinaryCandidate(cachedPath)) {
      cachedInfo = { path: cachedPath, source: "tools-cache" };
      return cachedInfo;
    }
  }

  const bundled = bundledBinaryCandidatePaths().find((candidate) => canRunBinaryCandidate(candidate));
  if (bundled) {
    cachedInfo = { path: bundled, source: "bundled" };
    return cachedInfo;
  }

  // An explicit bundle root is hermetic: an incomplete one is a miss, never
  // the cache's copy.
  if (!explicitBundleRoot) {
    const previousPath = previousCachedToolEntryPath("opencode");
    if (previousPath && canRunBinaryCandidate(previousPath)) {
      // Not memoized: the current pin is downloading and should win once it lands.
      return { path: previousPath, source: "tools-cache" };
    }
  }

  // Misses are not memoized, so a download that lands is picked up without a
  // restart.
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
