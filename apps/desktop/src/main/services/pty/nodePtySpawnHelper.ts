import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * node-pty's macOS `spawn-helper` must be executable, and an install can lose
 * the bit (a fresh npm install, an unpacked cloud box). Without it every PTY
 * fails with "posix_spawnp failed". Terminals and the private PTYs ADE's
 * sign-ins run in both repair it before they spawn.
 */
export type NodePtySpawnHelperExecutableResult =
  | { status: "skipped"; reason: "non_darwin" | "unsupported_arch" | "package_root_unresolved" }
  | { status: "already_executable"; path: string }
  | { status: "chmod_applied"; path: string }
  | { status: "failed"; path?: string; error: string };

const requireFromRuntime = createRequire(
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
);

function resolveNodePtyPrebuildDir(platform: NodeJS.Platform, arch: string): string | null {
  if (platform !== "darwin") return null;
  if (arch === "arm64") return "darwin-arm64";
  if (arch === "x64") return "darwin-x64";
  return null;
}

function resolveNodePtyPackageRoot(): string | null {
  try {
    return path.dirname(requireFromRuntime.resolve("node-pty/package.json"));
  } catch {
    return null;
  }
}

export function ensureNodePtySpawnHelperExecutable({
  packageRoot,
  platform = process.platform,
  arch = process.arch,
}: {
  packageRoot?: string | null;
  platform?: NodeJS.Platform;
  arch?: string;
} = {}): NodePtySpawnHelperExecutableResult {
  if (platform !== "darwin") {
    return { status: "skipped", reason: "non_darwin" };
  }

  const prebuildDir = resolveNodePtyPrebuildDir(platform, arch);
  if (!prebuildDir) {
    return { status: "skipped", reason: "unsupported_arch" };
  }

  const root = packageRoot?.trim() || resolveNodePtyPackageRoot();
  if (!root) {
    return { status: "skipped", reason: "package_root_unresolved" };
  }

  const helperPath = path.join(root, "prebuilds", prebuildDir, "spawn-helper");
  try {
    const stat = fs.statSync(helperPath);
    const mode = typeof stat.mode === "number" ? stat.mode : 0;
    if ((mode & 0o111) !== 0) {
      return { status: "already_executable", path: helperPath };
    }
    fs.chmodSync(helperPath, mode | 0o111);
    return { status: "chmod_applied", path: helperPath };
  } catch (err) {
    return {
      status: "failed",
      path: helperPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
