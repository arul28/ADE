import { pinnedToolFetchPending } from "./cacheLookup";
import { asToolError, type ToolError } from "./errors";
import type { ToolsContext } from "./install";

/**
 * Download a pinned tool the moment something needs it.
 *
 * Launch and `ade serve` fetch only the tools this machine shows signs of using
 * (`agentToolDemand.ts`), so a chat, a one-shot task or a status refresh can
 * meet a tool that is pinned and simply not downloaded yet. Those callers await
 * `pinnedToolDownload` before they resolve the binary, and the resolver then
 * finds the fresh copy. Muse keeps its own `ensureMuseBinary`, which predates this.
 *
 * Off until a packaged process turns it on (`enablePinnedToolFetch`): a source
 * checkout resolves every tool from the repo's `node_modules`, and a dev loop
 * or a test must never start a 100-450 MB download.
 *
 * One fetch per tool per process; other processes are serialized by the tools
 * cache's own lock. Never throws: a failed download leaves resolution exactly
 * where it was (ADE's previous copy, then the machine's own CLI), so the caller
 * fails the way it always did rather than on a new error path.
 */

type FetchLogger = {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
};

let fetchEnabled = false;
let fetchLogger: FetchLogger | null = null;
let installGeneration = 0;
const inFlight = new Map<string, Promise<ToolError | null>>();
/** When each tool's last on-demand download failed; an offline machine must not retry on every status refresh. */
const lastFailureAt = new Map<string, number>();
const FAILED_FETCH_BACKOFF_MS = 2 * 60_000;

export function enablePinnedToolFetch(logger: FetchLogger): void {
  fetchEnabled = true;
  fetchLogger = logger;
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
  const env = context.env ?? process.env;
  if (!fetchEnabled || env.ADE_DISABLE_TOOLS_FETCH === "1") return false;
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
      settle(null);
    } catch (error) {
      settle(asToolError(error, { kind: "filesystem", tool: name }));
    } finally {
      inFlight.delete(name);
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
  fetchLogger?.info("tools.on_demand_fetch_started", { tool: name });
  return trackPinnedToolFetch(name, async () => {
    // Deep import, lazily: the resolvers reach this module on every spawn,
    // and only a real miss should load the download stack.
    const { ensureTools } = await import("./install");
    await ensureTools([name], context);
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
