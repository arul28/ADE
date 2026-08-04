import { promises as fsp } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ADE_RELEASE_REPO,
  RELEASE_CHECKSUMS_ASSET,
  ReleaseAssetDownloadError,
  downloadReleaseAsset,
  parseSha256Sums,
  releaseAssetUrl,
  runtimeBinaryAssetName,
  runtimeNativeArchiveAssetName,
  sha256File,
} from "../../../../../ade-cli/src/lib/releaseAssets";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";

/**
 * Desktop bundles ship only their own build's `ade-<target>` sidecar, so a
 * mac desktop provisioning a Linux box (or a Windows desktop provisioning a
 * mac) has no local copy of the runtime it needs to upload over SSH. Every
 * release publishes all five targets as stable-named assets, so we fetch the
 * missing sidecar for *this desktop's exact version* -- never `latest`, so the
 * remote can never skew ahead of or behind the desktop that installed it --
 * verify it against that release's SHA256SUMS, and cache it per version.
 */

export type RemoteSidecarSource = "bundled" | "cache" | "release";

export type ResolvedRemoteSidecars = {
  binaryPath: string | null;
  nativeDepsPath: string | null;
  source: RemoteSidecarSource;
};

export type RemoteSidecarFailureKind =
  /** The release tag or one of its assets does not exist (unpublished/dev build). */
  | "unavailable"
  /** Transport failure: DNS, TLS, timeout, proxy, 5xx. */
  | "network"
  /** Downloaded bytes did not match the published SHA256SUMS entry. */
  | "checksum";

export class RemoteSidecarFetchError extends Error {
  readonly kind: RemoteSidecarFailureKind;
  readonly url: string | null;

  constructor(message: string, args: { kind: RemoteSidecarFailureKind; url?: string | null }) {
    super(message);
    this.name = "RemoteSidecarFetchError";
    this.kind = args.kind;
    this.url = args.url ?? null;
  }
}

export type RemoteSidecarDeps = {
  env?: NodeJS.ProcessEnv;
  /** Overrides `<machine ade dir>/runtime-sidecars`. */
  cacheRoot?: string;
  downloadFile?: (url: string, outPath: string) => Promise<void>;
  log?: (event: string, detail: Record<string, unknown>) => void;
};

const SIDECAR_CACHE_DIR_NAME = "runtime-sidecars";
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9_.-]+)?$/;

export function remoteSidecarCacheRoot(deps: RemoteSidecarDeps = {}): string {
  return deps.cacheRoot ?? path.join(resolveMachineAdeDir(deps.env ?? process.env), SIDECAR_CACHE_DIR_NAME);
}

/** `1.2.33` -> `v1.2.33`. Returns null for anything that is not a release tag. */
export function releaseTagForAppVersion(appVersion: string): string | null {
  const trimmed = appVersion.trim();
  if (!trimmed) return null;
  const tag = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  return RELEASE_TAG_PATTERN.test(tag) ? tag : null;
}

function defaultLog(event: string, detail: Record<string, unknown>): void {
  console.info(event, detail);
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fsp.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function cachedSidecarPaths(cacheDir: string, archLabel: string): {
  binaryPath: string;
  nativeDepsPath: string;
} {
  return {
    binaryPath: path.join(cacheDir, runtimeBinaryAssetName(archLabel)),
    nativeDepsPath: path.join(cacheDir, runtimeNativeArchiveAssetName(archLabel)),
  };
}

async function readCachedSidecars(
  cacheDir: string,
  archLabel: string,
): Promise<{ binaryPath: string; nativeDepsPath: string } | null> {
  const paths = cachedSidecarPaths(cacheDir, archLabel);
  if (await isFile(paths.binaryPath) && await isFile(paths.nativeDepsPath)) {
    return paths;
  }
  return null;
}

/**
 * Drop sidecar caches for every version except `keepTag`. Best effort: a
 * locked or vanished directory just leaves the bytes on disk for next time.
 */
async function collectSidecarGarbage(cacheRoot: string, keepTag: string): Promise<void> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(cacheRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== keepTag)
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const entry of entries) {
    await fsp.rm(path.join(cacheRoot, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

function fetchErrorFor(args: {
  error: unknown;
  archLabel: string;
  tag: string;
  url: string;
}): RemoteSidecarFetchError {
  const { error, archLabel, tag, url } = args;
  const status = error instanceof ReleaseAssetDownloadError ? error.statusCode : null;
  if (status === 404 || status === 403) {
    return new RemoteSidecarFetchError(
      `The ADE ${tag} release does not publish ${archLabel} runtime assets (HTTP ${status} from ${url}).`,
      { kind: "unavailable", url },
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new RemoteSidecarFetchError(
    `ADE could not download the ${archLabel} runtime it needs to install on this machine.\n`
    + `Tried ${url} (${detail}).\n`
    + `Check this computer's network access to github.com, or run "ade brain update" on the remote machine and reconnect.`,
    { kind: "network", url },
  );
}

async function verifyAgainstReleaseChecksums(args: {
  checksumPath: string;
  archLabel: string;
  tag: string;
  assets: { name: string; filePath: string }[];
}): Promise<void> {
  let sums: Map<string, string>;
  try {
    sums = parseSha256Sums(await fsp.readFile(args.checksumPath, "utf8"));
  } catch (error) {
    throw new RemoteSidecarFetchError(
      `ADE could not read the ${RELEASE_CHECKSUMS_ASSET} published for ${args.tag}: ${
        error instanceof Error ? error.message : String(error)
      }.`,
      { kind: "network" },
    );
  }
  for (const asset of args.assets) {
    const expected = sums.get(asset.name);
    if (!expected) {
      throw new RemoteSidecarFetchError(
        `Refusing to install the ${args.archLabel} ADE runtime: ${args.tag}'s ${RELEASE_CHECKSUMS_ASSET} has no entry for ${asset.name}.`,
        { kind: "checksum" },
      );
    }
    const actual = await sha256File(asset.filePath);
    if (actual !== expected) {
      throw new RemoteSidecarFetchError(
        `Refusing to install the ${args.archLabel} ADE runtime: ${asset.name} downloaded from the ${args.tag} release does not match its published checksum (expected ${expected}, got ${actual}).`,
        { kind: "checksum" },
      );
    }
  }
}

/**
 * Publish a fully verified staging directory as `cacheDir`. Rename is atomic on
 * POSIX and on Windows for a non-existent destination; a concurrent bootstrap
 * that won the race just means we adopt its (equally verified) copy.
 */
async function promoteStagedSidecars(args: {
  stagingDir: string;
  cacheDir: string;
  archLabel: string;
}): Promise<{ binaryPath: string; nativeDepsPath: string }> {
  try {
    await fsp.rename(args.stagingDir, args.cacheDir);
  } catch {
    const cached = await readCachedSidecars(args.cacheDir, args.archLabel);
    if (cached) {
      // Another bootstrap published the same verified assets first.
      await fsp.rm(args.stagingDir, { recursive: true, force: true }).catch(() => undefined);
      return cached;
    }
    // A half-written directory from an interrupted run (or a Windows file lock
    // that has since cleared) must not wedge every future fetch.
    await fsp.rm(args.cacheDir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rename(args.stagingDir, args.cacheDir);
  }
  const cached = await readCachedSidecars(args.cacheDir, args.archLabel);
  if (!cached) {
    throw new RemoteSidecarFetchError(
      `ADE staged the ${args.archLabel} runtime but could not find it at ${args.cacheDir}.`,
      { kind: "network" },
    );
  }
  return cached;
}

/**
 * Resolve the `ade-<target>` binary and native dependency archive to upload to
 * a remote machine, preferring the bundled sidecar, then this version's sidecar
 * cache, then the matching GitHub release.
 *
 * Throws {@link RemoteSidecarFetchError}; callers decide whether a failure is
 * fatal (nothing usable on the remote) or a warning (the remote already runs a
 * usable ADE).
 */
export async function resolveRemoteRuntimeSidecars(
  args: {
    archLabel: string;
    appVersion: string;
    bundledBinaryPath: string | null;
    bundledNativeDepsPath: string | null;
    repo?: string;
  },
  deps: RemoteSidecarDeps = {},
): Promise<ResolvedRemoteSidecars> {
  if (args.bundledBinaryPath) {
    return {
      binaryPath: args.bundledBinaryPath,
      nativeDepsPath: args.bundledNativeDepsPath,
      source: "bundled",
    };
  }

  const log = deps.log ?? defaultLog;
  const tag = releaseTagForAppVersion(args.appVersion);
  if (!tag) {
    throw new RemoteSidecarFetchError(
      `ADE ${args.appVersion || "(unknown version)"} is not a published release, so there are no ${args.archLabel} runtime assets to download.`,
      { kind: "unavailable" },
    );
  }

  const cacheRoot = remoteSidecarCacheRoot(deps);
  const versionDir = path.join(cacheRoot, tag);
  const cacheDir = path.join(versionDir, args.archLabel);
  const cached = await readCachedSidecars(cacheDir, args.archLabel);
  if (cached) {
    log("remote_runtime.sidecar_cache_hit", { arch: args.archLabel, version: tag, path: cacheDir });
    void collectSidecarGarbage(cacheRoot, tag);
    return { binaryPath: cached.binaryPath, nativeDepsPath: cached.nativeDepsPath, source: "cache" };
  }

  const repo = args.repo ?? DEFAULT_ADE_RELEASE_REPO;
  const binaryName = runtimeBinaryAssetName(args.archLabel);
  const nativeArchiveName = runtimeNativeArchiveAssetName(args.archLabel);
  const download = deps.downloadFile
    ?? ((url: string, outPath: string) => downloadReleaseAsset(url, outPath, { userAgent: "ADE remote bootstrap" }));

  await fsp.mkdir(versionDir, { recursive: true });
  const stagingDir = await fsp.mkdtemp(path.join(versionDir, `.staging-${args.archLabel}-`));
  log("remote_runtime.sidecar_fetch_started", { arch: args.archLabel, version: tag, repo });
  try {
    const assets = [
      { name: binaryName, filePath: path.join(stagingDir, binaryName) },
      { name: nativeArchiveName, filePath: path.join(stagingDir, nativeArchiveName) },
    ];
    const checksumPath = path.join(stagingDir, RELEASE_CHECKSUMS_ASSET);
    for (const asset of [...assets, { name: RELEASE_CHECKSUMS_ASSET, filePath: checksumPath }]) {
      const url = releaseAssetUrl(repo, tag, asset.name);
      try {
        await download(url, asset.filePath);
      } catch (error) {
        throw fetchErrorFor({ error, archLabel: args.archLabel, tag, url });
      }
    }
    await verifyAgainstReleaseChecksums({ checksumPath, archLabel: args.archLabel, tag, assets });
    await fsp.rm(checksumPath, { force: true }).catch(() => undefined);
    if (!args.archLabel.startsWith("win32-")) {
      await fsp.chmod(assets[0].filePath, 0o755);
    }
    const promoted = await promoteStagedSidecars({ stagingDir, cacheDir, archLabel: args.archLabel });
    log("remote_runtime.sidecar_fetch_succeeded", {
      arch: args.archLabel,
      version: tag,
      path: cacheDir,
      bytes: fileBytes(promoted.binaryPath) + fileBytes(promoted.nativeDepsPath),
    });
    void collectSidecarGarbage(cacheRoot, tag);
    return { binaryPath: promoted.binaryPath, nativeDepsPath: promoted.nativeDepsPath, source: "release" };
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function fileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
