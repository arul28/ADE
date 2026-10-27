import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureError } from "../../../../desktop/src/shared/sentry/capture";
import { ToolError, asToolError } from "./errors";
import {
  type FreeSpaceReader,
  estimateFileToolRequiredBytes,
  estimateToolRequiredBytes,
  readFreeBytes,
  TOOL_SPACE_HEADROOM_BYTES,
} from "./diskSpace";
import { type ToolDownloadResult, type ToolDownloader, downloadToolTarball, fileSha256 } from "./download";
import { type ToolExtractor, applyDecompressSteps, extractArchive, extractNpmTarball } from "./extract";
import { recordPinnedPackages, readToolsLedger, RETIRED_PACKAGE_GRACE_MS, writeToolsLedger } from "./ledger";
import { acquireToolLock, type ToolLockOptions } from "./lock";
import { collectToolVersionOverrides, readToolVersionOverrides } from "./overrides";
import {
  type ToolDecompressStep,
  type ToolPin,
  type ToolTargetPin,
  type ToolsManifest,
  allowedDownloadHosts,
  entryPathForPlatform,
  findToolPin,
  findToolTargetPin,
  loadToolsManifest,
} from "./manifest";
import {
  type ToolTarget,
  TOOL_INSTALL_SENTINEL,
  detectToolTarget,
  isToolInstalled,
  resolveMachineToolsRoot,
  toolLockPath,
  toolPackageDir,
  toolSentinelPath,
  toolSlug,
  toolVersionDir,
  toolsLockRoot,
  toolsStagingRoot,
} from "./paths";

export type ToolResolution = {
  name: string;
  packageName: string;
  version: string;
  target: ToolTarget;
  /** The unpacked package root, equivalent to a `node_modules/<pkg>` directory. */
  dir: string;
  /** Absolute path to the executable or subdirectory consumers actually need. */
  entryPath: string;
  /**
   * Absolute paths of the entry's other named files (`ToolEntry.files`), e.g.
   * Antigravity's `harness` or Qwen's `script`. Empty for a single-file tool.
   */
  files: Record<string, string>;
};

export type ToolProgressPhase =
  | "cached"
  | "waiting"
  | "downloading"
  | "verifying"
  | "extracting"
  | "installed";

export type ToolProgress = {
  tool: string;
  packageName: string;
  version: string;
  phase: ToolProgressPhase;
  receivedBytes?: number;
  totalBytes?: number | null;
};

export type ToolsContext = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  target?: ToolTarget;
  toolsRoot?: string;
  manifest?: ToolsManifest;
  download?: ToolDownloader;
  extract?: ToolExtractor;
  freeBytes?: FreeSpaceReader;
  lock?: Pick<ToolLockOptions, "staleMs" | "pollIntervalMs" | "timeoutMs" | "now" | "sleep">;
};

export type EnsureToolsOptions = ToolsContext & {
  onProgress?: (progress: ToolProgress) => void;
};

export type GcToolsOptions = ToolsContext & {
  /** Keep the newest non-pinned version as a rollback target. Defaults to true. */
  keepPrevious?: boolean;
  dryRun?: boolean;
};

export type GcToolsResult = {
  removed: string[];
  kept: string[];
};

type ResolvedContext = {
  platform: NodeJS.Platform;
  target: ToolTarget;
  toolsRoot: string;
  manifest: ToolsManifest;
};

const STALE_STAGING_MS = 24 * 60 * 60_000;

/**
 * How many times `ensureOneTool` will re-enter itself after the lock reported
 * `satisfied` but the install then read back as absent. One retry covers the
 * ordinary race (the winner's sentinel landed and a GC or a rollback removed it
 * a moment later); a sentinel that keeps flapping is a broken cache directory,
 * and recursing on it forever would pin a core and never surface a diagnosis.
 */
const MAX_SATISFIED_ATTEMPTS = 3;

function resolveContext(context: ToolsContext): ResolvedContext {
  const env = context.env ?? process.env;
  const platform = context.platform ?? process.platform;
  const target = context.target ?? detectToolTarget(platform, context.arch ?? os.arch());
  return {
    platform,
    target,
    toolsRoot: context.toolsRoot ? path.resolve(context.toolsRoot) : resolveMachineToolsRoot(env, platform),
    manifest: context.manifest ?? loadToolsManifest(),
  };
}

/**
 * Expand a package-relative entry path, where a `*` segment matches exactly one
 * directory level. Returns null when nothing matches, which is how a truncated
 * or half-unpacked install is detected.
 */
function expandEntryPath(dir: string, relativePosixPath: string): string | null {
  const segments = relativePosixPath.split("/");
  let candidates = [dir];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of candidates) {
      if (segment !== "*") {
        next.push(path.join(base, segment));
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory()) next.push(path.join(base, entry.name));
      }
    }
    candidates = next;
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * An install counts as usable only when the sentinel is present *and* the
 * declared entry still resolves. Checking both means a truncated extraction
 * that somehow kept its sentinel is re-fetched instead of handed to a caller
 * that will fail to spawn it.
 */
function readInstalledEntry(
  dir: string,
  entryRelativePath: string,
  fileRelativePaths: Record<string, string>,
): { entryPath: string; files: Record<string, string> } | null {
  if (!isToolInstalled(dir)) return null;
  const entryPath = expandEntryPath(dir, entryRelativePath);
  if (!entryPath) return null;
  const files: Record<string, string> = {};
  for (const [name, relativePath] of Object.entries(fileRelativePaths)) {
    const filePath = path.join(dir, ...relativePath.split("/"));
    if (!fs.existsSync(filePath)) return null;
    files[name] = filePath;
  }
  return { entryPath, files };
}

/** Package-relative paths of the entry's named files for a platform. */
function entryFilesForPlatform(pin: ToolPin, platform: NodeJS.Platform): Record<string, string> {
  return Object.fromEntries(
    Object.entries(pin.entry.files ?? {}).map(([name, file]) => [name, entryPathForPlatform(file, platform)]),
  );
}

function resolvePinned(pin: ToolPin, resolved: ResolvedContext): {
  packageName: string;
  version: string;
  dir: string;
  entryRelativePath: string;
  fileRelativePaths: Record<string, string>;
  targetPin: ToolTargetPin;
  pin: ToolPin;
} {
  const targetPin = findToolTargetPin(resolved.manifest, pin.name, resolved.target);
  return {
    packageName: targetPin.package,
    version: targetPin.version,
    dir: toolVersionDir(resolved.toolsRoot, targetPin.package, targetPin.version),
    entryRelativePath: entryPathForPlatform(pin.entry, resolved.platform),
    fileRelativePaths: entryFilesForPlatform(pin, resolved.platform),
    targetPin,
    pin,
  };
}

/** Names of every tool this build pins, in manifest order. */
export function listPinnedTools(context: ToolsContext = {}): string[] {
  return (context.manifest ?? loadToolsManifest()).tools.map((tool) => tool.name);
}

/**
 * Locate an already-installed tool. Never touches the network.
 *
 * Throws `ToolError` with kind `not-installed` when the tool is pinned for this
 * platform but absent — callers turn that into an `ensureTools` call.
 */
export function resolveTool(name: string, context: ToolsContext = {}): ToolResolution {
  const resolved = resolveContext(context);
  const pin = findToolPin(resolved.manifest, name);
  const pinned = resolvePinned(pin, resolved);
  const installed = readInstalledEntry(pinned.dir, pinned.entryRelativePath, pinned.fileRelativePaths);
  if (!installed) {
    throw new ToolError(
      `ADE agent tool ${name} (${pinned.packageName}@${pinned.version}) is not installed on this machine.`,
      {
        kind: "not-installed",
        tool: name,
        packageName: pinned.packageName,
        version: pinned.version,
        target: resolved.target,
      },
    );
  }
  return {
    name,
    packageName: pinned.packageName,
    version: pinned.version,
    target: resolved.target,
    dir: pinned.dir,
    ...installed,
  };
}

const unreadablePackageDirs = new Set<string>();

/**
 * A package's version directories other than `pinnedVersions`: finished
 * installs first, then newest first. One order for `gcTools` (which keeps the
 * first) and `tryResolvePreviousTool` (which runs the first), so the copy
 * collection keeps is the copy a machine mid-update can run.
 */
function supersededVersionDirs(
  packageDir: string,
  pinnedVersions: ReadonlySet<string>,
): { dir: string; version: string; installed: boolean }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packageDir, { withFileTypes: true });
  } catch (error) {
    // Never installed is the ordinary miss. Anything else (permissions, an
    // antivirus or another process holding the folder) is a miss too, so a
    // launch falls through to its next copy and collection tries again
    // later, but a reported one, once per folder: this runs on every launch.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && !unreadablePackageDirs.has(packageDir)) {
      unreadablePackageDirs.add(packageDir);
      captureError(error, {
        tags: { area: "tools-cache", code: code ?? "unknown" },
        fingerprint: ["tools-cache", "unreadable-package-dir", code ?? "unknown"],
        extra: { packageDir },
      });
    }
    return [];
  }
  const superseded: { dir: string; version: string; installed: boolean; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || pinnedVersions.has(entry.name)) continue;
    const dir = path.join(packageDir, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      // Unreadable directories are still collectable.
    }
    superseded.push({ dir, version: entry.name, installed: isToolInstalled(dir), mtimeMs });
  }
  superseded.sort((left, right) => Number(right.installed) - Number(left.installed) || right.mtimeMs - left.mtimeMs);
  return superseded.map(({ mtimeMs: _mtimeMs, ...rest }) => rest);
}

/**
 * The version of `name` that `gcTools` keeps after an update, when it is a
 * finished install: a machine still downloading the new pin runs it. Null
 * when there is none. Never touches the network.
 */
export function tryResolvePreviousTool(name: string, context: ToolsContext = {}): ToolResolution | null {
  const resolved = resolveContext(context);
  const pinned = resolvePinned(findToolPin(resolved.manifest, name), resolved);
  // A vendor-forced override is not a previous pin; it resolves on its own terms.
  const overrideVersions = readToolVersionOverrides({ toolsRoot: resolved.toolsRoot })
    .filter((entry) => entry.packageName === pinned.packageName)
    .map((entry) => entry.overrideVersion);
  const [previous] = supersededVersionDirs(
    toolPackageDir(resolved.toolsRoot, pinned.packageName),
    new Set([pinned.version, ...overrideVersions]),
  );
  const installed = previous ? readInstalledEntry(previous.dir, pinned.entryRelativePath, pinned.fileRelativePaths) : null;
  if (!previous || !installed) return null;
  return {
    name,
    packageName: pinned.packageName,
    version: previous.version,
    target: resolved.target,
    dir: previous.dir,
    ...installed,
  };
}

export function tryResolveTool(name: string, context: ToolsContext = {}): ToolResolution | null {
  try {
    return resolveTool(name, context);
  } catch (error) {
    if (error instanceof ToolError && error.kind === "not-installed") return null;
    throw error;
  }
}

/**
 * Fetch every named tool that is missing, then return all of them resolved.
 *
 * Serial on purpose: these are 100-300 MB downloads and running them
 * concurrently only trades install latency for a much worse disk-full profile.
 */
export async function ensureTools(
  names: string[],
  options: EnsureToolsOptions = {},
): Promise<Map<string, ToolResolution>> {
  const resolved = resolveContext(options);
  const result = new Map<string, ToolResolution>();
  for (const name of names) {
    result.set(name, await ensureOneTool(name, resolved, options));
  }
  return result;
}

async function ensureOneTool(
  name: string,
  resolved: ResolvedContext,
  options: EnsureToolsOptions,
  /** Internal: bounds the `satisfied`-but-absent retry. Not part of `ensureTools`. */
  attempt = 1,
): Promise<ToolResolution> {
  const pin = findToolPin(resolved.manifest, name);
  const pinned = resolvePinned(pin, resolved);
  const report = (phase: ToolProgressPhase, extra: Partial<ToolProgress> = {}) => {
    options.onProgress?.({
      tool: name,
      packageName: pinned.packageName,
      version: pinned.version,
      phase,
      ...extra,
    });
  };
  const resolveInstalled = (): ToolResolution | null => {
    const installed = readInstalledEntry(pinned.dir, pinned.entryRelativePath, pinned.fileRelativePaths);
    if (!installed) return null;
    return {
      name,
      packageName: pinned.packageName,
      version: pinned.version,
      target: resolved.target,
      dir: pinned.dir,
      ...installed,
    };
  };

  const cached = resolveInstalled();
  if (cached) {
    report("cached");
    return cached;
  }

  const acquisition = await acquireToolLock({
    ...options.lock,
    lockPath: toolLockPath(resolved.toolsRoot, pinned.packageName, pinned.version),
    isSatisfied: () => resolveInstalled() != null,
    onWait: () => report("waiting"),
  });
  if (acquisition.kind === "satisfied") {
    const winner = resolveInstalled();
    if (winner) {
      report("cached");
      return winner;
    }
    // The sentinel disappeared between the poll and the read. Retry — bounded,
    // so a sentinel that keeps flapping fails loudly instead of recursing
    // forever — and install it ourselves rather than report a phantom success.
    if (attempt >= MAX_SATISFIED_ATTEMPTS) {
      throw new ToolError(
        `ADE agent tool ${name} (${pinned.packageName}@${pinned.version}) reported a completed install `
        + `${MAX_SATISFIED_ATTEMPTS} times without one being there: its ${TOOL_INSTALL_SENTINEL} sentinel in `
        + `${pinned.dir} keeps appearing and vanishing. Remove that directory and retry.`,
        {
          kind: "filesystem",
          tool: name,
          packageName: pinned.packageName,
          version: pinned.version,
          target: resolved.target,
        },
      );
    }
    return await ensureOneTool(name, resolved, options, attempt + 1);
  }

  try {
    const afterLock = resolveInstalled();
    if (afterLock) {
      report("cached");
      return afterLock;
    }
    // A directory without a usable entry is a crashed install, not a cache hit.
    await fsp.rm(pinned.dir, { recursive: true, force: true });
    await installPinnedTool({ name, pinned, resolved, options, report });
    const installed = resolveInstalled();
    if (!installed) {
      throw new ToolError(
        `ADE agent tool ${name} unpacked without its expected entry ${pinned.entryRelativePath}.`,
        { kind: "extract", tool: name, packageName: pinned.packageName, version: pinned.version },
      );
    }
    report("installed");
    return installed;
  } finally {
    await acquisition.release();
  }
}

type InstallArgs = {
  name: string;
  pinned: ReturnType<typeof resolvePinned>;
  resolved: ResolvedContext;
  options: EnsureToolsOptions;
  report: (phase: ToolProgressPhase, extra?: Partial<ToolProgress>) => void;
};

function diskSpaceError(args: InstallArgs, required: number, available: number): ToolError {
  const { name, pinned } = args;
  return new ToolError(
    `Not enough free disk space to install ${pinned.packageName}@${pinned.version}: `
    + `${formatBytes(required)} required, ${formatBytes(available)} available.`,
    {
      kind: "disk-space",
      tool: name,
      packageName: pinned.packageName,
      version: pinned.version,
      requiredBytes: required,
      availableBytes: available,
    },
  );
}

async function writeSentinel(payloadDir: string, args: InstallArgs, digest: Record<string, string>): Promise<void> {
  await fsp.writeFile(
    path.join(payloadDir, TOOL_INSTALL_SENTINEL),
    `${JSON.stringify(
      {
        tool: args.name,
        package: args.pinned.packageName,
        version: args.pinned.version,
        target: args.resolved.target,
        ...digest,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function installPinnedTool(args: InstallArgs): Promise<void> {
  const { name, pinned, resolved } = args;
  const stagingRoot = toolsStagingRoot(resolved.toolsRoot);
  await fsp.mkdir(stagingRoot, { recursive: true });
  const stagingDir = await fsp.mkdtemp(path.join(stagingRoot, `${toolSlug(pinned.packageName, pinned.version)}-`));
  const payloadDir = path.join(stagingDir, "payload");

  try {
    const targetPin = pinned.targetPin;
    let digest: Record<string, string>;
    if (targetPin.format === "file") {
      digest = await installFilePin(args, targetPin, payloadDir);
    } else if (targetPin.format === "archive") {
      digest = await installArchivePin(args, targetPin, stagingDir, payloadDir);
    } else if (targetPin.format === "npm-tree") {
      digest = await installNpmTreePin(args, targetPin, stagingDir, payloadDir);
    } else {
      digest = await installNpmTarballPin(args, targetPin, stagingDir, payloadDir);
    }
    await finalizePayload(args, payloadDir, digest);
    // Recorded before the rename, so a crash between the two leaves at worst
    // a ledger name with nothing on disk, never a directory GC cannot see.
    await recordPinnedPackages(resolved.toolsRoot, [pinned.packageName]);
    await promotePayload(payloadDir, pinned.dir);
  } catch (error) {
    throw asToolError(error, {
      kind: "filesystem",
      tool: name,
      packageName: pinned.packageName,
      version: pinned.version,
    });
  } finally {
    // Partial downloads and half-extracted trees never survive a failure.
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function integrityError(args: InstallArgs, detail: string): ToolError {
  const { name, pinned } = args;
  return new ToolError(`Integrity check failed for ${pinned.packageName}@${pinned.version}: ${detail}.`, {
    kind: "integrity",
    tool: name,
    packageName: pinned.packageName,
    version: pinned.version,
  });
}

function missingEntryError(args: InstallArgs, relativePath: string): ToolError {
  const { name, pinned } = args;
  return new ToolError(
    `${pinned.packageName}@${pinned.version} does not contain its expected entry ${relativePath}.`,
    { kind: "extract", tool: name, packageName: pinned.packageName, version: pinned.version },
  );
}

/**
 * The last step before the sentinel, shared by every format: inflate any
 * compressed files, check the entry and every named file are there, and mark
 * executables runnable. Only a payload that passes all of it gets a sentinel,
 * so a partial or mis-shaped install is never resolvable.
 */
async function finalizePayload(args: InstallArgs, payloadDir: string, digest: Record<string, string>): Promise<void> {
  const { pinned, resolved } = args;
  const steps: readonly ToolDecompressStep[] =
    pinned.targetPin.format === "npm-tarball" || pinned.targetPin.format === "archive"
      ? pinned.targetPin.decompress ?? []
      : [];
  if (steps.length) {
    args.report("extracting");
    await applyDecompressSteps(payloadDir, steps);
  }

  const entryPath = expandEntryPath(payloadDir, pinned.entryRelativePath);
  if (!entryPath) throw missingEntryError(args, pinned.entryRelativePath);
  const executables = pinned.pin.entry.kind === "binary" ? [entryPath] : [];
  for (const [fileName, relativePath] of Object.entries(pinned.fileRelativePaths)) {
    const filePath = path.join(payloadDir, ...relativePath.split("/"));
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(filePath);
    } catch {
      throw missingEntryError(args, relativePath);
    }
    if (!stats.isFile()) throw missingEntryError(args, relativePath);
    if (pinned.pin.entry.files?.[fileName]?.executable) executables.push(filePath);
  }
  // Windows has no execute bit; everywhere else every binary must be runnable,
  // whatever mode the archive carried (a zip made on Windows carries none).
  if (resolved.platform !== "win32") {
    for (const executable of executables) await fsp.chmod(executable, 0o755);
  }

  await writeSentinel(payloadDir, args, digest);
}

/**
 * The download every pinned format shares. The disk-space preflight runs once
 * the headers arrive (`requiredBytes` is given the declared Content-Length, or
 * null), and progress reports under the `downloading` phase, falling back to
 * the pin's own size when the server sends no Content-Length. The URL and
 * every redirect must stay on the pin's allowed hosts.
 */
async function downloadWithPreflight(
  args: InstallArgs,
  request: {
    url: string;
    destPath: string;
    /** The pin's exact size, when it has one. Seeds progress and the progress fallback. */
    pinnedBytes: number | null;
    requiredBytes: (declaredBytes: number | null) => number;
    /** Ask the downloader for sha256 as well (vendor pins); npm tarballs verify on sha512 alone. */
    sha256?: boolean;
    maxBytes?: number;
    /** Progress for one part of a multi-download pin; defaults to reporting this download alone. */
    onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
  },
): Promise<ToolDownloadResult> {
  const { name, pinned, resolved, options, report } = args;
  const download: ToolDownloader = options.download ?? downloadToolTarball;
  const freeBytes = options.freeBytes ?? readFreeBytes;
  const progress = request.onProgress
    ?? ((receivedBytes: number, totalBytes: number | null) =>
      report("downloading", { receivedBytes, totalBytes: totalBytes ?? request.pinnedBytes }));

  progress(0, request.pinnedBytes);
  return await download(request.url, request.destPath, {
    onSize: (declaredBytes) => {
      const available = freeBytes(resolved.toolsRoot);
      const required = request.requiredBytes(declaredBytes);
      if (available !== null && available < required) throw diskSpaceError(args, required, available);
    },
    onProgress: ({ receivedBytes, totalBytes }) => progress(receivedBytes, totalBytes),
    allowedHosts: allowedDownloadHosts(name, pinned.targetPin),
    ...(request.sha256 ? { sha256: true as const } : {}),
    ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
  });
}

async function installNpmTarballPin(
  args: InstallArgs,
  targetPin: Extract<ToolTargetPin, { format: "npm-tarball" }>,
  stagingDir: string,
  payloadDir: string,
): Promise<Record<string, string>> {
  const { report } = args;
  const extract = args.options.extract ?? extractNpmTarball;
  const archivePath = path.join(stagingDir, "package.tgz");

  const downloaded = await downloadWithPreflight(args, {
    url: targetPin.tarball,
    destPath: archivePath,
    pinnedBytes: null,
    requiredBytes: (declaredBytes) => estimateToolRequiredBytes(declaredBytes),
  });

  report("verifying");
  if (downloaded.integrity !== targetPin.integrity) {
    throw integrityError(args, `expected ${targetPin.integrity}, got ${downloaded.integrity}`);
  }

  report("extracting");
  await extract(archivePath, payloadDir);
  // The archive is no longer needed and doubles the peak footprint.
  await fsp.rm(archivePath, { force: true });
  return { integrity: targetPin.integrity };
}

/**
 * A bare-executable pin: the download is written straight to the entry path
 * inside the payload directory, checked against the vendor's sha256 and byte
 * size. Nothing is unpacked. The body may not grow past the pinned size.
 */
async function installFilePin(
  args: InstallArgs,
  targetPin: Extract<ToolTargetPin, { format: "file" }>,
  payloadDir: string,
): Promise<Record<string, string>> {
  const { pinned } = args;
  const filePath = path.join(payloadDir, ...pinned.entryRelativePath.split("/"));

  const downloaded = await downloadWithPreflight(args, {
    url: targetPin.url,
    destPath: filePath,
    pinnedBytes: targetPin.size,
    // The pin carries the exact size, so the preflight never depends on the
    // server sending Content-Length.
    requiredBytes: () => estimateFileToolRequiredBytes(targetPin.size),
    sha256: true,
    maxBytes: targetPin.size,
  });

  args.report("verifying");
  const actualSha256 = downloaded.sha256 ?? await fileSha256(filePath);
  if (downloaded.bytes !== targetPin.size || actualSha256 !== targetPin.sha256) {
    throw integrityError(
      args,
      `expected sha256 ${targetPin.sha256} (${targetPin.size} bytes), got ${actualSha256} (${downloaded.bytes} bytes)`,
    );
  }
  return { sha256: targetPin.sha256 };
}

/**
 * A vendor release archive: downloaded whole, checked against the pinned
 * sha256 and size, and only then unpacked. Nothing is read out of an archive
 * whose bytes are not exactly the pinned ones.
 */
async function installArchivePin(
  args: InstallArgs,
  targetPin: Extract<ToolTargetPin, { format: "archive" }>,
  stagingDir: string,
  payloadDir: string,
): Promise<Record<string, string>> {
  const archivePath = path.join(stagingDir, `archive.${targetPin.archive}`);
  const downloaded = await downloadWithPreflight(args, {
    url: targetPin.url,
    destPath: archivePath,
    pinnedBytes: targetPin.size,
    requiredBytes: () => estimateToolRequiredBytes(targetPin.size),
    sha256: true,
    maxBytes: targetPin.size,
  });

  args.report("verifying");
  const actualSha256 = downloaded.sha256 ?? await fileSha256(archivePath);
  if (downloaded.bytes !== targetPin.size || actualSha256 !== targetPin.sha256) {
    throw integrityError(
      args,
      `expected sha256 ${targetPin.sha256} (${targetPin.size} bytes), got ${actualSha256} (${downloaded.bytes} bytes)`,
    );
  }

  args.report("extracting");
  await extractArchive(archivePath, payloadDir, {
    archive: targetPin.archive,
    stripComponents: targetPin.stripComponents,
  });
  await fsp.rm(archivePath, { force: true });
  return { sha256: targetPin.sha256 };
}

/** Parallel registry downloads for a tree pin; dozens of small tarballs, not one big one. */
const NPM_TREE_DOWNLOAD_CONCURRENCY = 6;

/**
 * A dependency tree: every package downloaded from the registry, checked
 * against its own SRI, and unpacked at its lockfile path, so the payload is
 * the exact `node_modules` layout npm would have produced. No install script
 * of any package runs. A tree whose download or check fails anywhere leaves
 * nothing behind (the whole staging dir goes).
 */
async function installNpmTreePin(
  args: InstallArgs,
  targetPin: Extract<ToolTargetPin, { format: "npm-tree" }>,
  stagingDir: string,
  payloadDir: string,
): Promise<Record<string, string>> {
  const { resolved, options, report } = args;
  const extract = options.extract ?? extractNpmTarball;
  const totalBytes = targetPin.packages.reduce((sum, entry) => sum + entry.size, 0);
  const required = totalBytes + targetPin.unpackedSize + TOOL_SPACE_HEADROOM_BYTES;
  const available = (options.freeBytes ?? readFreeBytes)(resolved.toolsRoot);
  if (available !== null && available < required) throw diskSpaceError(args, required, available);

  const received = new Map<string, number>();
  const reportTotal = () => {
    let sum = 0;
    for (const bytes of received.values()) sum += bytes;
    report("downloading", { receivedBytes: sum, totalBytes });
  };
  const archivesDir = path.join(stagingDir, "tarballs");
  await fsp.mkdir(archivesDir, { recursive: true });

  // Parents first, so a nested `node_modules` lands inside an unpacked parent
  // rather than the parent being unpacked over it.
  const ordered = [...targetPin.packages].sort((left, right) => left.path.length - right.path.length);
  const archives = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < ordered.length) {
      const entry = ordered[next++]!;
      const archivePath = path.join(archivesDir, `${archives.size}-${path.basename(entry.path)}.tgz`);
      archives.set(entry.path, archivePath);
      const downloaded = await downloadWithPreflight(args, {
        url: entry.tarball,
        destPath: archivePath,
        pinnedBytes: entry.size,
        // Checked once for the whole tree above.
        requiredBytes: () => 0,
        maxBytes: entry.size,
        onProgress: (bytes) => {
          received.set(entry.path, bytes);
          reportTotal();
        },
      });
      if (downloaded.integrity !== entry.integrity) {
        throw integrityError(args, `${entry.path}: expected ${entry.integrity}, got ${downloaded.integrity}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(NPM_TREE_DOWNLOAD_CONCURRENCY, ordered.length) }, worker));

  report("verifying");
  report("extracting");
  for (const entry of ordered) {
    const archivePath = archives.get(entry.path)!;
    await extract(archivePath, path.join(payloadDir, ...entry.path.split("/")));
    await fsp.rm(archivePath, { force: true });
  }
  return { packages: String(ordered.length) };
}

/**
 * Atomic publish: a fully-populated staging directory is renamed into place, so
 * a reader either sees no directory or sees a complete one. Same-volume by
 * construction — staging lives under the tools root.
 */
async function promotePayload(payloadDir: string, targetDir: string): Promise<void> {
  await fsp.mkdir(path.dirname(targetDir), { recursive: true });
  try {
    await fsp.rename(payloadDir, targetDir);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows and Linux disagree on which errno a non-empty destination gets.
    if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") throw error;
    if (fs.existsSync(toolSentinelPath(targetDir))) return;
    await fsp.rm(targetDir, { recursive: true, force: true });
    await fsp.rename(payloadDir, targetDir);
  }
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MB`;
}

/**
 * Drop cached versions this build no longer pins.
 *
 * With `keepPrevious` (the default) the newest superseded version of each
 * pinned package survives, so a rollback to the previous ADE build does not
 * re-download hundreds of megabytes, and a machine mid-update has a copy to run.
 *
 * A package this manifest does not pin at all is removed only when the ledger
 * (`ledger.ts`) shows ADE wrote it and no ADE build on this machine has pinned
 * it for two weeks: on a machine running two ADE channels, the other channel
 * refreshes what it pins every time it collects. A directory that is not in
 * the ledger is never touched.
 */
export async function gcTools(options: GcToolsOptions = {}): Promise<GcToolsResult> {
  const resolved = resolveContext(options);
  const keepPrevious = options.keepPrevious !== false;
  const removed: string[] = [];
  const kept: string[] = [];

  const pinnedVersionsByPackage = new Map<string, Set<string>>();
  for (const tool of resolved.manifest.tools) {
    for (const targetPin of Object.values(tool.targets)) {
      if (!targetPin) continue;
      const versions = pinnedVersionsByPackage.get(targetPin.package) ?? new Set<string>();
      versions.add(targetPin.version);
      pinnedVersionsByPackage.set(targetPin.package, versions);
    }
  }

  // A vendor-forced newer build (`overrides.ts`) is kept like a pin, and kept
  // out of the superseded ranking so the real previous pin survives beside it.
  const overrideVersions = await collectToolVersionOverrides(resolved.toolsRoot, pinnedVersionsByPackage, {
    dryRun: options.dryRun === true,
  });
  const presentPinnedPackages: string[] = [];
  for (const [packageName, pinnedVersions] of pinnedVersionsByPackage) {
    const packageDir = toolPackageDir(resolved.toolsRoot, packageName);
    if (fs.existsSync(packageDir)) presentPinnedPackages.push(packageName);
    const keptVersions = new Set([...pinnedVersions, ...(overrideVersions.get(packageName) ?? [])]);
    for (const version of keptVersions) {
      const versionDir = toolVersionDir(resolved.toolsRoot, packageName, version);
      if (fs.existsSync(versionDir)) kept.push(versionDir);
    }
    const superseded = supersededVersionDirs(packageDir, keptVersions);
    const doomed = keepPrevious ? superseded.slice(1) : superseded;
    if (keepPrevious && superseded[0]) kept.push(superseded[0].dir);
    for (const candidate of doomed) {
      if (!options.dryRun) await fsp.rm(candidate.dir, { recursive: true, force: true });
      removed.push(candidate.dir);
    }
  }

  await collectRetiredPackages(resolved.toolsRoot, pinnedVersionsByPackage, presentPinnedPackages, options.dryRun === true, removed);
  await collectStaleScratch(resolved.toolsRoot, options.dryRun === true, removed);
  return { removed, kept };
}

/**
 * Refresh the ledger for every package this build pins and has on disk, then
 * remove ledger packages no build has pinned within the grace period.
 */
async function collectRetiredPackages(
  toolsRoot: string,
  pinnedVersionsByPackage: ReadonlyMap<string, ReadonlySet<string>>,
  presentPinnedPackages: readonly string[],
  dryRun: boolean,
  removed: string[],
): Promise<void> {
  const now = Date.now();
  const ledger = await readToolsLedger(toolsRoot);
  for (const packageName of presentPinnedPackages) ledger.packages[packageName] = now;
  const root = path.resolve(toolsRoot);
  for (const [packageName, lastPinnedAt] of Object.entries(ledger.packages)) {
    if (pinnedVersionsByPackage.has(packageName) || now - lastPinnedAt < RETIRED_PACKAGE_GRACE_MS) continue;
    const packageDir = toolPackageDir(root, packageName);
    // The ledger is a file on disk; the name was validated when read, and the
    // directory must still resolve under the tools root.
    const relative = path.relative(root, packageDir);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (fs.existsSync(packageDir)) {
      if (!dryRun) {
        try {
          await fsp.rm(packageDir, { recursive: true, force: true });
        } catch {
          // In use (a running binary on Windows) or unreadable: keep the ledger
          // entry so the next collection tries again.
          continue;
        }
        await removeEmptyScopeDir(root, packageDir);
      }
      removed.push(packageDir);
    }
    if (!dryRun) delete ledger.packages[packageName];
  }
  if (!dryRun) await writeToolsLedger(toolsRoot, ledger).catch(() => undefined);
}

/** `@scope/name` leaves `@scope/` behind; drop it once it holds nothing. */
async function removeEmptyScopeDir(root: string, packageDir: string): Promise<void> {
  const parent = path.dirname(packageDir);
  if (parent === root || !path.basename(parent).startsWith("@")) return;
  try {
    if ((await fsp.readdir(parent)).length === 0) await fsp.rmdir(parent);
  } catch {
    // Someone else is installing into the scope; leave it.
  }
}

/** Abandoned staging dirs and orphaned locks from processes that died mid-install. */
async function collectStaleScratch(toolsRoot: string, dryRun: boolean, removed: string[]): Promise<void> {
  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const scratchRoot of [toolsStagingRoot(toolsRoot), toolsLockRoot(toolsRoot)]) {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(scratchRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const scratchPath = path.join(scratchRoot, entry.name);
      try {
        if ((await fsp.stat(scratchPath)).mtimeMs > cutoff) continue;
      } catch {
        continue;
      }
      if (!dryRun) await fsp.rm(scratchPath, { recursive: true, force: true }).catch(() => undefined);
      removed.push(scratchPath);
    }
  }
}
