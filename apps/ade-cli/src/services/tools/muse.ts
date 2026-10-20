/**
 * Where ADE's pinned Meta Muse Code binary (`muse`) lives, and how to get it.
 *
 * Electron-free: the desktop app and the brain both resolve Muse through this
 * module, so the pinned version, the cache lookup, the background fetch and the
 * status all have one implementation. `apps/desktop/.../museExecutable.ts` is a
 * re-export of it plus the desktop-only blocker text.
 *
 * Muse is not on npm and each platform build is 330-470 MB, so ADE does not
 * bundle it: the agent-tools cache fetches one exact build (pinned in
 * `apps/ade-cli/scripts/muse-release.json`, checked by sha256) into the shared
 * machine tools cache.
 *
 * Pinned only. A user's own `muse` (Meta's installer puts it on PATH) is never
 * used to run a chat or a tracked CLI: its version drifts from the SDK ADE was
 * built against and it may self-update under a running session.
 */
import fs from "node:fs";
import os from "node:os";
import type { MuseBinaryStatus } from "../../../../desktop/src/shared/museBinary";
import { cachedToolEntryPath, pinnedToolFetchPending, previousCachedToolEntryPath } from "./cacheLookup";
import { ToolError, isToolError, type ToolErrorKind } from "./errors";
import { ensureTools, type ToolProgress } from "./install";
import { findToolTargetPin, loadToolsManifest } from "./manifest";
import { resolveActiveToolVersionOverride } from "./overrides";
import { detectToolTarget } from "./paths";

export const MUSE_TOOL_NAME = "muse";

export type MuseExecutableSource =
  /** The pinned build in the machine tools cache. */
  | "tools-cache"
  /** `ADE_MUSE_EXECUTABLE`: a developer pointing ADE at a specific build (dev runs only). */
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
  /**
   * True while the pinned build is supported here but not downloaded yet (the
   * fetch has not run or is still running), so a caller can say "still
   * downloading" instead of "missing". False for an override, a found build,
   * and an unsupported host.
   */
  fetchPending: boolean;
  /**
   * True when `path` is the previous pinned build the cache keeps while the
   * current one downloads (just after an ADE update).
   */
  previous?: boolean;
  /**
   * Set when this is the newer, untested build ADE moved to because Meta's
   * channel published a floor above the pin (desktop `museFallForward.ts`).
   * Still ADE's own sha256-verified copy (`source` is `tools-cache`).
   */
  fallForward?: {
    pinnedVersion: string;
    overrideVersion: string;
    requiredVersion: string | null;
  };
};

export type MuseResolveOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
};

export type EnsureMuseOptions = MuseResolveOptions & {
  onProgress?: (progress: ToolProgress) => void;
};

/**
 * The variables the dev scripts set for a developer's run. `ADE_MUSE_EXECUTABLE`
 * (and the desktop's `ADE_MUSE_PROVIDER`) are honored only when one of these is
 * present, so a packaged app never honors them. These are plain environment
 * variables, not a security boundary: a shell that sets one can still point ADE
 * at a build. `ADE_DEV_RUNTIME_SOCKET_PATH` is what `scripts/dev-shared.mjs`
 * exports to the dev brain, and the desktop dev run reads it the same way
 * (`desktopUserDataPath.ts`).
 */
const DEV_RUN_MARKERS = ["ADE_DEV_RUNTIME_SOCKET_PATH", "VITE_DEV_SERVER_URL"] as const;

export function isDevRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return DEV_RUN_MARKERS.some((key) => Boolean(env[key]?.trim()));
}

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
function pinnedMuseVersion(options: MuseResolveOptions = {}): string | null {
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
  if (override && isDevRun(env)) {
    return isExecutableFile(override, platform)
      ? { path: override, source: "env-override", pinnedVersion, fetchPending: false }
      : { path: null, source: "missing", pinnedVersion, fetchPending: false };
  }

  if (!pinnedVersion) return { path: null, source: "unsupported", pinnedVersion: null, fetchPending: false };

  const cacheContext = { env, platform, arch: options.arch };
  // Meta's floor moved past the pin and ADE switched to a newer pairing build;
  // only while that pin is still the manifest's and the build is installed.
  const forced = resolveActiveToolVersionOverride(MUSE_TOOL_NAME, cacheContext);
  if (forced && isExecutableFile(forced.resolution.entryPath, platform)) {
    return {
      path: forced.resolution.entryPath,
      source: "tools-cache",
      pinnedVersion,
      fetchPending: false,
      fallForward: {
        pinnedVersion: forced.override.pinnedVersion,
        overrideVersion: forced.override.overrideVersion,
        requiredVersion: forced.override.requiredVersion,
      },
    };
  }
  const cached = cachedToolEntryPath(MUSE_TOOL_NAME, cacheContext);
  if (cached && isExecutableFile(cached, platform)) {
    return { path: cached, source: "tools-cache", pinnedVersion, fetchPending: false };
  }
  // Just after an ADE update the new pin can still be downloading; ADE's
  // previous build, which the cache keeps for this, runs meanwhile.
  const previous = previousCachedToolEntryPath(MUSE_TOOL_NAME, cacheContext);
  if (previous && isExecutableFile(previous, platform)) {
    return {
      path: previous,
      source: "tools-cache",
      pinnedVersion,
      fetchPending: pinnedToolFetchPending(MUSE_TOOL_NAME, cacheContext),
      previous: true,
    };
  }
  return {
    path: null,
    source: "missing",
    pinnedVersion,
    fetchPending: pinnedToolFetchPending(MUSE_TOOL_NAME, { env, platform, arch: options.arch }),
  };
}

let inFlightEnsure: Promise<string> | null = null;
const progressListeners = new Set<(progress: ToolProgress) => void>();
let fetchProgress: { receivedBytes: number | null; totalBytes: number | null } | null = null;
let lastFetchError: { kind: string; message: string } | null = null;

/** The kind a failed fetch reports. Tool errors carry their own; raw fs errors are classified here. */
function fetchErrorKind(error: unknown): ToolErrorKind {
  if (isToolError(error)) return error.kind;
  return (error as NodeJS.ErrnoException | null)?.code === "ENOSPC" ? "disk-space" : "filesystem";
}

/**
 * Return the pinned binary's path, fetching it first when it is missing.
 *
 * Concurrent callers in this process share one fetch and all see its
 * progress; other processes (the brain, another ADE channel) are serialized
 * by the tools cache's own lock. Throws the tools cache's `ToolError` (kinds
 * `unsupported-target`, `network`, `integrity`, `disk-space`, `lock-timeout`,
 * `filesystem`, `extract`) on failure.
 */
export async function ensureMuseBinary(options: EnsureMuseOptions = {}): Promise<string> {
  const existing = resolveMuseExecutable(options);
  if (existing.path && !existing.previous) return existing.path;
  // The previous build runs now; the current pin downloads behind it, and its
  // failure is recorded for getMuseBinaryStatus like any other.
  if (existing.path) {
    void fetchCurrentMuse(options).catch(() => undefined);
    return existing.path;
  }
  return await fetchCurrentMuse(options);
}

/** Download the current pin (joining a running download) and return its path. */
async function fetchCurrentMuse(options: EnsureMuseOptions): Promise<string> {
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
          if (!entry) {
            throw new ToolError("The Muse binary fetch finished without a binary.", {
              kind: "extract",
              tool: MUSE_TOOL_NAME,
            });
          }
          return entry;
        })
        .catch((error: unknown) => {
          lastFetchError = {
            kind: fetchErrorKind(error),
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
