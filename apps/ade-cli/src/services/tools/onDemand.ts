import { pinnedToolFetchPending } from "./cacheLookup";
import { asToolError, type ToolError, type ToolErrorKind } from "./errors";
import type { ToolProgress, ToolsContext } from "./install";
import { findToolPin, loadToolsManifest } from "./manifest";

/**
 * Download a pinned tool the moment something needs it.
 *
 * Launch and `ade serve` fetch only the tools this machine shows signs of using
 * (`agentToolDemand.ts`), so a chat, a one-shot task or a status refresh can
 * meet a tool that is pinned and simply not downloaded yet. Those callers await
 * `pinnedToolDownload` before they resolve the binary, and the resolver then
 * finds the fresh copy. Muse keeps its own `ensureMuseBinary`, which predates this.
 *
 * Off until a process turns it on (`enablePinnedToolFetch`), so a test never
 * starts a 100-450 MB download. A source checkout turns it on for the tools
 * that exist only as a download (`downloadOnly`): the lockfile-pinned ones
 * (codex, claude-code, opencode, copilot) resolve from the repo's
 * `node_modules` and are never fetched there.
 *
 * One fetch per tool per process; other processes are serialized by the tools
 * cache's own lock. Never throws: a failed download leaves resolution exactly
 * where it was (ADE's previous copy, or missing), and the failure's kind is
 * kept for `getPinnedToolStatus` to report.
 */

type FetchLogger = {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
};

let fetchEnabled = false;
/** Source checkout: fetch only tools with no `node_modules` copy (`ToolPin.checkoutCopy`). */
let fetchDownloadOnly = false;
let fetchLogger: FetchLogger | null = null;
let installGeneration = 0;
const inFlight = new Map<string, Promise<ToolError | null>>();
/** When each tool's last on-demand download failed; an offline machine must not retry on every status refresh. */
const lastFailureAt = new Map<string, number>();
const FAILED_FETCH_BACKOFF_MS = 2 * 60_000;
/** The last tracked download of each tool that failed, until one succeeds. */
const lastFailure = new Map<string, { kind: ToolErrorKind; message: string }>();
/** Bytes so far of each tracked download that reports progress. */
const progressByTool = new Map<string, { receivedBytes: number | null; totalBytes: number | null }>();

export function enablePinnedToolFetch(logger: FetchLogger, options: { downloadOnly?: boolean } = {}): void {
  fetchEnabled = true;
  fetchDownloadOnly = options.downloadOnly === true;
  fetchLogger = logger;
}

/** Log cache bookkeeping failures through the logger installed for tool fetches. */
export function warnPinnedToolFetch(event: string, fields: Record<string, unknown>): void {
  fetchLogger?.warn(event, fields);
}

/** False when downloads are off here, or this is a checkout and the tool lives in its node_modules. */
export function pinnedToolFetchAllowed(name: string, context: ToolsContext = {}): boolean {
  const env = context.env ?? process.env;
  if (!fetchEnabled || env.ADE_DISABLE_TOOLS_FETCH === "1") return false;
  if (!fetchDownloadOnly) return true;
  try {
    return findToolPin(context.manifest ?? loadToolsManifest(), name).checkoutCopy !== true;
  } catch {
    return false;
  }
}

/** The last failed download of `name` in this process, cleared by the next success. */
export function pinnedToolLastFailure(name: string): { kind: ToolErrorKind; message: string } | null {
  return lastFailure.get(name) ?? null;
}

/** Bytes received of the running download of `name`, when it reports progress. */
export function pinnedToolFetchProgress(name: string): { receivedBytes: number | null; totalBytes: number | null } | null {
  return inFlight.has(name) ? progressByTool.get(name) ?? { receivedBytes: null, totalBytes: null } : null;
}

/**
 * Record progress of a tracked download, so a status read can show it. Every
 * runner of `trackPinnedToolFetch` passes its `ensureTools` progress here.
 */
export function notePinnedToolProgress(progress: ToolProgress): void {
  if (!inFlight.has(progress.tool) || progress.phase !== "downloading") return;
  progressByTool.set(progress.tool, {
    receivedBytes: progress.receivedBytes ?? null,
    totalBytes: progress.totalBytes ?? null,
  });
}

/** Bumped by every tracked download that lands, so a cached "not detected" status knows it is stale. */
export function pinnedToolInstallGeneration(): number {
  return installGeneration;
}

export function pinnedToolFetchInFlight(name: string): boolean {
  return inFlight.has(name);
}

/**
 * True when this process would download `name` now: enabled, pinned for this
 * host, missing, and not failed in the last couple of minutes (the caller then
 * falls back to ADE's previous copy or the machine's CLI, as on any failure).
 */
export function pinnedToolNeedsFetch(name: string, context: ToolsContext = {}): boolean {
  if (!pinnedToolFetchAllowed(name, context)) return false;
  const failedAt = lastFailureAt.get(name);
  if (failedAt !== undefined && Date.now() - failedAt < FAILED_FETCH_BACKOFF_MS) return false;
  return pinnedToolFetchPending(name, context);
}

/**
 * Run one fetch of `name` as the process's only fetch of it: a caller that asks
 * while it runs joins it, a status read sees it in flight, and a success bumps
 * the install generation. The launch and `ade serve` passes run their own
 * `ensureTools` through this, so an on-demand caller never queues a second
 * install behind theirs. Resolves to the failure, or null.
 */
export function trackPinnedToolFetch(name: string, run: () => Promise<unknown>): Promise<ToolError | null> {
  const running = inFlight.get(name);
  if (running) return running;
  let settle!: (error: ToolError | null) => void;
  const fetch = new Promise<ToolError | null>((resolve) => {
    settle = resolve;
  });
  // Registered before `run` starts, so even a synchronous throw from it clears
  // the entry it made; `run` itself still starts in this tick.
  inFlight.set(name, fetch);
  void (async () => {
    try {
      await run();
      installGeneration += 1;
      lastFailure.delete(name);
      settle(null);
    } catch (error) {
      const failure = asToolError(error, { kind: "filesystem", tool: name });
      lastFailure.set(name, { kind: failure.kind, message: failure.message });
      settle(failure);
    } finally {
      inFlight.delete(name);
      progressByTool.delete(name);
    }
  })();
  return fetch;
}

/**
 * The download of `name` when it is pinned and missing (joining one already
 * running), or null when there is nothing to fetch. Synchronous on purpose: a
 * caller writes `const pending = pinnedToolDownload(x); if (pending) await pending;`
 * so a tool that is already on disk adds no await before its spawn.
 */
export function pinnedToolDownload(name: string, context: ToolsContext = {}): Promise<ToolError | null> | null {
  const running = inFlight.get(name);
  if (running) return running;
  if (!pinnedToolNeedsFetch(name, context)) return null;
  return startTrackedDownload(name, context);
}

/**
 * An explicit Download/Retry from the user: like `pinnedToolDownload`, but
 * not held back by a recent failure. Still null when downloads are off here,
 * the host has no pin, or the tool is already on disk.
 */
export function retryPinnedToolDownload(name: string, context: ToolsContext = {}): Promise<ToolError | null> | null {
  const running = inFlight.get(name);
  if (running) return running;
  if (!pinnedToolFetchAllowed(name, context) || !pinnedToolFetchPending(name, context)) return null;
  lastFailureAt.delete(name);
  return startTrackedDownload(name, context);
}

function startTrackedDownload(name: string, context: ToolsContext): Promise<ToolError | null> {
  fetchLogger?.info("tools.on_demand_fetch_started", { tool: name });
  return trackPinnedToolFetch(name, async () => {
    // Deep import, lazily: the resolvers reach this module on every spawn,
    // and only a real miss should load the download stack.
    const { ensureTools } = await import("./install");
    await ensureTools([name], { ...context, onProgress: notePinnedToolProgress });
  }).then((error) => {
    if (error) {
      lastFailureAt.set(name, Date.now());
      // The typed kind is the diagnosis; the message can carry local paths.
      fetchLogger?.warn("tools.on_demand_fetch_failed", { tool: name, kind: error.kind });
    } else {
      lastFailureAt.delete(name);
      fetchLogger?.info("tools.on_demand_fetch_complete", { tool: name });
    }
    return error;
  });
}
