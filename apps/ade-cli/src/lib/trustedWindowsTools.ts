import { spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pathKey } from "../../../desktop/src/main/services/shared/pathCompare";

export type TrustedWindowsTool =
  | "powercfg"
  | "powershell"
  | "reg"
  | "rundll32"
  | "schtasks"
  | "tar"
  | "taskkill"
  | "icacls";

const TRUSTED_TOOL_RELATIVE_PATHS: Record<TrustedWindowsTool, string> = {
  powercfg: "powercfg.exe",
  powershell: path.win32.join("WindowsPowerShell", "v1.0", "powershell.exe"),
  reg: "reg.exe",
  rundll32: "rundll32.exe",
  schtasks: "schtasks.exe",
  // bsdtar, shipped in System32 since Windows 10 1803. Resolving it here rather
  // than as bare "tar" keeps a PATH-planted tar.exe out of the extraction path.
  tar: "tar.exe",
  taskkill: "taskkill.exe",
  icacls: "icacls.exe",
};

/**
 * Mirrored in `packages/sdk/src/windowsSystemTools.ts`, which resolves the
 * three tools that package shells out to. Deliberately a copy rather than an
 * import: `@ade-dev/sdk` ships standalone to npm and cannot depend on this repo, so
 * a shared module would have to be published too. The kernel alias below, the
 * canonical-path check, and the escape check are the parts that must stay
 * identical — if you change any of them here, change them there.
 */
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

export type WindowsAclRunner = (
  command: string,
  args: string[],
) => { status: number | null; stderr?: string; error?: unknown };

export type WindowsOwnerOnlyAclOptions = {
  aclRunner?: WindowsAclRunner;
  currentUser?: string;
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

function resolveCurrentWindowsUser(): string {
  const username = process.env.USERNAME?.trim() || os.userInfo().username.trim();
  if (!username) throw new Error("Unable to resolve the current Windows user for an owner-only ACL.");
  const domain = process.env.USERDOMAIN?.trim();
  return domain && !username.includes("\\") ? `${domain}\\${username}` : username;
}

/**
 * Remove inherited access and grant the current Windows user full control.
 * Callers inject `aclRunner` in tests; production always resolves icacls from
 * the trusted System32 path so a poisoned PATH cannot change credential ACLs.
 */
export function applyWindowsOwnerOnlyAcl(
  targetPath: string,
  options: WindowsOwnerOnlyAclOptions = {},
): void {
  const currentUser = options.currentUser?.trim() || resolveCurrentWindowsUser();
  const command = resolveTrustedWindowsTool("icacls");
  const args = [targetPath, "/inheritance:r", "/grant:r", `${currentUser}:F`];
  const result = options.aclRunner
    ? options.aclRunner(command, args)
    : (() => {
      const spawned = nodeSpawnSync(command, args, { encoding: "utf8", windowsHide: true });
      return { status: spawned.status, stderr: spawned.stderr ?? "", error: spawned.error };
    })();
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(`Unable to secure Windows path with icacls${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * The knobs every ADE-owned private directory and file takes.
 *
 * One type rather than one per module: the three call sites (harness preset
 * homes, the CLIProxyAPI supervisor, the provider-instance store) all mean the
 * same three things by it, and a second spelling is how a Windows-only field
 * gets forgotten on one of them.
 */
export type PrivateFileSecurityOptions = WindowsOwnerOnlyAclOptions & {
  platform?: NodeJS.Platform;
};

/**
 * Directories this process has already given an owner-only ACL.
 *
 * WHY: `icacls` is a process spawn, and launches re-enter these helpers on
 * every chat/CLI start for a directory ADE created on an earlier one. The ACL
 * is a property of the directory, not of the launch, so re-running it per
 * launch only buys latency on the one platform that can least afford a spawn.
 * Scoped to the process so a directory that is removed and re-created (see
 * `forgetSecuredPrivatePath`) is secured again rather than trusted blindly.
 */
const securedPrivatePaths = new Set<string>();

function securedPrivatePathKey(targetPath: string, platform: NodeJS.Platform): string {
  return `${platform}:${pathKey(path.resolve(targetPath), platform)}`;
}

/** Drop a path from the ACL cache — call after deleting an ADE-owned tree. */
export function forgetSecuredPrivatePath(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  securedPrivatePaths.delete(securedPrivatePathKey(targetPath, platform));
}

/** Apply the owner-only ACL on Windows; a no-op everywhere else. */
export function securePrivatePath(
  targetPath: string,
  options: PrivateFileSecurityOptions = {},
): void {
  if ((options.platform ?? process.platform) !== "win32") return;
  applyWindowsOwnerOnlyAcl(targetPath, options);
}

/**
 * Create (or adopt) a directory only its owner can read.
 *
 * POSIX gets mode 0700 on creation and a best-effort chmod for a directory an
 * earlier version left more permissive. Windows gets the icacls grant at most
 * once per path per process — see `securedPrivatePaths`.
 */
export function ensurePrivateDirectory(
  directoryPath: string,
  options: PrivateFileSecurityOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const created = fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    try {
      fs.chmodSync(directoryPath, 0o700);
    } catch {
      // Some filesystems do not support chmod; the creation mode still applies.
    }
    return;
  }
  const key = securedPrivatePathKey(directoryPath, platform);
  // Node returns the path it created for a recursive mkdir and undefined when
  // the complete directory already existed. A newly recreated directory must
  // be ACL'd again even when its comparison key is still cached.
  if (created === undefined && securedPrivatePaths.has(key)) return;
  securePrivatePath(directoryPath, options);
  securedPrivatePaths.add(key);
}

/**
 * Write a file only its owner can read, inside a directory already made
 * private by {@link ensurePrivateDirectory}.
 *
 * WHY no per-file icacls: the directory grant `icacls <dir> /grant:r user:F`
 * is object- and container-inheriting, so a file created underneath already
 * carries exactly that ACE. Re-running icacls per file spawned one process per
 * credential file written on every launch and changed nothing about the result.
 */
export function writePrivateFile(
  filePath: string,
  contents: string,
  options: PrivateFileSecurityOptions = {},
): void {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  if ((options.platform ?? process.platform) !== "win32") {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // The containing private directory remains the fallback boundary.
    }
  }
}
