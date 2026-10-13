/**
 * Where ADE's pinned Meta Muse Code binary (`muse`) lives, and how to get it.
 *
 * Muse is not on npm and each platform build is 330-470 MB, so ADE does not
 * bundle it: the agent-tools cache fetches one exact build (pinned in
 * `apps/ade-cli/scripts/muse-release.json`, checked by sha256) into the shared
 * machine tools cache. This module is the only way the desktop app and the
 * brain find that binary.
 *
 * Pinned only. A user's own `muse` (Meta's installer puts it on PATH) is never
 * used to run a chat or a tracked CLI: its version drifts from the SDK ADE was
 * built against and it may self-update under a running session. It is reported
 * as "detected" for information and nothing else.
 */
import fs from "node:fs";
import os from "node:os";
import { cachedToolEntryPath, pinnedToolFetchPending } from "../../../../../ade-cli/src/services/tools/cacheLookup";
import { isToolError } from "../../../../../ade-cli/src/services/tools/errors";
import { ensureTools, type ToolProgress } from "../../../../../ade-cli/src/services/tools/install";
import { findToolTargetPin, loadToolsManifest } from "../../../../../ade-cli/src/services/tools/manifest";
import { detectToolTarget } from "../../../../../ade-cli/src/services/tools/paths";
import type { MuseBinaryStatus } from "../../../shared/museBinary";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";

export const MUSE_TOOL_NAME = "muse";

export type MuseExecutableSource =
  /** The pinned build in the machine tools cache. */
  | "tools-cache"
  /** `ADE_MUSE_EXECUTABLE`: a developer pointing ADE at a specific build. */
  | "env-override"
  /** Pinned for this host but not fetched yet (or the fetch failed). */
  | "missing"
  /** This host has no pinned build (e.g. win32-arm64). */
  | "unsupported";

export type MuseExecutableResolution = {
  path: string | null;
  source: MuseExecutableSource;
  /** The pinned build, e.g. `1.4.7-R6101.1`; null on an unsupported host. */
  pinnedVersion: string | null;
};

export type MuseResolveOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
};

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    // Windows has no execute bit; presence is the only signal available.
    if (platform !== "win32") fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The build this ADE pins for the host, or null when it pins none. */
export function pinnedMuseVersion(options: MuseResolveOptions = {}): string | null {
  try {
    const target = detectToolTarget(options.platform ?? process.platform, options.arch ?? os.arch());
    return findToolTargetPin(loadToolsManifest(), MUSE_TOOL_NAME, target).version;
  } catch {
    return null;
  }
}

/**
 * Locate the pinned binary. Never touches the network and never throws.
 */
export function resolveMuseExecutable(options: MuseResolveOptions = {}): MuseExecutableResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pinnedVersion = pinnedMuseVersion(options);

  const override = env.ADE_MUSE_EXECUTABLE?.trim();
  if (override) {
    return isExecutableFile(override, platform)
      ? { path: override, source: "env-override", pinnedVersion }
      : { path: null, source: "missing", pinnedVersion };
  }

  if (!pinnedVersion) return { path: null, source: "unsupported", pinnedVersion: null };

  const cached = cachedToolEntryPath(MUSE_TOOL_NAME, { env, platform, arch: options.arch });
  if (cached && isExecutableFile(cached, platform)) {
    return { path: cached, source: "tools-cache", pinnedVersion };
  }
  return { path: null, source: "missing", pinnedVersion };
}

/**
 * Absolute path to the pinned `muse` / `muse.exe`, or null when it is not on
 * disk yet. The synchronous shape the PTY launch path substitutes for a bare
 * `muse` in a CLI launch line.
 */
export function resolveMuseBinaryPath(options: MuseResolveOptions = {}): string | null {
  return resolveMuseExecutable(options).path;
}

/**
 * True while the pinned build is supported here but not downloaded yet, so a
 * caller can say "Muse is still downloading" instead of "Muse is missing".
 */
export function museFetchPending(options: MuseResolveOptions = {}): boolean {
  if ((options.env ?? process.env).ADE_MUSE_EXECUTABLE?.trim()) return false;
  return pinnedToolFetchPending(MUSE_TOOL_NAME, {
    env: options.env,
    platform: options.platform,
    arch: options.arch,
  });
}

/**
 * A user's own Muse install on PATH or in a known bin dir. Information only:
 * Settings shows it as "also installed", nothing ever spawns it.
 */
export function detectUserInstalledMuse(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveExecutableFromKnownLocations("muse", env)?.path ?? null;
}

export type EnsureMuseOptions = MuseResolveOptions & {
  onProgress?: (progress: ToolProgress) => void;
};

let inFlightEnsure: Promise<string> | null = null;
const progressListeners = new Set<(progress: ToolProgress) => void>();
let fetchProgress: { receivedBytes: number | null; totalBytes: number | null } | null = null;
let lastFetchError: { kind: string; message: string } | null = null;

/**
 * Return the pinned binary's path, fetching it first when it is missing.
 *
 * Concurrent callers in this process share one fetch and all see its
 * progress; other processes (the brain, another ADE channel) are serialized
 * by the tools cache's own lock. Throws the tools cache's `ToolError` (kinds
 * `unsupported-target`, `network`, `integrity`, `disk-space`, `lock-timeout`,
 * `filesystem`) on failure.
 */
export async function ensureMuseBinary(options: EnsureMuseOptions = {}): Promise<string> {
  const existing = resolveMuseExecutable(options);
  if (existing.path) return existing.path;
  const listener = options.onProgress;
  if (listener) progressListeners.add(listener);
  try {
    if (!inFlightEnsure) {
      lastFetchError = null;
      fetchProgress = { receivedBytes: 0, totalBytes: null };
      inFlightEnsure = ensureTools([MUSE_TOOL_NAME], {
        env: options.env,
        platform: options.platform,
        arch: options.arch,
        onProgress: (progress) => {
          fetchProgress = {
            receivedBytes: progress.receivedBytes ?? fetchProgress?.receivedBytes ?? null,
            totalBytes: progress.totalBytes ?? fetchProgress?.totalBytes ?? null,
          };
          for (const notify of progressListeners) notify(progress);
        },
      })
        .then((resolved) => {
          const entry = resolved.get(MUSE_TOOL_NAME)?.entryPath;
          if (!entry) throw new Error("The Muse binary fetch finished without a binary.");
          return entry;
        })
        .catch((error: unknown) => {
          lastFetchError = {
            kind: isToolError(error) ? error.kind : "filesystem",
            message: error instanceof Error ? error.message : String(error),
          };
          throw error;
        })
        .finally(() => {
          inFlightEnsure = null;
          fetchProgress = null;
        });
    }
    return await inFlightEnsure;
  } finally {
    if (listener) progressListeners.delete(listener);
  }
}

/** Where the pinned binary stands on this machine. No spawn, no network. */
export function getMuseBinaryStatus(options: MuseResolveOptions = {}): MuseBinaryStatus {
  const resolved = resolveMuseExecutable(options);
  const base = {
    path: resolved.path,
    pinnedVersion: resolved.pinnedVersion,
    receivedBytes: null,
    totalBytes: null,
    errorKind: null,
    error: null,
  };
  if (resolved.path) return { ...base, state: "installed" };
  if (resolved.source === "unsupported") return { ...base, state: "unsupported" };
  if (inFlightEnsure) {
    return {
      ...base,
      state: "downloading",
      receivedBytes: fetchProgress?.receivedBytes ?? null,
      totalBytes: fetchProgress?.totalBytes ?? null,
    };
  }
  if (lastFetchError) {
    return { ...base, state: "failed", errorKind: lastFetchError.kind, error: lastFetchError.message };
  }
  return { ...base, state: "missing" };
}

/**
 * Start fetching the pinned binary if it is missing, and return at once.
 *
 * Returning before the download ends is the point: it is 330-470 MB, and a
 * remote caller's action call must not sit open for minutes. Callers poll
 * {@link getMuseBinaryStatus} for progress.
 */
export function startMuseBinaryFetch(options: MuseResolveOptions = {}): MuseBinaryStatus {
  const status = getMuseBinaryStatus(options);
  if (status.state === "missing" || status.state === "failed") {
    void ensureMuseBinary(options).catch(() => {
      // Recorded in lastFetchError and reported by getMuseBinaryStatus.
    });
    return getMuseBinaryStatus(options);
  }
  return status;
}
