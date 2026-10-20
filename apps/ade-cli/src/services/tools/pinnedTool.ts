/**
 * What every provider resolver, terminal launcher and status row asks the
 * tools cache: where is ADE's own copy of this tool, and if there is none, why.
 *
 * Electron-free and network-free; the desktop main process and the brain both
 * import it. It answers for the tools cache only. A provider resolver keeps its
 * own dev/test env override first and, in a source checkout, the repo's
 * `node_modules` copy between the current and the previous pin (policy order:
 * env override -> current pin -> checkout copy -> previous pin -> missing).
 *
 *   const tool = resolvePinnedTool("devin");            // current pin, else previous, else null
 *   const status = getPinnedToolStatus("devin");        // what a status row shows
 *   const pending = pinnedToolDownload("devin");         // start or join the download (onDemand.ts)
 *   if (pending) await pending;
 */
import { isToolError, type ToolErrorKind } from "./errors";
import { type ToolResolution, type ToolsContext, tryResolvePreviousTool, tryResolveTool } from "./install";
import { findToolTargetPin, loadToolsManifest } from "./manifest";
import {
  pinnedToolFetchAllowed,
  pinnedToolFetchInFlight,
  pinnedToolFetchProgress,
  pinnedToolLastFailure,
} from "./onDemand";
import { detectToolTarget } from "./paths";

export type PinnedToolResolution = ToolResolution & {
  /** True when this is the previous pin GC kept, run while the current one downloads. */
  previous: boolean;
};

export type PinnedToolState =
  /** ADE's copy is on disk: the current pin, or the previous one while the current downloads. */
  | "ready"
  /** No copy on disk and a download of the current pin is running in this process. */
  | "downloading"
  /** No copy on disk and the last download in this process failed (`errorKind`). */
  | "failed"
  /** This machine has no pinned build (platform/arch), or the tool is not pinned at all. */
  | "unavailable"
  /** Pinned and supported but not on disk, and nothing is downloading. */
  | "missing";

export type PinnedToolStatus = {
  tool: string;
  state: PinnedToolState;
  /** The version this build pins for the host; null when `unavailable`. */
  version: string | null;
  /** The version a `ready` tool runs: `version`, or the previous pin's. Null otherwise. */
  runningVersion: string | null;
  /** Absolute entry path when `ready`. */
  entryPath: string | null;
  /** Absolute paths of the entry's named files when `ready` (`harness`, `script`, `module`). */
  files: Record<string, string>;
  /** True while a download of the current pin runs, including under a `ready` previous pin. */
  downloading: boolean;
  /** Bytes so far of that download, when it reports them. */
  receivedBytes: number | null;
  totalBytes: number | null;
  /** The typed failure of the last download (`failed`), or why it is `unavailable`. */
  errorKind: ToolErrorKind | null;
  error: string | null;
  /**
   * Whether this process would download the tool when asked: false in a test,
   * with `ADE_DISABLE_TOOLS_FETCH=1`, or in a source checkout for a tool that
   * lives in its `node_modules`.
   */
  fetchAllowed: boolean;
};

function pinnedVersion(name: string, context: ToolsContext): { version: string } | { errorKind: ToolErrorKind; error: string } {
  try {
    const target = context.target ?? detectToolTarget(context.platform ?? process.platform, context.arch);
    return { version: findToolTargetPin(context.manifest ?? loadToolsManifest(), name, target).version };
  } catch (error) {
    return {
      errorKind: isToolError(error) ? error.kind : "manifest",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function tryResolve(resolve: () => ToolResolution | null): ToolResolution | null {
  try {
    return resolve();
  } catch (error) {
    if (isToolError(error)) return null;
    throw error;
  }
}

/** The current pin when it is on disk. Never throws, never touches the network. */
export function resolveCurrentPinnedTool(name: string, context: ToolsContext = {}): ToolResolution | null {
  return tryResolve(() => tryResolveTool(name, context));
}

/** The previous pin GC kept, when it is a finished install. Never throws. */
export function resolvePreviousPinnedTool(name: string, context: ToolsContext = {}): ToolResolution | null {
  return tryResolve(() => tryResolvePreviousTool(name, context));
}

/**
 * ADE's copy of `name` on this machine: the current pin, else the previous
 * pin, else null. A resolver with a checkout copy to try in between calls the
 * two halves above instead.
 */
export function resolvePinnedTool(name: string, context: ToolsContext = {}): PinnedToolResolution | null {
  const current = resolveCurrentPinnedTool(name, context);
  if (current) return { ...current, previous: false };
  const previous = resolvePreviousPinnedTool(name, context);
  return previous ? { ...previous, previous: true } : null;
}

/** Where the tool stands on this machine, for a status row or a blocker. No spawn, no network. */
export function getPinnedToolStatus(name: string, context: ToolsContext = {}): PinnedToolStatus {
  const base: PinnedToolStatus = {
    tool: name,
    state: "missing",
    version: null,
    runningVersion: null,
    entryPath: null,
    files: {},
    downloading: false,
    receivedBytes: null,
    totalBytes: null,
    errorKind: null,
    error: null,
    fetchAllowed: false,
  };
  const pinned = pinnedVersion(name, context);
  if ("errorKind" in pinned) return { ...base, state: "unavailable", errorKind: pinned.errorKind, error: pinned.error };

  const downloading = pinnedToolFetchInFlight(name);
  const progress = pinnedToolFetchProgress(name);
  const withPin: PinnedToolStatus = {
    ...base,
    version: pinned.version,
    downloading,
    receivedBytes: progress?.receivedBytes ?? null,
    totalBytes: progress?.totalBytes ?? null,
    fetchAllowed: pinnedToolFetchAllowed(name, context),
  };
  const resolved = resolvePinnedTool(name, context);
  if (resolved) {
    return { ...withPin, state: "ready", runningVersion: resolved.version, entryPath: resolved.entryPath, files: resolved.files };
  }
  if (downloading) return { ...withPin, state: "downloading" };
  const failure = pinnedToolLastFailure(name);
  if (failure) return { ...withPin, state: "failed", errorKind: failure.kind, error: failure.message };
  return withPin;
}
