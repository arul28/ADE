import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolError, asToolError } from "./errors";
import {
  type FreeSpaceReader,
  estimateToolRequiredBytes,
  readFreeBytes,
} from "./diskSpace";
import { type ToolDownloader, downloadToolTarball } from "./download";
import { type ToolExtractor, extractNpmTarball } from "./extract";
import { acquireToolLock, type ToolLockOptions } from "./lock";
import {
  type ToolPin,
  type ToolsManifest,
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
function readInstalledEntry(dir: string, entryRelativePath: string): string | null {
  if (!isToolInstalled(dir)) return null;
  return expandEntryPath(dir, entryRelativePath);
}

function resolvePinned(pin: ToolPin, resolved: ResolvedContext): {
  packageName: string;
  version: string;
  dir: string;
  entryRelativePath: string;
  tarball: string;
  integrity: string;
} {
  const targetPin = findToolTargetPin(resolved.manifest, pin.name, resolved.target);
  return {
    packageName: targetPin.package,
    version: targetPin.version,
    dir: toolVersionDir(resolved.toolsRoot, targetPin.package, targetPin.version),
    entryRelativePath: entryPathForPlatform(pin.entry, resolved.platform),
    tarball: targetPin.tarball,
    integrity: targetPin.integrity,
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
  const entryPath = readInstalledEntry(pinned.dir, pinned.entryRelativePath);
  if (!entryPath) {
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
    entryPath,
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
    const entryPath = readInstalledEntry(pinned.dir, pinned.entryRelativePath);
    if (!entryPath) return null;
    return {
      name,
      packageName: pinned.packageName,
      version: pinned.version,
      target: resolved.target,
      dir: pinned.dir,
      entryPath,
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
    // The sentinel disappeared between the poll and the read. Fall through and
    // install it ourselves rather than reporting a phantom success.
    return await ensureOneTool(name, resolved, options);
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

async function installPinnedTool(args: {
  name: string;
  pinned: ReturnType<typeof resolvePinned>;
  resolved: ResolvedContext;
  options: EnsureToolsOptions;
  report: (phase: ToolProgressPhase, extra?: Partial<ToolProgress>) => void;
}): Promise<void> {
  const { name, pinned, resolved, options, report } = args;
  const download = options.download ?? downloadToolTarball;
  const extract = options.extract ?? extractNpmTarball;
  const freeBytes = options.freeBytes ?? readFreeBytes;

  const stagingRoot = toolsStagingRoot(resolved.toolsRoot);
  await fsp.mkdir(stagingRoot, { recursive: true });
  const stagingDir = await fsp.mkdtemp(path.join(stagingRoot, `${toolSlug(pinned.packageName, pinned.version)}-`));
  const archivePath = path.join(stagingDir, "package.tgz");
  const payloadDir = path.join(stagingDir, "payload");

  try {
    report("downloading", { receivedBytes: 0, totalBytes: null });
    const downloaded = await download(pinned.tarball, archivePath, {
      onSize: (totalBytes) => {
        const available = freeBytes(resolved.toolsRoot);
        const required = estimateToolRequiredBytes(totalBytes);
        if (available !== null && available < required) {
          throw new ToolError(
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
      },
      onProgress: ({ receivedBytes, totalBytes }) => report("downloading", { receivedBytes, totalBytes }),
    });

    report("verifying");
    const actualIntegrity = downloaded.integrity;
    if (actualIntegrity !== pinned.integrity) {
      throw new ToolError(
        `Integrity check failed for ${pinned.packageName}@${pinned.version}: `
        + `expected ${pinned.integrity}, got ${actualIntegrity}.`,
        { kind: "integrity", tool: name, packageName: pinned.packageName, version: pinned.version },
      );
    }

    report("extracting");
    await extract(archivePath, payloadDir);
    if (!expandEntryPath(payloadDir, pinned.entryRelativePath)) {
      throw new ToolError(
        `${pinned.packageName}@${pinned.version} does not contain its expected entry ${pinned.entryRelativePath}.`,
        { kind: "extract", tool: name, packageName: pinned.packageName, version: pinned.version },
      );
    }
    // The archive is no longer needed and doubles the peak footprint.
    await fsp.rm(archivePath, { force: true });

    await fsp.writeFile(
      path.join(payloadDir, TOOL_INSTALL_SENTINEL),
      `${JSON.stringify(
        {
          tool: name,
          package: pinned.packageName,
          version: pinned.version,
          target: resolved.target,
          integrity: pinned.integrity,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

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
 * package survives, so a rollback to the previous ADE build does not re-download
 * hundreds of megabytes. Packages the manifest has never heard of are left
 * alone: on a machine running two ADE channels, an unknown directory is far more
 * likely to belong to the other channel than to be garbage.
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

  for (const [packageName, pinnedVersions] of pinnedVersionsByPackage) {
    const packageDir = toolPackageDir(resolved.toolsRoot, packageName);
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(packageDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const superseded: { dir: string; mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const versionDir = path.join(packageDir, entry.name);
      if (pinnedVersions.has(entry.name)) {
        kept.push(versionDir);
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = (await fsp.stat(versionDir)).mtimeMs;
      } catch {
        // Unreadable directories are still collectable.
      }
      superseded.push({ dir: versionDir, mtimeMs });
    }
    superseded.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const doomed = keepPrevious ? superseded.slice(1) : superseded;
    if (keepPrevious && superseded[0]) kept.push(superseded[0].dir);
    for (const candidate of doomed) {
      if (!options.dryRun) await fsp.rm(candidate.dir, { recursive: true, force: true });
      removed.push(candidate.dir);
    }
  }

  await collectStaleScratch(resolved.toolsRoot, options.dryRun === true, removed);
  return { removed, kept };
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
