import { isToolError } from "./errors";
import { type ToolResolution, type ToolsContext, resolveTool, tryResolveTool } from "./install";

/**
 * The one place the pinned tools cache is consulted by an executable resolver.
 *
 * Every agent-tool resolver (`codexExecutable.ts`, `claudeCodeExecutable.ts`,
 * `openCodeBinaryManager.ts`) calls this before its bundled-`node_modules`
 * probe, so the cache-first order is defined once and cannot drift between the
 * desktop main process and the brain. Those resolvers are the only resolution
 * path either process has — `apps/ade-cli` imports them across packages rather
 * than keeping copies — so wiring them here covers every spawn site.
 *
 * Never throws. A miss must degrade to the bundled copy rather than break agent
 * spawning, and there are two routine misses:
 *
 *   - `not-installed`  — the normal dev-machine and pre-fetch state.
 *   - `unsupported-target` — the manifest pins five targets, but the bundled
 *     platform-package maps also cover win32-arm64. On that host there is no
 *     pin to resolve and the bundled copy is the only answer.
 */
export function lookupCachedTool(name: string, context: ToolsContext = {}): ToolResolution | null {
  try {
    return tryResolveTool(name, context);
  } catch (error) {
    if (isToolError(error)) return null;
    throw error;
  }
}

/** `entryPath` of a cached tool, or null. The shape most resolvers want. */
export function cachedToolEntryPath(name: string, context: ToolsContext = {}): string | null {
  return lookupCachedTool(name, context)?.entryPath ?? null;
}

/**
 * True when this build pins `name` for the current host target and the tool is
 * not on disk yet — i.e. the background fetch either has not run or is still
 * running, and a spawn failure right now says "not downloaded yet", not
 * "broken install".
 *
 * The distinction matters because a cold cache is the *normal* first-run state:
 * without it a first launch surfaces the runtime's own raw "not found" as if
 * something were wrong. Callers use this to reword that message, never to
 * change resolution — a miss still falls through to the bundled copy.
 *
 * Expressed through `resolveTool` on purpose: it is already the one place that
 * composes `detectToolTarget` + `findToolPin` + `findToolTargetPin` + the
 * install sentinel, and its `not-installed` kind is exactly this predicate.
 * Re-deriving it here would be a second copy of that logic, free to drift.
 *
 * Never throws. A host with no pinned build (`unsupported-target`) and a
 * malformed manifest both answer false: nothing is pending because nothing
 * will ever be fetched.
 */
export function pinnedToolFetchPending(name: string, context: ToolsContext = {}): boolean {
  try {
    resolveTool(name, context);
    return false;
  } catch (error) {
    return isToolError(error) && error.kind === "not-installed";
  }
}
