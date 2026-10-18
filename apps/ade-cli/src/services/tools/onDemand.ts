import { pinnedToolFetchPending } from "./cacheLookup";
import { asToolError, type ToolError } from "./errors";
import type { ToolsContext } from "./install";

/**
 * Download a pinned tool the moment something needs it.
 *
 * Launch and `ade serve` fetch only the tools this machine shows signs of using
 * (`agentToolDemand.ts`), so a chat, a one-shot task or a status refresh can
 * meet a tool that is pinned and simply not downloaded yet. Those callers await
 * `ensurePinnedTool` before they resolve the binary, and the resolver then finds
 * the fresh copy. Muse keeps its own `ensureMuseBinary`, which predates this.
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

let fetchEnabled = false;
let installGeneration = 0;
const inFlight = new Map<string, Promise<ToolError | null>>();

export function enablePinnedToolFetch(): void {
  fetchEnabled = true;
}

/** Bumped by every on-demand download that lands, so a cached "not detected" status knows it is stale. */
export function pinnedToolInstallGeneration(): number {
  return installGeneration;
}

export function pinnedToolFetchInFlight(name: string): boolean {
  return inFlight.has(name);
}

/** True when this process would download `name` now: enabled, pinned for this host, and missing. */
export function pinnedToolNeedsFetch(name: string, context: ToolsContext = {}): boolean {
  const env = context.env ?? process.env;
  if (!fetchEnabled || env.ADE_DISABLE_TOOLS_FETCH === "1") return false;
  return pinnedToolFetchPending(name, context);
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
  const fetch = (async (): Promise<ToolError | null> => {
    try {
      // Deep import, lazily: the resolvers reach this module on every spawn,
      // and only a real miss should load the download stack.
      const { ensureTools } = await import("./install");
      await ensureTools([name], context);
      installGeneration += 1;
      return null;
    } catch (error) {
      return asToolError(error, { kind: "filesystem", tool: name });
    } finally {
      inFlight.delete(name);
    }
  })();
  inFlight.set(name, fetch);
  return fetch;
}

/** Await the download of `name` when it is pinned and missing. Resolves to the failure, or null. */
export async function ensurePinnedTool(name: string, context: ToolsContext = {}): Promise<ToolError | null> {
  return (await pinnedToolDownload(name, context)) ?? null;
}

/** Start the download of `name` when it is pinned and missing, without waiting for it. */
export function startPinnedToolFetch(name: string, context: ToolsContext = {}): boolean {
  return pinnedToolDownload(name, context) != null;
}
