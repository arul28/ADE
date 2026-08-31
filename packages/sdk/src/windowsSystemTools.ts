import fs from "node:fs";
import path from "node:path";
import { AdeError } from "./errors.js";

/**
 * Resolution of the Windows system executables this package shells out to.
 *
 * Three call sites need one: `tar` (extracting a downloaded runtime),
 * `powershell` (reading a process start time, which is the last corroboration
 * before we signal a pid), and `taskkill` (ending a runtime and its whole
 * tree). Every one of them either writes an executable we then spawn or ends a
 * process, so "which binary is this" is a security question, not a convenience.
 *
 * `PATH`, the cwd, `SystemRoot` and `windir` are ALL caller-controlled — a
 * parent process chooses the environment a child is launched with, and an
 * attacker who can set `SystemRoot=C:\evil` picks our taskkill. So none of them
 * are consulted. `\\?\GLOBALROOT\SystemRoot\System32` is the kernel's own alias
 * for the real system tree and cannot be redirected by the environment; the
 * canonical-path check then converts it to a normal Win32 path that `spawn` can
 * use, and proves the result did not escape System32 through a junction.
 *
 * Mirrors `apps/ade-cli/src/lib/trustedWindowsTools.ts`. Deliberately a copy
 * rather than an import: this package ships standalone to npm with no
 * dependency on the ADE repo, and a shared module would have to be published
 * too. The kernel alias, the canonical check and the escape check are the parts
 * that must stay identical; if that file changes, change this one.
 */

export type TrustedWindowsTool = "powershell" | "tar" | "taskkill";

const TRUSTED_TOOL_RELATIVE_PATHS: Record<TrustedWindowsTool, string> = {
  powershell: path.win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
  // bsdtar, shipped in System32 since Windows 10 1803. Resolved here rather
  // than as a bare "tar" so a Git Bash / MSYS / Cygwin tar.exe earlier on PATH
  // — which handles Windows paths differently — can never be the one that runs.
  tar: "tar.exe",
  taskkill: "taskkill.exe",
};

export const TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot\System32`;

export type TrustedWindowsToolResolverDeps = {
  platform?: NodeJS.Platform;
  realpathNative?: (filePath: string) => string;
  statSync?: (filePath: string) => { isFile(): boolean };
};

const trustedToolCache = new Map<TrustedWindowsTool, string>();

/** The un-canonicalized kernel-alias path for a tool. Pure. */
export function trustedWindowsToolKernelPath(tool: TrustedWindowsTool): string {
  return path.win32.join(TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT, TRUSTED_TOOL_RELATIVE_PATHS[tool]);
}

/**
 * Resolve one of the three tools to a canonical, spawnable absolute path.
 *
 * Throws `AdeError("spawn_failed")` rather than degrading to a bare command
 * name. A PATH fallback is exactly the behaviour this function exists to
 * remove: falling back would mean that anyone who can make the System32 lookup
 * fail also gets to choose the binary, which is strictly worse than not running
 * the tool at all. Each caller decides what its own failure means — the pidfile
 * treats it as "cannot corroborate, do not kill", the sidecar as "tree kill
 * unavailable, still kill the leader", the downloader as a failed install.
 */
export function resolveTrustedWindowsTool(
  tool: TrustedWindowsTool,
  deps: TrustedWindowsToolResolverDeps = {},
): string {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    // Cross-platform unit tests import this module. Keep the rendered command
    // deterministic instead of consulting a host that has no System32.
    return trustedWindowsToolKernelPath(tool);
  }

  const useCache = Object.keys(deps).length === 0;
  const cached = useCache ? trustedToolCache.get(tool) : undefined;
  if (cached) return cached;

  const realpathNative = deps.realpathNative ?? ((filePath: string) => fs.realpathSync.native(filePath));
  const statSync = deps.statSync ?? ((filePath: string) => fs.statSync(filePath));
  const kernelToolPath = trustedWindowsToolKernelPath(tool);

  let canonicalRoot: string;
  let canonicalTool: string;
  try {
    canonicalRoot = realpathNative(TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT);
    canonicalTool = realpathNative(kernelToolPath);
  } catch (error) {
    throw new AdeError("spawn_failed", `Could not resolve the Windows ${tool} executable.`, {
      cause: error,
    });
  }

  const expectedTool = path.win32.join(canonicalRoot, TRUSTED_TOOL_RELATIVE_PATHS[tool]);
  const relativeTool = path.win32.relative(canonicalRoot, canonicalTool);
  const escapesRoot =
    relativeTool === ".." ||
    relativeTool.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(relativeTool);
  if (
    path.win32.basename(canonicalRoot).toLowerCase() !== "system32" ||
    escapesRoot ||
    canonicalTool.toLowerCase() !== expectedTool.toLowerCase()
  ) {
    throw new AdeError(
      "spawn_failed",
      `Refusing an untrusted Windows ${tool} executable: ${canonicalTool}`,
    );
  }

  let isFile = false;
  try {
    isFile = statSync(canonicalTool).isFile();
  } catch (error) {
    throw new AdeError("spawn_failed", `Could not inspect the Windows ${tool} executable.`, {
      cause: error,
    });
  }
  if (!isFile) {
    throw new AdeError(
      "spawn_failed",
      `The Windows ${tool} path is not a file: ${canonicalTool}`,
    );
  }

  if (useCache) trustedToolCache.set(tool, canonicalTool);
  return canonicalTool;
}
