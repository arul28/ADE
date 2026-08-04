import fs from "node:fs";
import path from "node:path";

export type TrustedWindowsTool = "powershell" | "reg" | "schtasks" | "tar" | "taskkill";

const TRUSTED_TOOL_RELATIVE_PATHS: Record<TrustedWindowsTool, string> = {
  powershell: path.win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
  reg: "reg.exe",
  schtasks: "schtasks.exe",
  // bsdtar, shipped in System32 since Windows 10 1803. Resolving it here rather
  // than as bare "tar" keeps a PATH-planted tar.exe out of the extraction path.
  tar: "tar.exe",
  taskkill: "taskkill.exe",
};

export const TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT = String.raw`\\?\GLOBALROOT\SystemRoot\System32`;

/**
 * Typed failure so callers can convert "this host will not give me reg.exe"
 * into their own refusal shape instead of letting it escape as an unhandled
 * throw. Consumers must branch on this class, never on the message text.
 */
export class TrustedWindowsToolError extends Error {
  readonly tool: TrustedWindowsTool;

  constructor(tool: TrustedWindowsTool, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TrustedWindowsToolError";
    this.tool = tool;
  }
}

type TrustedWindowsToolResolverDeps = {
  platform?: NodeJS.Platform;
  realpathNative?: (filePath: string) => string;
  statSync?: (filePath: string) => { isFile(): boolean };
};

const trustedToolCache = new Map<TrustedWindowsTool, string>();

export function trustedWindowsToolKernelPath(tool: TrustedWindowsTool): string {
  return path.win32.join(TRUSTED_WINDOWS_SYSTEM32_KERNEL_ROOT, TRUSTED_TOOL_RELATIVE_PATHS[tool]);
}

/**
 * Resolve an ADE-owned Windows command through the kernel's SystemRoot alias.
 *
 * Do not replace this with PATH, cwd, SystemRoot, or windir lookup: all four are
 * caller-controlled in CLI launches. GLOBALROOT identifies the real OS tree;
 * canonical-path validation then makes the returned normal Win32 path spawnable.
 */
export function resolveTrustedWindowsTool(
  tool: TrustedWindowsTool,
  deps: TrustedWindowsToolResolverDeps = {},
): string {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    // Windows-only modules are imported by cross-platform unit tests. Keep their
    // rendered commands deterministic without consulting the host environment.
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
    throw new TrustedWindowsToolError(tool, `Unable to resolve trusted Windows ${tool} executable`, { cause: error });
  }

  const expectedTool = path.win32.join(canonicalRoot, TRUSTED_TOOL_RELATIVE_PATHS[tool]);
  const relativeTool = path.win32.relative(canonicalRoot, canonicalTool);
  const escapesRoot = relativeTool === ".." || relativeTool.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relativeTool);
  if (
    path.win32.basename(canonicalRoot).toLowerCase() !== "system32"
    || escapesRoot
    || canonicalTool.toLowerCase() !== expectedTool.toLowerCase()
  ) {
    throw new TrustedWindowsToolError(tool, `Refusing untrusted Windows ${tool} executable: ${canonicalTool}`);
  }

  let isFile = false;
  try {
    isFile = statSync(canonicalTool).isFile();
  } catch (error) {
    throw new TrustedWindowsToolError(tool, `Unable to inspect trusted Windows ${tool} executable`, { cause: error });
  }
  if (!isFile) throw new TrustedWindowsToolError(tool, `Trusted Windows ${tool} path is not a file: ${canonicalTool}`);

  if (useCache) trustedToolCache.set(tool, canonicalTool);
  return canonicalTool;
}
